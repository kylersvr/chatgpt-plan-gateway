import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFake } from "./fake-openai.js";
import { configFromEnv } from "../src/config.js";
import { runLogin } from "../src/auth.js";
import { TokenManager, NeedsSignin } from "../src/token.js";
import { eligible, topOf, standardOf, ModelPicker } from "../src/models.js";
import { createGateway } from "../src/server.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "gw-"));
const mkcfg = (fake, extra = {}) => ({ ...configFromEnv({ GATEWAY_DIR: tmp(), GATEWAY_AUTH_BASE: fake.url, GATEWAY_API_BASE: fake.url, GATEWAY_SECRET: "s3cret", GATEWAY_PORT: "0" }), idleTimeoutMs: 400, ...extra });
const signIn = async (cfg) => runLogin(cfg, { onUrl: (u) => { fetch(u).catch(() => {}); } }); // the pretend "browser" follows the redirect to the loopback callback
const fast = { sleep: () => Promise.resolve(), baseDelayMs: 1 };

test("sign-in: PKCE and state checked, id_token validated, POSIX file mode checked where supported", async (t) => {
  const fake = await startFake(); t.after(() => fake.close()); const cfg = mkcfg(fake);
  const r = await signIn(cfg);
  assert.equal(r.subject, "user-123");
  const auth = fake.st.calls.find((c) => c.path === "/api/accounts/authorize");
  assert.equal(auth.query.client_id, "dynamic_agent_client");
  assert.equal(JSON.parse(fs.readFileSync(cfg.credFile, "utf8")).client_id, "oaiapp_test123"); // the per-sign-in id from the callback is kept for refreshes
  assert.equal(auth.query.code_challenge_method, "S256");
  assert.match(auth.query.ext_agent_host_id, /^urn:uuid:/);
  assert.equal(auth.query.agent_name_hint, "Build OS");
  assert.equal(auth.query.resource, "https://api.openai.com/v1");
  assert.match(auth.query.redirect_uri, /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
  await t.test("credential file POSIX mode is owner-only", { skip: process.platform === "win32" }, () => {
    const mode = fs.statSync(cfg.credFile).mode & 0o777;
    assert.equal(mode, 0o600);
  });
  const creds = JSON.parse(fs.readFileSync(cfg.credFile, "utf8"));
  assert.ok(creds.refresh_token && creds.access_token);
  assert.equal(creds.id_token, undefined); // the id token is checked then dropped
});

test("sign-in: a wrong state is refused and saves nothing", async () => {
  const fake = await startFake(); const cfg = mkcfg(fake);
  await assert.rejects(runLogin(cfg, { onUrl: async (u) => { const r = await fetch(u, { redirect: "manual" }); const loc = new URL(r.headers.get("location")); loc.searchParams.set("state", "forged"); fetch(loc).catch(() => {}); } }), /state mismatch/);
  assert.equal(fs.existsSync(cfg.credFile), false);
  await fake.close();
});

test("tokens: ten callers during one refresh cause exactly one refresh, rotation saved together", async () => {
  const fake = await startFake({ lifetimeS: 60 }); const cfg = mkcfg(fake); await signIn(cfg);
  const tm = new TokenManager(cfg, fast);
  const before = fake.st.calls.filter((c) => c.path === "/api/accounts/oauth/token").length;
  const got = await Promise.all(Array.from({ length: 10 }, () => tm.getAccessToken()));
  const after = fake.st.calls.filter((c) => c.path === "/api/accounts/oauth/token").length;
  assert.equal(after - before, 1);
  assert.equal(new Set(got).size, 1);
  const creds = JSON.parse(fs.readFileSync(cfg.credFile, "utf8"));
  assert.equal(creds.access_token, got[0]);
  assert.equal(creds.refresh_token, "rt-2");
  await fake.close();
});

test("tokens: a hiccup (503) is retried; a refusal flips to needs_signin once and stops calling out", async () => {
  const fake = await startFake({ lifetimeS: 60 }); const cfg = mkcfg(fake); await signIn(cfg);
  const tm = new TokenManager(cfg, fast);
  fake.st.fail503Left = 2;
  assert.ok(await tm.getAccessToken());
  fake.st.refreshMode = "invalid_grant";
  await assert.rejects(tm.getAccessToken({ force: true }), NeedsSignin);
  assert.equal(tm.status().state, "needs_signin");
  const n = fake.st.calls.length;
  await assert.rejects(tm.getAccessToken(), NeedsSignin);
  assert.equal(fake.st.calls.length, n); // no further network calls while flagged
  fake.st.refreshMode = "ok";
  await fake.close();
});

test("tokens: signing in again clears needs_signin", async () => {
  const fake = await startFake({ lifetimeS: 60 }); const cfg = mkcfg(fake); await signIn(cfg);
  const tm = new TokenManager(cfg, fast);
  fake.st.refreshMode = "invalid_grant";
  await assert.rejects(tm.getAccessToken({ force: true }), NeedsSignin);
  fake.st.refreshMode = "ok";
  await signIn(cfg);
  assert.ok(await tm.getAccessToken());
  assert.equal(tm.status().state, "ok");
  await fake.close();
});

test("models: only Sol 6.1 or better and higher tiers; newest first; change recorded; pin respected", async () => {
  const cfg = configFromEnv({ GATEWAY_DIR: tmp() });
  const ids = eligible(["gpt-5.6-sol", "gpt-6-sol", "gpt-6.1-sol", "gpt-6.1-sol-mini", "gpt-6-astra", "gpt-6.2-sol", "gpt-6.1-sol-2026-10-01", "text-embedding-4"], cfg).map((m) => m.id);
  assert.deepEqual(ids, ["gpt-6.2-sol", "gpt-6.1-sol", "gpt-6.1-sol-2026-10-01", "gpt-6-astra"]);
  const fake = await startFake(); const c2 = mkcfg(fake); await signIn(c2);
  const tm = new TokenManager(c2, fast); const pk = new ModelPicker(c2);
  const r1 = await pk.refresh(await tm.getAccessToken());
  assert.deepEqual([r1.current, r1.changed], ["gpt-6.1-sol", true]);
  fake.st.models.push("gpt-6.2-sol");
  const r2 = await pk.refresh(await tm.getAccessToken());
  assert.deepEqual([r2.previous, r2.current, r2.changed], ["gpt-6.1-sol", "gpt-6.2-sol", true]);
  assert.equal(pk.state.history.length, 2);
  assert.equal(new ModelPicker({ ...c2, pinModel: "gpt-6-astra" }).current(), "gpt-6-astra");
  await fake.close();
});

async function up(extra = {}, fakeOpts = {}) {
  const fake = await startFake({ lifetimeS: 3600, ...fakeOpts });
  const cfg = mkcfg(fake, extra); await signIn(cfg);
  const gw = createGateway(cfg, fast); await gw.start();
  await gw.refreshModels();
  const base = "http://127.0.0.1:" + gw.server.address().port;
  const call = (p, body, headers = { authorization: "Bearer s3cret" }) => fetch(base + p, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { fake, cfg, gw, call, down: async () => { await gw.stop(); await fake.close(); } };
}

test("server: needs the secret; health shows state but no tokens", async () => {
  const t = await up();
  assert.equal((await t.call("/health", null, {})).status, 401);
  const h = await t.call("/health"); const txt = await h.text();
  assert.equal(h.status, 200);
  assert.ok(!/at-\d|rt-\d/.test(txt));
  assert.equal(JSON.parse(txt).model, "gpt-6.1-sol");
  await t.down();
});

test("server: refuses to listen beyond loopback without a secret", () => {
  assert.throws(() => createGateway({ ...configFromEnv({ GATEWAY_DIR: tmp() }), host: "0.0.0.0", secret: "" }), /GATEWAY_SECRET/);
});

test("responses: preview rules enforced upstream, banned fields dropped and reported, answer returned", async () => {
  const t = await up();
  const r = await t.call("/v1/responses", { input: "hi", temperature: 0.2, max_output_tokens: 50, previous_response_id: "x", background: true, reasoning: { effort: "high" } });
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.output_text, "Hello world");
  assert.equal(j.model, "gpt-6.1-sol");
  assert.deepEqual(j.gateway.dropped.sort(), ["background", "max_output_tokens", "previous_response_id", "temperature"]);
  const up1 = JSON.parse(t.fake.st.calls.filter((c) => c.path === "/v1/responses").at(-1).raw);
  assert.equal(up1.store, false); assert.equal(up1.stream, true);
  for (const k of ["temperature", "max_output_tokens", "previous_response_id", "background"]) assert.equal(up1[k], undefined);
  assert.equal(up1.reasoning.effort, "high");
  await t.down();
});

test("models: a new frontier family is picked once newer; top tier follows; small and non-chat models never", async () => {
  const cfg = configFromEnv({ GATEWAY_DIR: tmp() });
  const base = ["gpt-6.1-sol", "gpt-6-astra", "gpt-6.1-astra-mini", "gpt-7-nova-mini", "gpt-7-codex", "gpt-7-image", "gpt-4o"];
  assert.equal(eligible(base, cfg)[0].id, "gpt-6.1-sol");
  assert.equal(topOf(eligible(base, cfg), cfg), "gpt-6-astra");
  const more = [...base, "gpt-7-nova", "gpt-6.2-astra"];
  const el = eligible(more, cfg);
  assert.equal(el[0].id, "gpt-7-nova");
  assert.equal(topOf(el, cfg), "gpt-7-nova");
  assert.equal(topOf(eligible([...base, "gpt-6.2-astra"], cfg), cfg), "gpt-6.2-astra");
  // the everyday pick stays on the Sol line even when the top tier is newer; a new family above Sol becomes top, not everyday
  assert.equal(standardOf(eligible([...base, "gpt-6.2-astra"], cfg), cfg), "gpt-6.1-sol");
  assert.equal(standardOf(el, cfg), "gpt-6.1-sol");
  assert.ok(!el.find((m) => /mini|codex|image|4o/.test(m.id)));
});

test("effort floor: fast and minimal refused, low refused for Sol, allowed for Astra, above-high needs approval, default medium", async () => {
  const t = await up();
  for (const e of ["fast", "minimal", "low", "xhigh"]) assert.equal((await t.call("/v1/responses", { input: "x", reasoning: { effort: e } })).status, 400, e);
  assert.equal((await t.call("/v1/responses", { input: "x", model: "gpt-6-astra", reasoning: { effort: "low" } })).status, 200);
  await t.call("/v1/responses", { input: "x" });
  assert.equal(JSON.parse(t.fake.st.calls.filter((c) => c.path === "/v1/responses").at(-1).raw).reasoning.effort, "medium");
  await t.down();
});

test("plan limit: response.failed becomes a clear 429 plan_limit so the Bridge can fall back", async () => {
  const t = await up({}, { responsesMode: "usage_limit" });
  const r = await t.call("/v1/responses", { input: "x" }); const j = await r.json();
  assert.equal(r.status, 429); assert.equal(j.error.code, "plan_limit");
  assert.match(j.error.upstream_code, /usage_limit_exceeded/);
  await t.down();
});

test("refused effort or web search is retried once without it and reported, never hidden", async () => {
  let t = await up({}, { responsesMode: "effort_reject" });
  let j = await (await t.call("/v1/responses", { input: "x", reasoning: { effort: "high" } })).json();
  assert.equal(j.gateway.effort_applied, false); assert.deepEqual(j.gateway.retries, ["without_effort"]);
  await t.down();
  t = await up({}, { responsesMode: "search_reject" });
  j = await (await t.call("/v1/responses", { input: "x", tools: [{ type: "web_search" }] })).json();
  assert.equal(j.gateway.web_search_applied, false); assert.deepEqual(j.gateway.retries, ["without_web_search"]);
  await t.down();
});

test("a 401 mid-call refreshes once and retries; a refused sign-in answers 401 needs_signin", async () => {
  const t = await up({}, { once401: true });
  const r = await t.call("/v1/responses", { input: "x" }); const j = await r.json();
  assert.equal(r.status, 200); assert.deepEqual(j.gateway.retries, ["refresh_after_401"]);
  t.fake.st.refreshMode = "invalid_grant"; t.fake.st.once401 = true;
  const r2 = await t.call("/v1/responses", { input: "x" });
  assert.equal(r2.status, 401); assert.equal((await r2.json()).error.code, "needs_signin");
  await t.down();
});

test("a stalled stream is cut after the idle limit with a clear error", async () => {
  const t = await up({ idleTimeoutMs: 300 }, { responsesMode: "stall" });
  const r = await t.call("/v1/responses", { input: "x" });
  assert.equal(r.status, 504); assert.equal((await r.json()).error.code, "upstream_stalled");
  await t.down();
});

test("incomplete upstream output is never an accepted answer: EOF without terminal, response.incomplete, completed event with status incomplete, streamed error; no retry", async () => {
  const cases = [["eof_no_terminal", 502, "upstream_http_502"], ["incomplete_event", 502, "upstream_incomplete"], ["completed_event_incomplete_status", 502, "upstream_incomplete"], ["stream_error", 502, "upstream_failed"]];
  for (const [mode, status, code] of cases) {
    const t = await up({}, { responsesMode: mode });
    const r = await t.call("/v1/responses", { input: "x" }); const j = await r.json();
    assert.equal(r.status, status, mode); assert.equal(j.error.code, code, mode);
    assert.equal(j.output_text, undefined, mode);                                                   // no partial text handed out
    assert.equal(t.fake.st.calls.filter((c) => c.path === "/v1/responses").length, 1, mode + ": exactly one upstream call, no automatic retry");
    await t.down();
  }
  const t2 = await up({}, { responsesMode: "incomplete_event" });
  assert.match((await (await t2.call("/v1/responses", { input: "x" })).json()).error.message, /max_output_tokens/);
  await t2.down();
});

test("a genuine completed event keeps working: explicit status completed, and a legacy completed event with no status field", async () => {
  for (const mode of ["ok", "completed_no_status"]) {
    const t = await up({}, { responsesMode: mode });
    const r = await t.call("/v1/responses", { input: "x" }); const j = await r.json();
    assert.equal(r.status, 200, mode); assert.equal(j.status, "completed"); assert.equal(j.output_text, "Hello world");
    await t.down();
  }
});

// Synthetic text and the fake OpenAI only: no real model call. The 8 MiB body limit is transport, not model context capacity.
test("body limit is 8 MiB of actual bytes: the old 1 MB size now passes, the exact limit passes, one byte more is an explicit readable 413", async () => {
  const t = await up();
  const MAX = 8 * 1024 * 1024;
  const raw = (s) => fetch("http://127.0.0.1:" + t.gw.server.address().port + "/v1/responses", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer s3cret" }, body: s });
  assert.equal((await t.call("/v1/responses", { input: "a".repeat(1100 * 1024) })).status, 200);
  const frame = (n) => '{"input":"' + "a".repeat(n) + '"}';
  assert.equal(Buffer.byteLength(frame(MAX - 12)), MAX);
  assert.equal((await raw(frame(MAX - 12))).status, 200);
  const over = await raw(frame(MAX - 11));
  assert.equal(over.status, 413);
  assert.equal((await over.json()).error.code, "too_large");
  // multi-byte text is counted in bytes, not characters: 3-byte characters pass 1/3 as many characters
  const cjk = '{"input":"' + "日".repeat(Math.floor((MAX - 12) / 3) + 1) + '"}';
  assert.equal((await raw(cjk)).status, 413);
  // the gateway is still healthy afterwards, and invalid UTF-8 is an explicit 400
  assert.equal((await t.call("/health")).status, 200);
  const bad = await raw(new Uint8Array([0x7b, 0xff, 0x7d]));
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, "bad_utf8");
  await t.down();
});

// ---- headless sign-in (start, then paste the return address) ----
const browserLandsOn = async (url) => { const r = await fetch(url, { redirect: "manual" }); return r.headers.get("location"); }; // what a person copies from the error page

test("headless sign-in: start gives an address, pasting the return address finishes it, models refresh", async () => {
  const fake = await startFake(); const cfg = mkcfg(fake);
  const gw = createGateway(cfg, fast); await gw.start();
  const base = "http://127.0.0.1:" + gw.server.address().port;
  const call = (p, body) => fetch(base + p, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", authorization: "Bearer s3cret" }, body: body ? JSON.stringify(body) : undefined });
  assert.equal((await (await call("/admin/signin/status")).json()).state, "idle");
  const s = await (await call("/admin/signin/start", {})).json();
  assert.match(s.url, /\/api\/accounts\/authorize\?/);
  assert.equal((await (await call("/admin/signin/status")).json()).state, "waiting");
  const again = await (await call("/admin/signin/start", {})).json();
  assert.equal(again.url, s.url); assert.equal(again.reused, true);
  const landing = await browserLandsOn(s.url);
  const f = await call("/admin/signin/finish", { address: landing });
  assert.equal(f.status, 200);
  assert.equal((await (await call("/admin/signin/status")).json()).state, "signed_in");
  assert.ok(fs.existsSync(cfg.credFile));
  assert.equal(JSON.parse(fs.readFileSync(cfg.credFile, "utf8")).client_id, "oaiapp_test123");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(gw.picker.current(), "gpt-6.1-sol"); // models picked right after sign-in
  await gw.stop(); await fake.close();
});

test("headless sign-in: wrong address and finishing without starting are refused, nothing saved", async () => {
  const fake = await startFake(); const cfg = mkcfg(fake);
  const gw = createGateway(cfg, fast); await gw.start();
  const base = "http://127.0.0.1:" + gw.server.address().port;
  const call = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer s3cret" }, body: JSON.stringify(body) });
  assert.equal((await call("/admin/signin/finish", { address: "http://127.0.0.1:1/auth/callback?code=x" })).status, 409);
  const s = await (await call("/admin/signin/start", {})).json();
  assert.equal((await call("/admin/signin/finish", { address: "not a url" })).status, 400);
  assert.equal((await call("/admin/signin/finish", { address: "http://127.0.0.1:1/auth/callback?code=x&state=y" })).status, 400); // wrong port
  assert.equal((await call("/admin/signin/finish", { address: "https://evil.example/auth/callback?code=x" })).status, 400);
  const landing = await browserLandsOn(s.url);
  const forged = new URL(landing); forged.searchParams.set("state", "forged");
  const r = await call("/admin/signin/finish", { address: forged.toString() });
  assert.equal(r.status, 400); assert.equal(fs.existsSync(cfg.credFile), false);
  const st = await (await fetch(base + "/admin/signin/status", { headers: { authorization: "Bearer s3cret" } })).json();
  assert.equal(st.state, "failed"); // a failed attempt can be started again
  assert.equal((await call("/admin/signin/start", {})).status, 200);
  await gw.stop(); await fake.close();
});

test("corrupt UTF-8/JSON and malformed completed payloads fail without retry; decoder flush and final unterminated frame are handled", async () => {
  for (const mode of ["malformed_json","bad_utf8","truncated_utf8","missing_response","empty_response"]) {
    const t=await up({}, {responsesMode:mode});
    try { const r=await t.call("/v1/responses",{input:"x"}); const j=await r.json(); assert.equal(r.status,502,mode); assert.equal(j.error.code,"upstream_corrupt_stream",mode); assert.equal(j.output_text,undefined); assert.equal(t.fake.st.calls.filter(c=>c.path==="/v1/responses").length,1); }
    finally { await t.down(); }
  }
  for (const mode of ["unterminated_final","empty_final_output"]) {
    const t=await up({}, {responsesMode:mode});
    try { const r=await t.call("/v1/responses",{input:"x"}); const j=await r.json(); if (mode === "empty_final_output") { assert.equal(r.status,502); assert.equal(j.error.code,"upstream_empty_text"); } else { assert.equal(r.status,200); assert.equal(j.output_text,"Hello world"); } }
    finally { await t.down(); }
  }
});
