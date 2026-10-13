# ChatGPT Plan Gateway

A small self-hosted program that lets your own tools use your ChatGPT plan through OpenAI's official "Sign in with ChatGPT" flow
(developers.openai.com/siwc/token-sharing-open-source). It holds no secrets in this repository: sign-in tokens live in an
owner-only file on the machine that runs it.

## What it does
- `npm run login` prints a sign-in address; you open it in your own browser. PKCE, state and nonce are checked, the ID token is
  verified against the issuer's keys, then dropped. Credentials are saved owner-only (mode 600).
- `npm start` runs a private endpoint (shared-secret bearer; refuses to listen beyond loopback without a secret):
  - `POST /v1/responses` sends one request to OpenAI's public Responses API with your plan token and returns one finished JSON answer.
    OpenAI's preview rules are enforced: `store:false`, `stream:true`, wait for `response.completed`; `max_output_tokens`,
    `temperature`, `previous_response_id` and `background` are dropped and listed in `gateway.dropped`.
  - `GET /health` (sign-in state, current model, no tokens), `GET /v1/models`, `POST /v1/models/refresh`.
- Stays signed in: refreshes before expiry and every 4 hours, one refresh at a time; rotated tokens are saved together.
  If OpenAI refuses the saved sign-in it reports `needs_signin` once and stops calling out until you sign in again.
- Always the newest eligible model: daily check of the account's model list; "Sol 6.1 or better" and higher tiers (Astra);
  every change is recorded. `GATEWAY_PIN_MODEL` pins one.
- Effort floor (Build OS rule 9.0f): never `fast`/`minimal`; `low` only for top-tier models (Astra); default `medium`;
  `xhigh`/`max` refused unless `GATEWAY_ALLOW_ABOVE_HIGH=1`.
- Plan allowance used up (`subscription_sharing_usage_limit_*`) becomes HTTP 429 `plan_limit`, so a caller can fall back.
- A refused effort or web-search setting is retried once without it and reported in `gateway.retries`, never hidden.
- No answer-time limit: only silence (no headers or bytes) for 10 minutes aborts a call.

## Tests
`npm test` runs 15 tests against a pretend OpenAI (`test/fake-openai.js`). **They prove this code against our reading of
OpenAI's published contract, not against the real service.**

## Not yet verified against the real service (ASSUMED)
1. Issuer discovery at `/.well-known/openid-configuration` and the JWKS location (falls back to `/.well-known/jwks.json`).
2. That `dynamic_agent_client` is used as the client id as-is and that `resource` is accepted on the token calls.
3. The exact error wording OpenAI uses when `reasoning.effort` or web search is refused (we match on the words "reasoning",
   "effort", "web_search", "tools").
4. Whether web search works on this route (plan test T3) and whether the effort setting is accepted (T2).
5. Where a credential file copied to another machine keeps working (OpenAI lists per-host attribution as not available yet).
These are checked on the first live sign-in, which only the account owner can do.

## Settings (environment)
`GATEWAY_DIR`, `GATEWAY_SECRET`, `GATEWAY_HOST` (default 127.0.0.1), `GATEWAY_PORT` (8787), `GATEWAY_LOGIN_PORT`,
`GATEWAY_PIN_MODEL`, `GATEWAY_ALLOW_ABOVE_HIGH`, `GATEWAY_AUTH_BASE`, `GATEWAY_API_BASE`, `GATEWAY_AGENT_NAME`.

MIT licence.
