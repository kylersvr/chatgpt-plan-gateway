// Minimal RS256 ID-token validation against the issuer's published keys (no dependencies).
import crypto from "node:crypto";

const b64u = (s) => Buffer.from(s, "base64url");
export function decodeJwt(token) {
  const p = String(token || "").split(".");
  if (p.length !== 3) throw new Error("malformed id_token");
  return { header: JSON.parse(b64u(p[0]).toString()), payload: JSON.parse(b64u(p[1]).toString()), signed: p[0] + "." + p[1], sig: b64u(p[2]) };
}
export async function validateIdToken(token, { jwks, issuer, audience, nonce, now = Date.now() }) {
  const t = decodeJwt(token);
  if (t.header.alg !== "RS256") throw new Error("unsupported id_token alg " + t.header.alg);
  const jwk = (jwks.keys || []).find((k) => k.kid === t.header.kid) || (jwks.keys || []).length === 1 && jwks.keys[0];
  if (!jwk) throw new Error("no matching signing key");
  const ok = crypto.verify("RSA-SHA256", Buffer.from(t.signed), crypto.createPublicKey({ key: jwk, format: "jwk" }), t.sig);
  if (!ok) throw new Error("id_token signature invalid");
  const c = t.payload;
  if (c.iss !== issuer) throw new Error("id_token issuer mismatch");
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(audience)) throw new Error("id_token audience mismatch");
  if (!c.exp || c.exp * 1000 < now) throw new Error("id_token expired");
  if (nonce !== undefined && c.nonce !== nonce) throw new Error("id_token nonce mismatch");
  if (!c.sub) throw new Error("id_token has no subject");
  return c;
}
