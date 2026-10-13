// "Sign in with ChatGPT" for self-hosted apps: PKCE authorization-code flow with a loopback callback.
// Follows OpenAI's published contract (developers.openai.com/siwc/token-sharing-open-source). Anything the page
// does not state is marked ASSUMED below and listed in the README so it is tested against the real service first.
import crypto from "node:crypto";
import http from "node:http";
import { writeJsonAtomic, readJson, hostId } from "./store.js";
import { validateIdToken } from "./jwt.js";

export const CLIENT_ID = "dynamic_agent_client";
const b64u = (b) => Buffer.from(b).toString("base64url");

export function makePkce() {
  const verifier = b64u(crypto.randomBytes(48));
  return { verifier, challenge: b64u(crypto.createHash("sha256").update(verifier).digest()) };
}

export function authorizeUrl(cfg, { redirectUri, state, nonce, challenge, host }) {
  const q = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: cfg.scopes,
    resource: cfg.resource,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    nonce,
    ext_agent_host_id: host,
    agent_name_hint: cfg.agentName,
  });
  return cfg.authBase + "/api/accounts/authorize?" + q.toString();
}

// ASSUMED: issuer metadata at the standard OIDC discovery path; falls back to the documented base.
export async function discover(cfg, fetchFn = fetch) {
  try {
    const r = await fetchFn(cfg.authBase + "/.well-known/openid-configuration");
    if (r.ok) {
      const d = await r.json();
      return { issuer: d.issuer || cfg.authBase, jwks_uri: d.jwks_uri || cfg.authBase + "/.well-known/jwks.json" };
    }
  } catch { /* fall through */ }
  return { issuer: cfg.authBase, jwks_uri: cfg.authBase + "/.well-known/jwks.json" };
}

export function credentialsFromTokenResponse(t, now = Date.now(), prev = {}) {
  if (!t || !t.access_token) throw new Error("token response has no access_token");
  return {
    client_id: prev.client_id || CLIENT_ID,
    access_token: t.access_token,
    refresh_token: t.refresh_token || prev.refresh_token || null,
    expires_at: now + Number(t.expires_in || 3600) * 1000,
    scope: t.scope || prev.scope || "",
    token_type: t.token_type || "Bearer",
    subject: prev.subject || null,
    obtained_at: new Date(now).toISOString(),
  };
}

export async function exchangeCode(cfg, { code, verifier, redirectUri, clientId = CLIENT_ID }, fetchFn = fetch) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
    resource: cfg.resource,
  });
  const r = await fetchFn(cfg.authBase + "/api/accounts/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("token exchange failed: " + (j.error || r.status));
  return j;
}

// Runs the whole sign-in. onUrl(url) receives the address Kyle (or the opener) must visit; nothing is printed here.
export async function runLogin(cfg, { onUrl, fetchFn = fetch, timeoutMs = 5 * 60 * 1000, port = cfg.loginPort || 0, signal } = {}) {
  const host = hostId(cfg.hostFile);
  const { verifier, challenge } = makePkce();
  const state = b64u(crypto.randomBytes(24));
  const nonce = b64u(crypto.randomBytes(24));
  const meta = await discover(cfg, fetchFn);

  let done;
  const result = new Promise((res, rej) => { done = { res, rej }; });
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    if (u.pathname !== "/auth/callback") { res.writeHead(404).end(); return; }
    const page = (code, msg) => { res.writeHead(code, { "content-type": "text/plain; charset=utf-8" }); res.end(msg); };
    try {
      if (u.searchParams.get("error")) throw new Error("sign-in refused: " + u.searchParams.get("error"));
      const got = u.searchParams.get("state") || "";
      const a = Buffer.from(got), b = Buffer.from(state);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error("state mismatch");
      const code = u.searchParams.get("code");
      if (!code) throw new Error("no code in callback");
      const redirectUri = "http://127.0.0.1:" + server.address().port + "/auth/callback";
      // OpenAI assigns a per-sign-in client id (oaiapp_...) and reports it on the callback; the exchange and every
      // later refresh must use that one, not the placeholder used to start the sign-in.
      const clientId = u.searchParams.get("client_id") || CLIENT_ID;
      const t = await exchangeCode(cfg, { code, verifier, redirectUri, clientId }, fetchFn);
      let subject = null;
      if (t.id_token) {
        const jr = await fetchFn(meta.jwks_uri);
        const jwks = await jr.json();
        const claims = await validateIdToken(t.id_token, { jwks, issuer: meta.issuer, audience: clientId, nonce });
        subject = claims.sub;
      }
      const creds = credentialsFromTokenResponse(t, Date.now(), { subject, client_id: clientId });
      creds.subject = subject;
      writeJsonAtomic(cfg.credFile, creds);
      page(200, "Signed in. You can close this tab.");
      done.res({ subject });
    } catch (e) {
      page(400, "Sign-in did not finish: " + e.message);
      done.rej(e);
    }
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  const redirectUri = "http://127.0.0.1:" + server.address().port + "/auth/callback";
  const timer = setTimeout(() => done.rej(new Error("sign-in timed out")), timeoutMs);
  if (signal) { if (signal.aborted) done.rej(new Error("sign-in cancelled")); else signal.addEventListener("abort", () => done.rej(new Error("sign-in cancelled")), { once: true }); }
  try {
    onUrl(authorizeUrl(cfg, { redirectUri, state, nonce, challenge, host }));
    return await result;
  } finally {
    clearTimeout(timer);
    server.close();
  }
}

export function signedIn(cfg) {
  const c = readJson(cfg.credFile);
  return !!(c && c.refresh_token);
}
