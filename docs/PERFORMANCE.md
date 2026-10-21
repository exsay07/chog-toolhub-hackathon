# Performance

Command: `npm run loadtest` (`scripts/loadtest.mjs --conns=100 --duration=10 --ws=1000`). Raw output:
`docs/perf-results.json`.

## Environment (2026-10-19)

- AMD Ryzen 5 7400F (6 cores / 12 threads), 34 GB RAM, Windows 11 Pro, Node 24.15.0.
- **Single** API process; load generator (autocannon + `ws`) on the **same machine**.
- Database: **embedded PGlite** (WASM Postgres, one connection). This is _not_ representative of production
  Postgres with a connection pool — treat DB-bound numbers as a lower bound.
- Global per-IP rate limit raised for the run (single client IP); per-route limits left at production values.

## Results (100 concurrent HTTP connections, 10 s each)

| Scenario                                                | req/s | p50   | p90   | p99   | Non-2xx                                                          | Errors |
| ------------------------------------------------------- | ----- | ----- | ----- | ----- | ---------------------------------------------------------------- | ------ |
| `GET /readyz` (baseline incl. DB ping)                  | 3006  | 32 ms | 37 ms | 47 ms | 0                                                                | 0      |
| `GET /api/auth/me` (session + DB read)                  | 1655  | 58 ms | 70 ms | 86 ms | 0                                                                | 0      |
| `GET /api/settings` (authenticated DB read)             | 2148  | 45 ms | 51 ms | 61 ms | 0                                                                | 0      |
| `GET /api/market/search` (shared cache, 50-row payload) | 1788  | 55 ms | 63 ms | 76 ms | 0                                                                | 0      |
| `POST /api/automation-logs` (DB write)                  | —     | 12 ms | 13 ms | 17 ms | 120 × 200, then 429 (limit 120/min, by design)                   | 0      |
| `POST /api/auth/nonce`                                  | —     | 12 ms | 13 ms | 16 ms | 10 × 200 (10 used by logins), then 429 (limit 20/min, by design) | 0      |

**WebSockets:** 1000 concurrent authenticated connections across 10 users — **1000/1000 connected, 0 failed,
1000 still open after 5 s**, connect p95 362 ms (all opened simultaneously), server RSS 411 MB.

Before adding the 5 s session cache, authenticated endpoints peaked at ~850–920 req/s (p99 ~140 ms); the cache
roughly doubled throughput.

## Workload assumption for "1,000 concurrent users"

Per active user: 1 WebSocket, a terminal view refreshing pair data every 5 s (shared server poll — 0 extra upstream
calls per additional viewer), candles every 30–120 s, trades every 20 s, tracker events on demand. That is roughly
**0.3–0.5 HTTP req/s per user ⇒ 300–500 req/s for 1,000 users**, well under the measured ~1,700–2,100 req/s on the
slowest authenticated paths, with 1,000 open sockets.

**Conclusion (bounded):** on this hardware a single process handles the modelled 1,000-user workload against the
local API with headroom. **Not yet validated:** production Postgres, real network latency/TLS, a reverse proxy,
multi-instance fan-out, and — most importantly — upstream provider capacity: the free GeckoTerminal tier (30
req/min) and public RPCs cannot serve 1,000 users' distinct charts/trackers; a paid data plan and dedicated RPCs are
prerequisites, and the tracker is capped per network for that reason.

## Bottlenecks observed

1. Session lookup per request (mitigated by cache).
2. JSON serialisation of large search payloads.
3. PGlite's single connection for writes.
4. Upstream rate limits (GeckoTerminal 429s seen during test runs).

## Frontend

Route-level code splitting (each section is its own chunk: 7–25 kB gzip); vendor chunks for React, viem,
charting and Solana. Virtualised lists for search results and tracker history; chart updates touch only the last
bar; WebSocket subscriptions are reference-counted and released on unmount; client-side feeds are bounded
(tracker feed 300, new pools 50). Known: the Solana chunk (99 kB gzip) loads at start because the automation
runners import the engine — lazy-loading it is a follow-up.

## 300 simultaneous users with data-integrity check (2026-10-20)

Command: `node scripts/loadtest-users.mjs --users=300 --duration=120` (raw: `docs/perf-users.json`). Same machine
as above, embedded PGlite (one connection — pessimistic), single API process, each user on its own client IP
(`TRUST_PROXY=true` + `X-Forwarded-For`, as behind a reverse proxy).

- 300 distinct wallets signed in with real SIWE in 3.7 s; 300/300 app WebSockets open for the whole run.
- 120 s of normal use (a page view or click every 1.5–5 s per user, ~20 % writes): **13,755 requests, 0 failed**,
  ~115 req/s; reads p50 2 ms / p95 ≤ 51 ms; writes p95 ≤ 57 ms; `auth/verify` p95 951 ms (signature check, once
  per login). Server RSS peak 578 MB.
- Integrity: every user wrote unique markers (settings, watchlist token, Perps bot config). **0 lost, 0 seen by
  another user** — live, and again after restarting the server on the same database.

Deployment notes this surfaced: behind a reverse proxy set `TRUST_PROXY=true`, otherwise every user shares the
proxy's IP and the 600 req/min per-IP limit (and the 20/min sign-in limit) is shared by everyone.

### Same test on real PostgreSQL 17

`DATABASE_URL=… node scripts/loadtest-users.mjs --users=300 --duration=120` against PostgreSQL 17 (the
version in deploy/docker-compose.yml): **13,870 requests, 0 failed**; reads p95 ≤ 11 ms (discover p99 204 ms),
writes p95 ≤ 38 ms; 300/300 sockets; server RSS peak 349 MB; integrity 0 problems live and after restart.
The production build (NODE_ENV=production, bundled server, built web) was also started against it:
migrations applied, `/readyz` ok, SPA and CSP/HSTS headers served.
