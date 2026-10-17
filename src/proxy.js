// One request in, one finished answer out. Talks to OpenAI's public Responses API with the plan token.
// Preview rules (OpenAI's page): store:false and stream:true on every call, wait for response.completed, and none of
// max_output_tokens, temperature, previous_response_id or background. Effort and web search are tried and, if the
// service refuses them, retried once without and reported plainly (never silently).
import { NeedsSignin } from "./token.js";
import { tierOf } from "./models.js";

const ALLOWED = ["input", "instructions", "reasoning", "tools", "tool_choice", "text", "parallel_tool_calls", "metadata"];
const BANNED_EFFORT = new Set(["fast", "minimal", "none"]); // rule 9.0f: never fast; low only for top-tier models
const ABOVE_HIGH = new Set(["xhigh", "max"]); // above High needs Kyle (Project Instructions point 4)
export class GatewayError extends Error {
  constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; this.extra = extra; }
}

export function checkEffort(effort, model, cfg, topId = null) {
  if (effort === undefined) return "medium";
  if (BANNED_EFFORT.has(effort)) throw new GatewayError(400, "effort_not_allowed", `effort "${effort}" is not allowed (never fast; medium or high by default)`);
  if (effort === "low" && !(model === topId || tierOf(model) === cfg.tierOrder[cfg.tierOrder.length - 1])) throw new GatewayError(400, "effort_not_allowed", 'effort "low" is only for top-tier models; use medium or high');
  if (ABOVE_HIGH.has(effort) && !cfg.allowAboveHigh) throw new GatewayError(400, "effort_needs_approval", `effort "${effort}" is above High and needs Kyle's approval for this task`);
  return effort;
}

function sanitize(body, cfg, model, topId = null) {
  const dropped = [];
  const out = {};
  for (const k of Object.keys(body)) {
    if (k === "model") continue;
    if (ALLOWED.includes(k)) out[k] = body[k]; else dropped.push(k);
  }
  if (out.input === undefined) throw new GatewayError(400, "bad_request", "input is required");
  // The plan route only accepts input as a list of message items; wrap plain text for callers.
  if (typeof out.input === "string") out.input = [{ role: "user", content: [{ type: "input_text", text: out.input }] }];
  const effort = checkEffort(out.reasoning?.effort, model, cfg, topId);
  out.reasoning = { ...(out.reasoning || {}), effort };
  out.model = model;
  out.store = false;
  out.stream = true;
  return { out, dropped, effort };
}

async function readSse(res, idleMs, onEvent) {
  const reader = res.body.getReader();
  const dec = new TextDecoder('utf-8', { fatal: true });
  let buf = "";
  const bad = (message) => new GatewayError(502, "upstream_corrupt_stream", message + "; no answer was accepted or retried");
  const frame = (raw) => {
    const data = raw.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
    if (!data || data === "[DONE]") return false;
    let ev; try { ev = JSON.parse(data); } catch { throw bad("OpenAI sent malformed event JSON"); }
    if (!ev || typeof ev !== 'object' || Array.isArray(ev)) throw bad("OpenAI sent an invalid event");
    return onEvent(ev) === "stop";
  };
  try {
    for (;;) {
      let timer;
      let chunk;
      try { chunk = await Promise.race([reader.read(), new Promise((_, rej) => { timer = setTimeout(() => rej(new GatewayError(504, "upstream_stalled", "no data from OpenAI for " + Math.round(idleMs / 1000) + "s")), idleMs); timer.unref?.(); })]); }
      finally { clearTimeout(timer); }
      if (chunk.done) {
        try { buf += dec.decode(); } catch { throw bad("OpenAI sent invalid UTF-8"); }
        if (buf) frame(buf);
        return;
      }
      try { buf += dec.decode(chunk.value, { stream: true }); } catch { throw bad("OpenAI sent invalid UTF-8"); }
      for (;;) {
        const m = /\r?\n\r?\n/.exec(buf); if (!m) break;
        const raw = buf.slice(0, m.index); buf = buf.slice(m.index + m[0].length);
        if (frame(raw)) return;
      }
    }
  } finally { try { await reader.cancel(); } catch {} }
}

const textOf = (resp) => (resp.output || []).flatMap((o) => (o.content || []).filter((c) => c.type === "output_text").map((c) => c.text)).join("");
// Evidence for the narrow finalized-stream fallback. Anything malformed or conflicting sets `bad`, which makes the fallback unavailable.
const isIdx = (n) => Number.isInteger(n) && n >= 0;
const isId = (s) => typeof s === "string" && s.length > 0;
function newProof() { return { bad: false, items: new Map(), deltas: new Map(), dones: new Map() }; }
function proofPart(p, map, ev, field) {
  if (!isIdx(ev.output_index) || !isIdx(ev.content_index) || !isId(ev.item_id) || typeof ev[field] !== "string") { p.bad = true; return; }
  const k = ev.output_index + ":" + ev.content_index;
  const cur = map.get(k);
  if (!cur) { map.set(k, { itemId: ev.item_id, text: ev[field] }); return; }
  if (cur.itemId !== ev.item_id) { p.bad = true; return; }
  if (map === p.deltas) cur.text += ev[field]; else if (cur.text !== ev[field]) p.bad = true;
}
function proofItem(p, ev) {
  const it = ev.item;
  if (!it || typeof it !== "object" || it.type !== "message") return; // only assistant messages count as answer evidence
  if (it.role !== "assistant" || it.status !== "completed" || !isId(it.id) || !isIdx(ev.output_index) || !Array.isArray(it.content)) { p.bad = true; return; }
  const parts = [];
  for (const c of it.content) {
    if (!c || c.type !== "output_text" || typeof c.text !== "string") { p.bad = true; return; }
    parts.push(c.text);
  }
  const cur = p.items.get(ev.output_index);
  if (!cur) { p.items.set(ev.output_index, { id: it.id, parts }); return; }
  if (cur.id !== it.id || cur.parts.length !== parts.length || cur.parts.some((t, i) => t !== parts[i])) p.bad = true;
}
// Returns the reconstructed text, or null when the stream does not fully prove it.
function provenText(p) {
  if (p.bad || !p.items.size) return null;
  const ids = new Set();
  for (const it of p.items.values()) { if (ids.has(it.id)) return null; ids.add(it.id); }
  const used = new Set();
  let text = "";
  for (const oi of [...p.items.keys()].sort((a, b) => a - b)) {
    const it = p.items.get(oi);
    for (let ci = 0; ci < it.parts.length; ci++) {
      const k = oi + ":" + ci;
      const d = p.dones.get(k);
      if (!d || d.itemId !== it.id || d.text !== it.parts[ci]) return null;
      const dl = p.deltas.get(k);
      if (dl && (dl.itemId !== it.id || dl.text !== it.parts[ci])) return null;
      used.add(k);
      text += it.parts[ci];
    }
  }
  for (const k of p.deltas.keys()) if (!used.has(k)) return null;
  for (const k of p.dones.keys()) if (!used.has(k)) return null;
  return text.trim() ? text : null;
}
const isParamReject =(status, text, word) => status === 400 && new RegExp(word, "i").test(text);

async function callOnce(ctx, token, payload) {
  // No answer-time limit: only silence (no headers, no body bytes) for idleTimeoutMs aborts the call.
  const ac = new AbortController();
  const idle = ctx.cfg.idleTimeoutMs;
  const stalled = () => new GatewayError(504, "upstream_stalled", "no data from OpenAI for " + Math.round(idle / 1000) + "s");
  const timer = setTimeout(() => ac.abort(), idle);
  let res;
  try {
    res = await ctx.fetchFn(ctx.cfg.apiBase + "/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
  } catch (e) {
    if (ac.signal.aborted) throw stalled();
    throw new GatewayError(502, "upstream_unreachable", "could not reach OpenAI: " + (e.cause?.code || e.message));
  } finally { clearTimeout(timer); }
  if (!res.ok) { const t = await res.text().catch(() => ""); return { http: res.status, text: t }; }
  let completed = null, failed = null, incomplete = null, streamed = "", completedExplicit = false;
  const shape = { d: 0, td: 0, ic: 0, it: 0 };
  const proof = newProof();
  await readSse(res, ctx.cfg.idleTimeoutMs, (ev) => {
    if (ev.type === "response.output_text.delta") { if (typeof ev.delta === "string") { streamed += ev.delta; shape.d += ev.delta.length; } proofPart(proof, proof.deltas, ev, "delta"); }
    if (ev.type === "response.output_text.done") { if (typeof ev.text === "string") shape.td += ev.text.length; proofPart(proof, proof.dones, ev, "text"); }
    if (ev.type === "response.output_item.done") { shape.ic++; proofItem(proof, ev); if (ev.item && Array.isArray(ev.item.content)) for (const c of ev.item.content) if (c && c.type === "output_text" && typeof c.text === "string") shape.it += c.text.length; }
    if (ev.type === "response.completed") {
      const r = ev.response;
      if (!r || typeof r !== "object" || Array.isArray(r) || typeof r.id !== "string" || !r.id || typeof r.model !== "string" || !r.model || !Array.isArray(r.output)) throw new GatewayError(502, "upstream_corrupt_stream", "OpenAI completion payload is missing or malformed; no answer was accepted or retried");
      for (const o of r.output) {
        if (!o || typeof o !== "object" || (o.content !== undefined && !Array.isArray(o.content))) throw new GatewayError(502, "upstream_corrupt_stream", "OpenAI completion output is malformed");
        for (const c of o.content || []) if (!c || typeof c !== "object" || (c.type === "output_text" && typeof c.text !== "string")) throw new GatewayError(502, "upstream_corrupt_stream", "OpenAI completion text is malformed");
      }
      // An EXPLICIT status other than "completed" is not a finished answer. A missing status inside a genuine completed event stays accepted (legacy shape).
      if (r.status !== undefined && r.status !== "completed") { incomplete = { status: String(r.status), reason: r.incomplete_details && r.incomplete_details.reason }; return "stop"; }
      completed = r; completedExplicit = r.status === "completed"; return "stop";
    }
    if (ev.type === "response.incomplete") { const r = ev.response || {}; incomplete = { status: String(r.status || "incomplete"), reason: r.incomplete_details && r.incomplete_details.reason }; return "stop"; }
    if (ev.type === "response.failed") { failed = (ev.response && ev.response.error) || ev.error || { code: "unknown" }; return "stop"; }
    if (ev.type === "error") { failed = ev.error || ev; return "stop"; }
  });
  if (failed) return { failed };
  if (incomplete) return { incomplete };
  if (!completed) return { http: 502, text: "stream ended before response.completed" };
  const finalized = completedExplicit && completed.output.length === 0 ? provenText(proof) : null;
  return { completed, streamed, shape, finalized };
}

export async function respond(ctx, body) {
  const { cfg, tokens, picker } = ctx;
  const model = body.model === "auto-top" ? picker.top() : body.model && body.model !== "auto" ? body.model : picker.current();
  if (!model) throw new GatewayError(503, "no_model", "no model picked yet; the daily model check has not run");
  const { out, dropped, effort } = sanitize(body, cfg, model, picker.top());
  const notes = { model, plan_lane: true, effort_requested: effort, effort_applied: true, web_search_applied: !!(out.tools || []).some((t) => /web_search/.test(t.type || "")), retries: [], dropped };

  let token = await tokens.getAccessToken();
  let payload = out;
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await callOnce(ctx, token, payload);
    if (r.completed) {
      let text = textOf(r.completed);
      notes.response_text_source = "completed_output";
      if (!text.trim() && r.finalized) { text = r.finalized; notes.response_text_source = "finalized_stream_items"; }
      if (!text.trim()) {
        delete notes.response_text_source;
        const shape = { ...r.shape, oi: r.completed.output.length, ot: text.length, tt: typeof r.completed.output_text === "string" ? r.completed.output_text.length : 0 };
        throw new GatewayError(502, "upstream_empty_text", "Completed response has no terminal text; shape=" + JSON.stringify(shape) + "; no answer accepted or retried");
      }
      return { status: 200, json: { id: r.completed.id || null, model: r.completed.model || model, status: "completed", output_text: text, usage: r.completed.usage || null, gateway: notes } };
    }
    if (r.incomplete) {
      // Partial output is never returned as an answer and never retried automatically (a retry would spend again).
      const why = r.incomplete.reason ? " (" + String(r.incomplete.reason).slice(0, 60) + ")" : "";
      throw new GatewayError(502, "upstream_incomplete", "OpenAI ended the response as " + r.incomplete.status + why + "; no answer was accepted and it was not retried", { upstream_status: r.incomplete.status, gateway: notes });
    }
    if (r.failed) {
      const code = String(r.failed.code || r.failed.type || "");
      if (/subscription_sharing_usage_limit_exceeded|subscription_sharing_usage_unavailable/.test(code)) {
        throw new GatewayError(429, "plan_limit", "ChatGPT plan allowance for this app is used up or unavailable", { upstream_code: code, gateway: notes });
      }
      throw new GatewayError(502, "upstream_failed", r.failed.message || code || "response.failed", { upstream_code: code, gateway: notes });
    }
    if (r.http === 401) {
      if (notes.retries.includes("refresh_after_401")) throw new NeedsSignin("OpenAI rejected the token after a refresh");
      notes.retries.push("refresh_after_401");
      token = (await tokens.refresh({ staleToken: token })).access_token;
      continue;
    }
    if (isParamReject(r.http, r.text, "reasoning|effort") && notes.effort_applied) {
      notes.effort_applied = false; notes.retries.push("without_effort");
      const { reasoning, ...rest } = payload; payload = rest; continue;
    }
    if (isParamReject(r.http, r.text, "web_search|tools?") && notes.web_search_applied) {
      notes.web_search_applied = false; notes.retries.push("without_web_search");
      const { tools, tool_choice, ...rest } = payload; payload = rest; continue;
    }
    if (r.http === 429) throw new GatewayError(429, "rate_limited", "OpenAI rate limit", { gateway: notes });
    throw new GatewayError(r.http >= 500 ? 502 : 400, "upstream_http_" + r.http, String(r.text).slice(0, 300), { gateway: notes });
  }
  throw new GatewayError(502, "too_many_retries", "gave up after retries", { gateway: notes });
}
