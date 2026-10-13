// Protected credential storage: owner-only, atomic writes, never logged.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + "." + process.pid + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* non-POSIX */ }
}
export function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}
// The host id is stable for this runtime and sent on every authorization request.
export function hostId(file) {
  const h = readJson(file);
  if (h && typeof h.ext_agent_host_id === "string" && h.ext_agent_host_id) return h.ext_agent_host_id;
  const id = "urn:uuid:" + crypto.randomUUID();
  writeJsonAtomic(file, { ext_agent_host_id: id });
  return id;
}
