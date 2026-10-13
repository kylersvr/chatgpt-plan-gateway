// Keeps the sign-in alive: refresh before expiry and on a timer, one refresh at a time, rotated tokens saved together.
// A refresh that OpenAI refuses for good flips the state to needs_signin (no retry loop); a hiccup is retried.
import fs from "node:fs";
import { readJson, writeJsonAtomic } from "./store.js";
import { credentialsFromTokenResponse, CLIENT_ID } from "./auth.js";

export class NeedsSignin extends Error {
  constructor(reason) { super("needs_signin: " + reason); this.code = "needs_signin"; }
}
const PERMANENT = new Set(["invalid_grant", "invalid_token", "unauthorized_client", "invalid_client", "access_denied"]);

export class TokenManager {
  constructor(cfg, { fetchFn = fetch, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), retries = 3, baseDelayMs = 500 } = {}) {
    Object.assign(this, { cfg, fetchFn, now, sleep, retries, baseDelayMs });
    this.creds = null; this.mtime = 0; this.inflight = null; this.timer = null;
    this.lastRefreshAt = null; this.lastError = null; this.refreshCount = 0;
  }
  _load() {
    let m = 0;
    try { m = fs.statSync(this.cfg.credFile).mtimeMs; } catch { /* none */ }
    if (m !== this.mtime || !this.creds) { this.creds = readJson(this.cfg.credFile); this.mtime = m; }
    return this.creds;
  }
  _save(c) {
    writeJsonAtomic(this.cfg.credFile, c);
    this.creds = c;
    try { this.mtime = fs.statSync(this.cfg.credFile).mtimeMs; } catch { /* ignore */ }
  }
  status() {
    const c = this._load();
    if (!c || !c.refresh_token) return { state: "no_credentials" };
    if (c.needs_signin) return { state: "needs_signin", reason: c.needs_signin.reason, since: c.needs_signin.at };
    return { state: "ok", expires_at: c.expires_at, last_refresh_at: this.lastRefreshAt, refreshes: this.refreshCount, last_error: this.lastError };
  }
  async getAccessToken({ force = false } = {}) {
    const c = this._load();
    if (!c || !c.refresh_token) throw new NeedsSignin("no saved sign-in");
    if (c.needs_signin) throw new NeedsSignin(c.needs_signin.reason);
    if (!force && c.expires_at - this.cfg.refreshSkewMs > this.now()) return c.access_token;
    return (await this.refresh({ staleToken: c.access_token })).access_token;
  }
  // Serialized: callers arriving during a refresh wait for the same one.
  refresh({ staleToken } = {}) {
    if (!this.inflight) {
      this.inflight = this._refreshOnce(staleToken).finally(() => { this.inflight = null; });
    }
    return this.inflight;
  }
  async _refreshOnce(staleToken) {
    const c = this._load();
    if (!c || !c.refresh_token) throw new NeedsSignin("no saved sign-in");
    // Someone else (a fresh sign-in) may already have replaced the token we were asked to refresh.
    if (staleToken && c.access_token !== staleToken && c.expires_at - this.cfg.refreshSkewMs > this.now()) return c;
    let lastErr;
    for (let i = 0; i <= this.retries; i++) {
      try {
        const r = await this.fetchFn(this.cfg.authBase + "/api/accounts/oauth/token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
          body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: c.refresh_token, client_id: c.client_id || CLIENT_ID, resource: this.cfg.resource }),
        });
        const j = await r.json().catch(() => ({}));
        if (r.ok) {
          const next = credentialsFromTokenResponse(j, this.now(), c); // access token, expiry, scope and refresh token replaced together
          delete next.needs_signin;
          this._save(next);
          this.lastRefreshAt = new Date(this.now()).toISOString(); this.lastError = null; this.refreshCount++;
          return next;
        }
        if ((r.status === 400 || r.status === 401 || r.status === 403) && (PERMANENT.has(j.error) || r.status === 401)) {
          const reason = "OpenAI refused the saved sign-in (" + (j.error || r.status) + ")";
          this._save({ ...c, needs_signin: { at: new Date(this.now()).toISOString(), reason } });
          this.lastError = reason;
          throw new NeedsSignin(reason);
        }
        lastErr = new Error("refresh http " + r.status + (j.error ? " " + j.error : ""));
      } catch (e) {
        if (e instanceof NeedsSignin) throw e;
        lastErr = e;
      }
      if (i < this.retries) await this.sleep(this.baseDelayMs * 2 ** i);
    }
    this.lastError = "refresh failed: " + lastErr.message;
    throw new Error(this.lastError);
  }
  startTimer() {
    this.stop();
    this.timer = setInterval(() => { this.refresh().catch(() => {}); }, this.cfg.refreshEveryMs);
    this.timer.unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
}
