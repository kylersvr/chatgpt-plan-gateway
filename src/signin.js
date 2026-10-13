// Headless sign-in: lets someone sign in from any browser while the gateway runs on a server.
// start() opens the one-time listener (on the server's own loopback) and returns the OpenAI address to visit.
// After signing in, the browser lands on a 127.0.0.1 address that cannot load; the person pastes that address
// into finish(), and the gateway hands it to its own listener. The secret half of the exchange (the PKCE
// verifier) never leaves this process, so the pasted one-time code is useless to anyone else.
import http from "node:http";
import { runLogin } from "./auth.js";

const WINDOW_MS = 30 * 60 * 1000;

export class SigninManager {
  constructor(cfg, { fetchFn = fetch, onSignedIn = () => {} } = {}) {
    Object.assign(this, { cfg, fetchFn, onSignedIn });
    this.state = "idle"; this.url = null; this.port = null; this.error = null; this.since = null; this.ac = null; this.run = null;
  }
  status() { return { state: this.state, error: this.error, since: this.since, pending_url: this.state === "waiting" ? this.url : null }; }

  async start() {
    if (this.state === "waiting") return { url: this.url, reused: true };
    this.state = "waiting"; this.error = null; this.since = new Date().toISOString(); this.ac = new AbortController();
    const url = await new Promise((resolve, reject) => {
      this.run = runLogin(this.cfg, { fetchFn: this.fetchFn, timeoutMs: WINDOW_MS, signal: this.ac.signal, onUrl: resolve })
        .then(() => { this.state = "signed_in"; this.error = null; this.onSignedIn(); })
        .catch((e) => { if (this.state === "waiting") { this.state = "failed"; this.error = e.message; } reject(e); });
    });
    this.url = url;
    this.port = Number(new URL(new URL(url).searchParams.get("redirect_uri")).port);
    return { url, reused: false };
  }

  cancel() { if (this.ac) this.ac.abort(); }

  // address: the full http://127.0.0.1:PORT/auth/callback?... text pasted by the person.
  async finish(address) {
    if (this.state !== "waiting") throw new SigninError(409, "no_signin_waiting", "Start a sign-in first.");
    let u;
    try { u = new URL(String(address).trim()); } catch { throw new SigninError(400, "bad_address", "That is not a web address. Paste the whole address from the error page."); }
    if (u.protocol !== "http:" || u.hostname !== "127.0.0.1" || Number(u.port) !== this.port || u.pathname !== "/auth/callback") {
      throw new SigninError(400, "wrong_address", "That address is not the sign-in return address for this attempt. Paste the one that starts with http://127.0.0.1:" + this.port + "/auth/callback");
    }
    await new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port: this.port, path: u.pathname + u.search, timeout: 60000 }, (res) => { res.resume(); res.on("end", resolve); }).on("error", reject);
    });
    await this.run.catch(() => {});
    if (this.state === "signed_in") return { ok: true };
    throw new SigninError(400, "signin_failed", this.error || "Sign-in did not finish.");
  }
}
export class SigninError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
