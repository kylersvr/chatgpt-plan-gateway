// Always the newest eligible model: "Sol or better" (rule 9.0d). Ranks the account's model list by version, then tier.
import { readJson, writeJsonAtomic } from "./store.js";

const PATTERN = /^gpt-(\d+(?:\.\d+)*)-(sol|astra)(?:-(\d{4}-\d{2}-\d{2}))?$/;
const verParts = (v) => v.split(".").map(Number);
export function cmpVersion(a, b) {
  const x = verParts(a), y = verParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; }
  return 0;
}
export function parseModel(id) {
  const m = PATTERN.exec(String(id));
  return m ? { id, version: m[1], tier: m[2], date: m[3] || "" } : null;
}
// Eligible: the Sol line at the minimum version or newer, and any higher tier (Astra) at version 6 or newer.
export function eligible(ids, cfg) {
  const out = [];
  for (const id of ids) {
    const p = parseModel(id);
    if (!p) continue;
    const ti = cfg.tierOrder.indexOf(p.tier);
    if (ti < 0) continue;
    const ok = ti === 0 ? cmpVersion(p.version, cfg.minVersion) >= 0 : cmpVersion(p.version, cfg.tierMinVersion || "6") >= 0;
    if (ok) out.push(p);
  }
  // Newest version first; at the same version the higher tier first; dated snapshots after the plain alias.
  out.sort((a, b) => cmpVersion(b.version, a.version) || cfg.tierOrder.indexOf(b.tier) - cfg.tierOrder.indexOf(a.tier) || (a.date ? 1 : 0) - (b.date ? 1 : 0));
  return out;
}
export function tierOf(id) { return parseModel(id)?.tier || null; }

export class ModelPicker {
  constructor(cfg, { fetchFn = fetch, now = () => Date.now() } = {}) { Object.assign(this, { cfg, fetchFn, now }); this.state = readJson(cfg.modelsFile) || { current: null, history: [] }; }
  current() { return this.cfg.pinModel || this.state.current; }
  list() { return this.state.eligible || []; }
  // Returns { current, previous, changed }. Writes a one-line change record the next report can quote.
  async refresh(accessToken) {
    const r = await this.fetchFn(this.cfg.apiBase + "/v1/models", { headers: { authorization: "Bearer " + accessToken, accept: "application/json" } });
    if (!r.ok) throw new Error("model list http " + r.status);
    const j = await r.json();
    const ids = (j.data || j.models || []).map((m) => (typeof m === "string" ? m : m.id || m.slug)).filter(Boolean);
    const el = eligible(ids, this.cfg);
    if (!el.length) throw new Error("no Sol-or-better model in the account's model list");
    const previous = this.state.current;
    const current = el[0].id;
    const changed = previous !== current;
    const next = { ...this.state, current, eligible: el.map((e) => e.id), checked_at: new Date(this.now()).toISOString() };
    if (changed) next.history = [...(this.state.history || []), { at: next.checked_at, from: previous, to: current }].slice(-50);
    this.state = next;
    writeJsonAtomic(this.cfg.modelsFile, next);
    return { current, previous, changed };
  }
}
