// Private HTTP endpoint for the Bridge. Shared-secret bearer, small bodies, no secrets or prompts in logs.
import http from "node:http";
import crypto from "node:crypto";
import { TokenManager, NeedsSignin } from "./token.js";
import { ModelPicker } from "./models.js";
import { respond, GatewayError } from "./proxy.js";
import { SigninManager, SigninError } from "./signin.js";

const MAX_BODY = 1024 * 1024;
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();

export function createGateway(cfg, { fetchFn = fetch, now, sleep } = {}) {
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(cfg.host);
  if (!cfg.secret && !loopback) throw new Error("GATEWAY_SECRET is required when listening beyond loopback");
  const tokens = new TokenManager(cfg, { fetchFn, now, sleep });
  const picker = new ModelPicker(cfg, { fetchFn, now });
  const ctx = { cfg, tokens, picker, fetchFn };
  const signin = new SigninManager(cfg, { fetchFn, onSignedIn: () => { refreshModels().catch(() => {}); } });

  const send = (res, status, obj) => { const b = JSON.stringify(obj); res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(b); };
  const authed = (req) => !cfg.secret || crypto.timingSafeEqual(sha(req.headers.authorization || ""), sha("Bearer " + cfg.secret));
  const readBody = (req) => new Promise((resolve, reject) => {
    let n = 0; const parts = [];
    req.on("data", (c) => { n += c.length; if (n > MAX_BODY) { reject(new GatewayError(413, "too_large", "body over 1 MB")); req.destroy(); } else parts.push(c); });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(parts).toString() || "{}")); } catch { reject(new GatewayError(400, "bad_json", "body is not JSON")); } });
    req.on("error", reject);
  });
  const fail = (res, e) => {
    if (e instanceof NeedsSignin) return send(res, 401, { error: { code: "needs_signin", message: e.message } });
    if (e instanceof SigninError) return send(res, e.status, { error: { code: e.code, message: e.message } });
    if (e instanceof GatewayError) return send(res, e.status, { error: { code: e.code, message: e.message, ...e.extra } });
    console.error("[gateway] internal error:", e && e.message ? String(e.message).slice(0,200) : "unknown");
    return send(res, 500, { error: { code: "internal", message: String(e && e.message ? e.message : "gateway error").slice(0, 200) } });
  };

  async function refreshModels() {
    const t = await tokens.getAccessToken();
    return picker.refresh(t);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://x");
      if (req.method === "GET" && url.pathname === "/health") {
        if (!authed(req)) return send(res, 401, { error: { code: "unauthorized" } });
        return send(res, 200, { ok: true, signin: tokens.status(), model: picker.current(), top: picker.top(), eligible: picker.list(), model_history: (picker.state.history || []).slice(-3) });
      }
      if (!authed(req)) return send(res, 401, { error: { code: "unauthorized" } });
      if (req.method === "GET" && url.pathname === "/v1/models") return send(res, 200, { current: picker.current(), top: picker.top(), eligible: picker.list() });
      if (req.method === "POST" && url.pathname === "/v1/models/refresh") { try { return send(res, 200, await refreshModels()); } catch (e) { return fail(res, e); } }
      if (req.method === "GET" && url.pathname === "/admin/signin/status") return send(res, 200, signin.status());
      if (req.method === "POST" && url.pathname === "/admin/signin/start") return send(res, 200, await signin.start());
      if (req.method === "POST" && url.pathname === "/admin/signin/cancel") { signin.cancel(); return send(res, 200, { ok: true }); }
      if (req.method === "POST" && url.pathname === "/admin/signin/finish") { const b = await readBody(req); return send(res, 200, await signin.finish(b.address)); }
      if (req.method === "POST" && url.pathname === "/v1/responses") {
        const body = await readBody(req);
        const r = await respond(ctx, body);
        return send(res, r.status, r.json);
      }
      return send(res, 404, { error: { code: "not_found" } });
    } catch (e) { return fail(res, e); }
  });

  let modelTimer = null;
  return {
    server, tokens, picker, signin, refreshModels,
    async start() {
      await new Promise((r) => server.listen(cfg.port, cfg.host, r));
      tokens.startTimer();
      refreshModels().catch(() => {});
      modelTimer = setInterval(() => refreshModels().catch(() => {}), cfg.modelsEveryMs); modelTimer.unref?.();
      return server.address();
    },
    async stop() { signin.cancel(); tokens.stop(); if (modelTimer) clearInterval(modelTimer); server.closeAllConnections?.(); await new Promise((r) => server.close(r)); },
  };
}
