// Configuration. Nothing secret lives in this repository: tokens go to a protected file the operator controls.
import os from "node:os";
import path from "node:path";

export const DEFAULTS = {
  authBase: "https://auth.openai.com",
  apiBase: "https://api.openai.com",
  resource: "https://api.openai.com/v1",
  scopes: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
  agentName: "Build OS",
  refreshEveryMs: 4 * 3600 * 1000, // keep the rolling 30-day refresh token alive even on idle days
  modelsEveryMs: 24 * 3600 * 1000,
  refreshSkewMs: 5 * 60 * 1000,
  tierOrder: ["sol", "astra"], // lowest to highest; "Sol or better" means this tier or later
  minVersion: "6.1",
  tierMinVersion: "6", // higher tiers (Astra) count from version 6
  idleTimeoutMs: 10 * 60 * 1000, // abort only when OpenAI sends nothing for this long (no answer-time limit)
};

export function dirFromEnv(env = process.env) {
  return env.GATEWAY_DIR || path.join(os.homedir(), ".config", "build-os-chatgpt-gateway");
}

export function configFromEnv(env = process.env) {
  const dir = dirFromEnv(env);
  return {
    ...DEFAULTS,
    authBase: env.GATEWAY_AUTH_BASE || DEFAULTS.authBase,
    apiBase: env.GATEWAY_API_BASE || DEFAULTS.apiBase,
    agentName: env.GATEWAY_AGENT_NAME || DEFAULTS.agentName,
    dir,
    credFile: path.join(dir, "credentials.json"),
    hostFile: path.join(dir, "host.json"),
    modelsFile: path.join(dir, "models_state.json"),
    secret: env.GATEWAY_SECRET || "",
    host: env.GATEWAY_HOST || "127.0.0.1",
    port: Number(env.GATEWAY_PORT || 8787),
    loginPort: Number(env.GATEWAY_LOGIN_PORT || 0),
    pinModel: env.GATEWAY_PIN_MODEL || "",
    allowAboveHigh: env.GATEWAY_ALLOW_ABOVE_HIGH === "1",
  };
}
