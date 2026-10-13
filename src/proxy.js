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
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise((_, rej) => setTimeout(() => rej(new GatewayError(504, "upstream_stalled", "no data from OpenAI for " + Math.round(idleMs / 1000) + "s")), idleMs).unref?.()),
    ]);
    if (chunk.done) break;
    buf += dec.decode(chunk.value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, i); buf = buf.slice(i + 2);
      const data = raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
      if (!data || data === "[DONE]") continue;
      let ev; try { ev = JSON.parse(data); } catch { continue; }
      if (onEvent(ev) === "stop") { try { await reader.cancel(); } catch { /* ignore */ } return; }
    }
  }
}

const textOf = (resp) => (resp.output || []).flatMap((o) => (o.content || []).filter((c) => c.type === "output_text").map((c) => c.text)).join("");
const isParamReject = (status, text, word) => status === 400 && new RegExp(word, "i").test(text);

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
  let completed = null, failed = null, streamed = "";
  await readSse(res, ctx.cfg.idleTimeoutMs, (ev) => {
    if (ev.type === "response.output_text.delta" && typeof ev.delta === "string") streamed += ev.delta;
    if (ev.type === "response.completed") { completed = ev.response || {}; return "stop"; }
    if (ev.type === "response.failed") { failed = (ev.response && ev.response.error) || ev.error || { code: "unknown" }; return "stop"; }
    if (ev.type === "error") { failed = ev.error || ev; return "stop"; }
  });
  if (failed) return { failed };
  if (!completed) return { http: 502, text: "stream ended before response.completed" };
  return { completed, streamed };
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
      return { status: 200, json: { id: r.completed.id || null, model: r.completed.model || model, status: "completed", output_text: textOf(r.completed) || r.streamed, usage: r.completed.usage || null, gateway: notes } };
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
