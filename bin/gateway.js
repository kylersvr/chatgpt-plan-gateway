#!/usr/bin/env node
import { configFromEnv } from "../src/config.js";
import { createGateway } from "../src/server.js";

const cfg = configFromEnv();
const gw = createGateway(cfg);
const addr = await gw.start();
console.log(`chatgpt-plan-gateway listening on ${addr.address}:${addr.port} (sign-in: ${gw.tokens.status().state})`);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, async () => { await gw.stop(); process.exit(0); });
