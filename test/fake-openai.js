// A pretend OpenAI for tests: sign-in pages, token endpoint (with rotation), model list and a streaming Responses API.
// It encodes what we ASSUME from OpenAI's published contract. Passing here proves our code against that assumption only.
import http from "node:http";
import crypto from "node:crypto";

const b64u = (b) => Buffer.from(b).toString("base64url");

export async function startFake(opts = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
  const st = {
    lifetimeS: 3600, refreshMode: "ok", responsesMode: "ok",
    models: ["gpt-5.6-sol", "gpt-6-sol", "gpt-6.1-sol", "gpt-6.1-sol-mini", "gpt-6-astra", "text-embedding-4"],
    calls: [], n: 0, codes: new Map(), validAccess: new Set(), currentRefresh: null, fail503Left: 0, once401: false,
    ...opts,
  };
  let base = "";
  const issue = (clientId, nonce) => {
    st.n++;
    const access = "at-" + st.n, refresh = "rt-" + st.n;
    st.validAccess = new Set([access]);
    st.currentRefresh = refresh;
    const now = Math.floor(Date.now() / 1000);
    const head = b64u(JSON.stringify({ alg: "RS256", kid: "k1" }));
    const pay = b64u(JSON.stringify({ iss: base, aud: clientId, sub: "user-123", nonce, exp: now + 3600, iat: now }));
    const sig = b64u(crypto.sign("RSA-SHA256", Buffer.from(head + "." + pay), privateKey));
    return { access_token: access, refresh_token: refresh, id_token: head + "." + pay + "." + sig, token_type: "Bearer", expires_in: st.lifetimeS, scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct" };
  };
  const readBody = (req) => new Promise((r) => { const p = []; req.on("data", (c) => p.push(c)); req.on("end", () => r(Buffer.concat(p).toString())); });
  const json = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  const bearer = (req) => (req.headers.authorization || "").replace(/^Bearer /, "");

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    const raw = req.method === "POST" ? await readBody(req) : "";
    st.calls.push({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), headers: req.headers, raw });
    if (u.pathname === "/.well-known/openid-configuration") return json(res, 200, { issuer: base, jwks_uri: base + "/jwks" });
    if (u.pathname === "/jwks") return json(res, 200, { keys: [jwk] });
    if (u.pathname === "/api/accounts/authorize") {
      const q = u.searchParams;
      const code = "code-" + crypto.randomBytes(4).toString("hex");
      st.codes.set(code, { challenge: q.get("code_challenge"), nonce: q.get("nonce"), clientId: q.get("client_id"), redirect: q.get("redirect_uri") });
      const to = new URL(q.get("redirect_uri")); to.searchParams.set("code", code); to.searchParams.set("state", q.get("state")); to.searchParams.set("client_id", "oaiapp_test123"); st.codes.get(code).clientId = "oaiapp_test123";
      res.writeHead(302, { location: to.toString() }); return res.end();
    }
    if (u.pathname === "/api/accounts/oauth/token") {
      const f = new URLSearchParams(raw);
      if (f.get("grant_type") === "authorization_code") {
        const c = st.codes.get(f.get("code"));
        const ok = c && f.get("client_id") === c.clientId && b64u(crypto.createHash("sha256").update(f.get("code_verifier") || "").digest()) === c.challenge && c.redirect === f.get("redirect_uri");
        if (!ok) return json(res, 400, { error: "invalid_grant" });
        st.codes.delete(f.get("code"));
        return json(res, 200, issue(c.clientId, c.nonce));
      }
      if (f.get("grant_type") === "refresh_token") {
        if (st.fail503Left > 0) { st.fail503Left--; return json(res, 503, { error: "temporarily_unavailable" }); }
        if (st.refreshMode === "invalid_grant" || f.get("refresh_token") !== st.currentRefresh) return json(res, 400, { error: "invalid_grant" });
        await new Promise((r) => setTimeout(r, 30));
        return json(res, 200, issue(f.get("client_id"), undefined));
      }
      return json(res, 400, { error: "unsupported_grant_type" });
    }
    if (u.pathname === "/v1/models") {
      if (!st.validAccess.has(bearer(req))) return json(res, 401, { error: { message: "bad token" } });
      return json(res, 200, { data: st.models.map((id) => ({ id })) });
    }
    if (u.pathname === "/v1/responses") {
      if (st.once401) { st.once401 = false; return json(res, 401, { error: { message: "expired" } }); }
      if (!st.validAccess.has(bearer(req))) return json(res, 401, { error: { message: "bad token" } });
      const body = JSON.parse(raw);
      const hasEffort = body.reasoning && body.reasoning.effort;
      const hasSearch = (body.tools || []).some((t) => /web_search/.test(t.type));
      if (st.responsesMode === "effort_reject" && hasEffort) return json(res, 400, { error: { message: "Unsupported parameter: 'reasoning.effort'" } });
      if (st.responsesMode === "search_reject" && hasSearch) return json(res, 400, { error: { message: "tools: web_search is not available for this account" } });
      res.writeHead(200, { "content-type": "text/event-stream" });
      const ev = (o) => res.write("data: " + JSON.stringify(o) + "\n\n");
      if (st.responsesMode === "usage_limit") { ev({ type: "response.failed", response: { error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit" } } }); return res.end(); }
      if (st.responsesMode === "stall") { return; } // never answers
      ev({ type: "response.created", response: { id: "resp_1" } });
      ev({ type: "response.output_text.delta", delta: "Hello " });
      ev({ type: "response.output_text.delta", delta: "world" });
      ev({ type: "response.completed", response: { id: "resp_1", model: body.model, output: [{ type: "message", content: [{ type: "output_text", text: "Hello world" }] }], usage: { input_tokens: 5, output_tokens: 2 } } });
      return res.end();
    }
    json(res, 404, { error: "nope" });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = "http://127.0.0.1:" + server.address().port;
  return { url: base, st, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}
