# Architecture

## Overview

```
                        ┌──────────────────────────── Browser (desktop) ────────────────────────────┐
  External wallet ───►  │  React SPA (Vite)                                                          │
  (MetaMask, Rabby…)    │   • SIWE sign-in (EIP-6963 discovery)                                      │
                        │   • Trading vault: keys generated + AES-GCM encrypted in IndexedDB         │
                        │   • Trade engine: KyberSwap / Jupiter → risk → simulate → sign → submit     │
                        │   • Automation runners (copy-trade, sniper, mint) — only while tab open     │
                        │     and vault unlocked                                                     │
                        └──────┬──────────────────────────────┬──────────────────────┬──────────────┘
                     same-origin HTTPS + WS          direct HTTPS (quotes, RPC)   http://127.0.0.1:47321
                               │                              │                      │
          ┌────────────────────▼───────────────────┐   ┌──────▼──────┐   ┌───────────▼──────────────┐
          │ API server (Fastify, Node 22+)          │   │ Aggregators │   │ Local agent (user's PC)   │
          │  • auth: SIWE + on-chain NFT gate       │   │ & RPCs      │   │  • loopback only, paired  │
          │  • sessions (hashed tokens, Postgres)   │   └─────────────┘   │  • typed commands only    │
          │  • market-data cache & fan-out (WS hub) │                     │  • farming adapters       │
          │  • tracker worker (shared polling)      │                     │    (awaiting software)    │
          │  • journal reconciler (chain = truth)   │                     └───────────────────────────┘
          │  • per-user data: settings, watchlist,  │
          │    tracked wallets, automations, logs   │──► Dexscreener · GeckoTerminal · GoPlus · RPCs
          └────────────────────┬────────────────────┘
                               │
                        PostgreSQL (PGlite embedded in dev/test)
```

## Repository layout

| Path              | Purpose                                                                                                                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared` | Network matrix, address validation (EVM checksum, base58), zod schemas (API contracts), risk engine, tx state machine, PnL math, formatting, market types. Pure, unit-tested, used by all apps. |
| `apps/server`     | Fastify API, Drizzle schema + migrations, auth, market providers, WS hub, tracker worker, reconciler.                                                                                           |
| `apps/web`        | React 19 SPA: design system, pages, vault, trade engine, automation runners, agent client.                                                                                                      |
| `apps/agent`      | Local execution agent (Node, no deps beyond zod): loopback HTTP control plane, task manager, adapter boundary.                                                                                  |
| `e2e`             | Playwright end-to-end tests (real Chromium, real server, real SIWE signatures).                                                                                                                 |
| `scripts`         | Load test, secret scanner.                                                                                                                                                                      |

## Key decisions

| Decision                                             | Why                                                                                                                                                                            |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Vite SPA instead of Next.js**                      | A wallet-holding trading terminal benefits from a strict CSP (`script-src 'self'`) and no SSR attack surface; no SEO needs. Route-level code splitting keeps first load small. |
| **Fastify + Drizzle + Postgres**                     | Mature, fast, typed SQL (parameterised by construction), first-class migrations. PGlite (WASM Postgres) runs the _same_ migrations in dev/tests so no Docker is needed.        |
| **viem** for EVM, **@solana/web3.js 1.x** for Solana | Maintained, audited-by-usage libraries; viem also provides SIWE parsing and ERC-1271 verification.                                                                             |
| **Non-custodial local vault** for the trading wallet | Satisfies "keys never on the server". No embedded-wallet credentials were available. Trade-offs in SECURITY.md.                                                                |
| **Automation runs client-side / local agent**        | Signing keys stay on the user's machine; the server never holds trading credentials. Consequence: automations run only while the tab is open & unlocked (stated in UI).        |
| **Server reconciles every transaction**              | The browser only reports a hash; state, fills and fees come from receipts / signature status.                                                                                  |
| **Shared polling + WS fan-out**                      | One upstream request per pair / network regardless of viewer count.                                                                                                            |
| **Adapters per chain family**                        | `kyberswap` (EVM) and `jupiter` (Solana) behind one `prepareSwap` interface; network matrix decides which.                                                                     |

## Data flow: a manual buy

1. Terminal loads pairs (server → Dexscreener, cached) and candles (server → GeckoTerminal, cached).
2. User clicks _Review buy_ → `prepareSwap`: GoPlus scan + native price + Kyber/Jupiter quote → risk engine.
3. Confirmation modal shows amounts, min-out, impact, gas, "Chog Toolhub fee $0", warnings, blocks.
4. _Sign & send_: router/fee/value/recipient checks → `eth_call` / `simulateTransaction` → sign with vault key →
   nonce-locked send → `POST /api/journal` (idempotency key, retried).
5. Reconciler: receipt / signature status → `confirmed|failed|replaced|expired|unknown`, token qty from Transfer
   logs or token balance deltas, native leg from balance diff, fee from gas → pushed to the user over WS.
6. Portfolio computes positions and daily PnL from reconciled fills only.

## Transaction states

`draft → simulating → awaiting_approval → signing → submitted → pending → confirmed|failed|expired|replaced|unknown`
(plus `simulation_failed`, `cancelled`). Transitions are enforced by `packages/shared/src/txState.ts`; invalid
transitions are rejected and logged.

## Scaling

- Single API process handles the measured workload (PERFORMANCE.md). For multiple instances:
  replace `TtlCache` and `@fastify/rate-limit`'s in-memory store with Redis; run the tracker and reconciler in a
  single dedicated worker (they are guarded against overlap in-process, not across processes); use a WS-aware
  load balancer with sticky sessions or a Redis pub/sub fan-out for `Hub.sendToUser`.
- Session cache (5 s) is per process — documented revocation lag across instances.
- Postgres: pool size `DB_POOL_MAX`, statement timeout 10 s, indexes on all per-user query paths.

## Local agent

See SECURITY.md §Local agent. Lifecycle: user starts `chog-agent` → it prints a one-time code → user pairs in
Perps Farm → web gets a 12 h token (sessionStorage) → typed commands. _Attended_ mode (default) pauses tasks
60 s after heartbeats stop (site closed); _persistent_ mode keeps tasks running until stopped in the agent.
