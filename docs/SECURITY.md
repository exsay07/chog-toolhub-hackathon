# Security model

Chog Toolhub is treated as a **high-risk financial application**. This document is the threat model and the list
of controls; findings and their status are in `SECURITY_AUDIT.md`. Nothing here claims the system is "unhackable".

## Assets

1. Trading-wallet private keys (EVM secp256k1, Solana ed25519).
2. Funds in the trading wallet; the user's external (auth) wallet must never be put at risk.
3. Session tokens; local-agent pairing tokens.
4. Per-user configuration, tracked wallets, journal, PnL (privacy).
5. Integrity of transactions (destination, amounts, approvals) and of automation decisions.

## Trust boundaries

Browser ⇄ API (same origin) · Browser ⇄ aggregators / RPCs (third-party, untrusted responses) · API ⇄ market
providers (untrusted data) · Browser ⇄ local agent (loopback) · Agent ⇄ farming software (untrusted until reviewed).

## Threats and controls

| Threat                          | Controls                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **NFT-gate bypass**             | Ownership read server-side from Monad (`balanceOf`) — never from the client. Contract identity verified on-chain. Fail closed when unverifiable. Dev allowlist refused when `NODE_ENV=production`.                                                                                                                                            |
| **Signature replay / phishing** | SIWE: server nonce (128-bit, single-use, 5 min, consumed atomically), exact domain + URI origin, fixed statement, `issuedAt` ≤ 10 min, `expirationTime` required and ≤ 10 min window. Statement explains it grants no spending permission. Client refuses to sign if server domain ≠ page host.                                               |
| **Session theft / fixation**    | 256-bit random token, only SHA-256 stored, `HttpOnly; SameSite=Strict; Secure` (prod), new token on every login and old one revoked, server-side revocation, TTL 24 h, session list + revoke in Settings.                                                                                                                                     |
| **CSRF**                        | SameSite=Strict + `Origin` allow-list on every state-changing request + mandatory custom header `x-chog-csrf` (forces preflight; no CORS is configured). WebSocket upgrades check `Origin` and the session.                                                                                                                                   |
| **XSS**                         | React escaping, no `dangerouslySetInnerHTML`, CSP `script-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'none'`; external links forced to `https:`; provider images only via `<img>` with `no-referrer`.                                                                                                              |
| **SQL injection**               | Drizzle query builder (parameterised); no raw SQL with user input.                                                                                                                                                                                                                                                                            |
| **SSRF**                        | Outbound hosts are constants; path segments are validated addresses + `encodeURIComponent`; `redirect: 'error'`; response size cap 5 MB; timeouts.                                                                                                                                                                                            |
| **Broken authorization / IDOR** | Every per-user query filters by `user_id` from the session; tested (other users get 404 / empty).                                                                                                                                                                                                                                             |
| **Rate-limit bypass / DoS**     | Global per-IP limit; tighter per-route limits (auth 20/min, journal 60/min, logs 120/min); body limit 64 KB; WS 30 msgs/10 s, payload 4 KB, max 8 sockets/user, 10 pair subs/socket; backpressure drops ticks for slow consumers; journal in-flight cap 50/user; tracker address cap per network; upstream token buckets with bounded queues. |
| **Malicious provider data**     | Third-party values labelled with source + freshness; symbols never used as identity; addresses validated; stale data marked.                                                                                                                                                                                                                  |
| **Transaction manipulation**    | Kyber router allow-list, rejection of any extra fee, `value` must equal input for native swaps, our address must appear in calldata, **simulation before signing**; Jupiter tx: fee payer = our wallet, exactly 1 signer, Jupiter program present, simulated.                                                                                 |
| **Wallet-draining approvals**   | Exact-amount approvals only; never unlimited.                                                                                                                                                                                                                                                                                                 |
| **Duplicate execution / races** | Per-(network, token, side) in-flight guard; per-network nonce mutex; idempotency keys on journal; tracker event de-duplication (DB unique constraint + client set); sniper per-pool de-dupe; mint attempt cap.                                                                                                                                |
| **Runaway automation**          | Global risk limits (per-trade, 24 h automated exposure from server journal, slippage, impact, liquidity, cooldown, network allow-list, token block/allow-lists); automation refuses trades whose USD value is unknown; emergency stop (client kill switch + server disarm of all automations and copy configs).                               |
| **Secret leakage**              | Keys never leave the browser; pino redaction paths + error sanitiser; agent log sanitiser; `.env` ignored; secret scanner + gitleaks in CI.                                                                                                                                                                                                   |
| **Supply chain**                | Lockfile; npm 12 blocks install scripts (only esbuild allowed); `npm audit` in CI; small dependency set; agent bundles to a single auditable file.                                                                                                                                                                                            |
| **Cross-user leakage**          | No shared signing state on the server; WS user messages routed by user id; tracker events are public chain data.                                                                                                                                                                                                                              |
| **Local agent abuse**           | See below.                                                                                                                                                                                                                                                                                                                                    |
| **Malicious farming software**  | Not executed until reviewed; `spawnIsolated` runs reviewed code with no shell, scrubbed env, task-private cwd, executable confined to an authorised directory.                                                                                                                                                                                |

## NFT gate policy

- Verified at login (fail closed on RPC outage → HTTP 503, no session).
- Re-verified when the last successful check is older than `NFT_RECHECK_SEC` (default 5 min).
  - NFT sold / transferred / burned → session revoked immediately, WebSockets closed, user returned to the gate.
  - RPC outage → access continues for at most `NFT_GRACE_SEC` (default 15 min) after the last success, then 503.
- Ownership grants **app access only**. It never authorises trades or approvals.

### Judge access (reviewer pass)

`JUDGE_ACCESS_CODE` (16-64 chars, optional `JUDGE_ACCESS_UNTIL`) lets reviewers sign in without the NFT: they
type the code, connect any wallet and sign the normal SIWE message. The code is compared in constant time;
wrong codes are refused (`BAD_JUDGE_CODE`) and rate-limited like every sign-in. Sessions are marked `judge`
in the UI, are never checked against the NFT, and are revoked on their next request once the pass is
closed (code removed or past its end date). Off by default; turn it off after the review.

## Trading wallet ("local vault") — trust model

- Keys are generated in the browser (`viem` / `@solana/web3.js` CSPRNG), shown once for **mandatory backup**, then
  encrypted with **PBKDF2-SHA256 (600k) → AES-256-GCM**, addresses bound as AAD, stored in IndexedDB. The server
  stores only public addresses.
- Unlocked keys live in a module closure (not React state, storage, logs or requests); auto-lock after idle
  (default 15 min, configurable). Export requires re-entering the password.
- **What this does not protect against:** XSS on our origin or a malicious/compromised browser extension can use
  the keys _while unlocked_; malware on the device can capture the password; there is **no server-side recovery** —
  losing the password and backup loses the funds.
- **Recommendation before handling meaningful funds:** move to an audited embedded/MPC wallet with policy controls
  (e.g. Turnkey/Privy server-side policies) or ship the trading key inside the desktop agent (OS keychain), and keep
  trading balances small.

## Local agent

- Binds `127.0.0.1` only (verified with `netstat`). Rejects any `Host` that is not `127.0.0.1:*`/`localhost:*`
  (DNS-rebinding defence) and any `Origin` not explicitly configured; CORS echoes only the allowed origin; Private
  Network Access opt-in only for that origin.
- Pairing: 8-char one-time code printed in the agent's own terminal, 5 min TTL, burned after 5 wrong attempts,
  timing-safe compare → 256-bit token (only hash kept, bound to origin, 12 h TTL).
- No command execution endpoint. Only the typed commands in `zAgentCommand` (status, list, start/pause/resume/stop,
  stopAll, logs), validated with zod (task ids `[a-zA-Z0-9-]`, no paths).
- Per-task data directories confined to the agent data root (path-traversal check). Runtime limit per task.
  Attended mode pauses tasks when the site stops heart-beating. `Ctrl+C` / `q` stops all tasks.
- Residual risk: XSS on the web origin could drive the agent with a stolen pairing token (start/stop configured
  tasks within schema limits). Updates: not yet signed/auto-updated — distribute as signed releases (see plan).

## Copy trading — explicit trust assumption

Copy decisions are triggered by tracker events pushed from the server. A compromised server could inject a fake
"buy" event and cause trades **within the user's limits** (amount caps, liquidity, scans, simulation still apply).
Users should keep copy limits small and use token allow-lists for high-value setups.

## Operational

- Production refuses to start with: PGlite, dev allowlist, non-https origin, `EXTRA_ORIGINS`, or load-test rate limits.
- `TRUST_PROXY=true` only behind a trusted proxy (affects per-IP limits). `/internal/metrics` is served only to
  direct loopback requests without forwarding headers, or with `METRICS_TOKEN`.
- HSTS in production; DB credentials least-privilege (app role: DML on app tables; migrations with a separate role).
- Backups: daily `pg_dump` (7 daily / 4 weekly / 6 monthly) in `deploy/backups`; restore with `deploy/restore.sh`
  (safety dump → recreate DB → single-transaction load → automatic rollback on failure; verified on PostgreSQL 17).
  Copy backups off the server (see DEPLOY.md). Managed Postgres with PITR is the upgrade path.
- Server hardening (`deploy/setup-vps.sh`): no root SSH, firewall closed except SSH (web traffic only via the
  Cloudflare Tunnel), fail2ban, automatic security updates, read-only GitHub deploy key.
