// Always the newest eligible frontier model (rule 9.0d, wording of 2026-10-13: whatever the family is called). Ranks the account's model list by version, then tier.
// "Newest" (current) = newest everyday model (Sol line today), never the top tier by default. "Top" = newest of the highest tier (today Astra); a new family released at a
// version above every known top-tier model also becomes top. Small, specialised and non-chat models are never picked.
import { readJson, writeJsonAtomic } from "./store.js";

const PATTERN = /^gpt-(\d+(?:\.\d+)*)-([a-z]+)(?:-(\d{4}-\d{2}-\d{2}))?$/;
const NOT_FRONTIER = new Set(["mini", "nano", "micro", "lite", "flash", "codex", "image", "audio", "realtime", "transcribe", "tts", "search", "embedding", "whisper", "moderation", "instruct", "chat", "turbo", "oss", "vision", "preview", "latest"]);
const verParts = (v) => v.split(".").map(Number);
export function cmpVersion(a, b) {
  const x = verParts(a), y = verParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; }
  return 0;
}
export function parseModel(id) {
  const m = PATTERN.exec(String(id));
  return m && !NOT_FRONTIER.has(m[2]) ? { id, version: m[1], tier: m[2], date: m[3] || "" } : null;
}
// Eligible: a known family at its minimum version or newer (Sol from minVersion, higher tiers from tierMinVersion), or ANY new frontier family
// at minVersion or newer (a model family Kyle has never named is still picked once it is newer).
export function eligible(ids, cfg) {
  const out = [];
  for (const id of ids) {
    const p = parseModel(id);
    if (!p) continue;
    const ti = cfg.tierOrder.indexOf(p.tier);
    const ok = ti < 0 ? cmpVersion(p.version, cfg.minVersion) >= 0 : ti === 0 ? cmpVersion(p.version, cfg.minVersion) >= 0 : cmpVersion(p.version, cfg.tierMinVersion || "6") >= 0;
    if (ok) out.push({ ...p, known: ti >= 0 });
  }
  // Newest version first; at the same version the higher tier first (unknown families after known ones); dated snapshots after the plain alias.
  out.sort((a, b) => cmpVersion(b.version, a.version) || cfg.tierOrder.indexOf(b.tier) - cfg.tierOrder.indexOf(a.tier) || (a.date ? 1 : 0) - (b.date ? 1 : 0));
  return out;
}
// The top-tier pick: newest model of the highest known tier, unless a newer new-family model exists (then that one).
export function topOf(el, cfg) {
  if (!el.length) return null;
  const topTier = cfg.tierOrder[cfg.tierOrder.length - 1];
  const known = el.find((e) => e.tier === topTier);
  const newer = el.find((e) => !e.known && (!known || cmpVersion(e.version, known.version) > 0));
  return (newer || known || el[0]).id;
}
// The everyday pick (Kyle, 2026-10-13: Sol by default, the top tier only when chosen): newest model that is not the top pick or a top-tier model.
// If nothing else is left (the account lists only top-tier models), it is the newest eligible model.
export function standardOf(el, cfg) {
  if (!el.length) return null;
  const topTier = cfg.tierOrder[cfg.tierOrder.length - 1];
  const topId = topOf(el, cfg);
  return (el.find((e) => e.id !== topId && e.tier !== topTier) || el[0]).id;
}
export function tierOf(id) { return parseModel(id)?.tier || null; }

export class ModelPicker {
  constructor(cfg, { fetchFn = fetch, now = () => Date.now() } = {}) { Object.assign(this, { cfg, fetchFn, now }); this.state = readJson(cfg.modelsFile) || { current: null, history: [] }; }
  current() { return this.cfg.pinModel || this.state.current; }
  top() { return this.cfg.pinModel || this.state.top || this.state.current; }
  list() { return this.state.eligible || []; }
  // Returns { current, previous, changed }. Writes a one-line change record the next report can quote.
  async refresh(accessToken) {
    const r = await this.fetchFn(this.cfg.apiBase + "/v1/models", { headers: { authorization: "Bearer " + accessToken, accept: "application/json" } });
    if (!r.ok) throw new Error("model list http " + r.status);
    const j = await r.json();
    const ids = (j.data || j.models || []).map((m) => (typeof m === "string" ? m : m.id || m.slug)).filter(Boolean);
    const el = eligible(ids, this.cfg);
    if (!el.length) throw new Error("no frontier model in the account's model list");
    const previous = this.state.current;
    const current = standardOf(el, this.cfg);
    const changed = previous !== current;
    const top = topOf(el, this.cfg);
    const next = { ...this.state, current, top, eligible: el.map((e) => e.id), checked_at: new Date(this.now()).toISOString() };
    if (changed) next.history = [...(this.state.history || []), { at: next.checked_at, from: previous, to: current }].slice(-50);
    this.state = next;
    writeJsonAtomic(this.cfg.modelsFile, next);
    return { current, top, previous, changed, new_family: el.some((e) => !e.known) };
  }
}
