#!/usr/bin/env node
// One-time sign-in. Prints the address to open in your own browser; never prints a token.
import { configFromEnv } from "../src/config.js";
import { runLogin } from "../src/auth.js";

const cfg = configFromEnv();
try {
  const r = await runLogin(cfg, { onUrl: (u) => console.log("Open this address in your browser and sign in:\n" + u + "\n") });
  console.log("Signed in" + (r.subject ? " (account id " + r.subject.slice(0, 6) + "...)" : "") + ". Credentials saved to " + cfg.credFile + " (owner-only).");
} catch (e) {
  console.error("Sign-in did not finish: " + e.message);
  process.exit(1);
}
