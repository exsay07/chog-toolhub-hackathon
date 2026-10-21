# Implementation plan & checklist

Status legend: ✅ done & verified by tests · 🟡 implemented, not verified against the real thing (reason given) ·
⛔ blocked (reason) · ⬜ not started.

## Phase 1 — Foundation

| Item                       | Acceptance criteria                                                                                             | Status                                                              |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Repo audit                 | Empty repo except the product brief; toolchain inventoried (Node 24, npm 12, Python; no Docker/Postgres/Redis). | ✅                                                                  |
| Monorepo + strict TS       | `npm run typecheck` passes for shared/server/web/agent with `strict`, `noUncheckedIndexedAccess`.               | ✅                                                                  |
| Lint/format                | `npm run lint` clean (typescript-eslint, react-hooks, `no-eval`…).                                              | ✅                                                                  |
| Design tokens, both themes | Semantic tokens; dark "Terminal" + light "Studio"; accents; reduced motion; density.                            | ✅ (E2E: theme persists)                                            |
| App shell + navigation     | Sidebar (8 sections), top bar (status, wallet, theme, account), emergency stop.                                 | ✅ (E2E: all sections)                                              |
| Desktop-only notice        | Phones get full-screen notice, terminal not rendered; background replaceable via `src/brand.ts`.                | ✅ (E2E at 390×844; no overflow at 1280×720 / 1440×900 / 1920×1080) |
| Config validation          | zod env schema; production refuses unsafe settings.                                                             | ✅ (unit)                                                           |
| CI                         | lint, typecheck, tests, build, audit, secret scans, e2e.                                                        | 🟡 workflow written; not executed on GitHub (no remote)             |

## Phase 2 — Auth & wallet foundation

| Item           | Acceptance criteria                                                                                                      | Status                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| Wallet connect | EIP-6963 discovery + legacy fallback.                                                                                    | ✅ (E2E with injected test wallet)                             |
| SIWE           | Nonce single-use, domain/URI/statement/expiry checks, replay rejected, wrong signer rejected.                            | ✅ (12 unit/integration tests, real secp256k1)                 |
| NFT gate       | Real on-chain check of the verified Chog Genesis contract; fail-closed; revoke on sale; grace on outage.                 | ✅ (live test recognises a real holder; unit tests for policy) |
| Sessions       | Hashed tokens, HttpOnly/Strict, revoke, list, cache with eviction.                                                       | ✅                                                             |
| Trading vault  | Generate/import, mandatory backup, PBKDF2+AES-GCM, auto-lock, export with password, server stores public addresses only. | ✅ (crypto unit tests; E2E create flow)                        |
| Network matrix | Documented and encoded (`packages/shared/src/networks.ts`).                                                              | ✅                                                             |

## Phase 3 — Trading terminal

| Item                        | Acceptance criteria                                                                         | Status                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Search / watchlist / recent | Real Dexscreener data; address searches exact-match; watchlist persisted.                   | ✅ (E2E live search)                                                                          |
| Token view + charts         | Real GeckoTerminal OHLCV, incremental live bar; trades; GoPlus scan; freshness labels.      | ✅ (live integration tests)                                                                   |
| Swap engine EVM             | Kyber quote → risk → approve-exact → build → validate → simulate → sign → submit → journal. | 🟡 quotes/route/router verified live; **no real-funds swap executed** (no funded test wallet) |
| Swap engine Solana          | Jupiter quote → validate tx → simulate → sign → submit → journal.                           | 🟡 quote verified live; no real-funds swap                                                    |
| Reconciliation              | Server derives state, qty, native leg, fee from chain.                                      | ✅ (live test on a real Monad swap tx)                                                        |

## Phase 4 — Sniping & tracking

| Item           | Acceptance criteria                                                                                       | Status                                                                                                                            |
| -------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Wallet tracker | EVM log polling + Solana signature polling, classification, de-dupe, per-user delivery, filters, history. | ✅ classification unit tests; 🟡 end-to-end live detection not observed in tests (needs a tracked wallet trading during the test) |
| Notifications  | Categories, sound, duration, position, explorer links, estimate labelling.                                | ✅ (settings persistence E2E)                                                                                                     |
| Copy trading   | Per-wallet config, limits tighten global ones, cooldown, de-dupe, event age limit, kill switch, logs.     | 🟡 logic implemented; execution path = engine (unverified with funds)                                                             |
| Token sniper   | Configs, filters (unit-testable `poolMatches`), alert & auto modes, TP/SL, logs.                          | ✅ alert mode (E2E arm); 🟡 auto-buy (no funds)                                                                                   |
| NFT mint       | Inspect, simulate, schedule, spend cap, attempts, journal.                                                | 🟡 no live public mint to test against                                                                                            |

## Phase 5 — Profile & Perps Farm

| Item                           | Acceptance criteria                                                       | Status                                                                             |
| ------------------------------ | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Portfolio, balances, positions | Real RPC balances; positions from reconciled fills.                       | ✅ API; empty-state verified (no funded wallet)                                    |
| PnL calendar                   | Time-zone buckets, incomplete marking, summaries, ranges.                 | ✅ (unit tests for math)                                                           |
| PnL cards                      | Canvas = preview = export, PNG 1200×675 / 2400×1350, Chog moods, privacy. | ✅ (E2E checks PNG header + size)                                                  |
| Perps UI + config + risk       | Cards, forms, validation, lifecycle buttons, logs.                        | ✅ UI/config (E2E); ⛔ execution — awaiting user's software (and Bulk API was 504) |
| Local agent                    | Loopback, pairing, typed commands, isolation, attended/persistent, logs.  | ✅ (9 integration tests, netstat bind check)                                       |

## Phase 6 — Hardening

| Item                                                                        | Status                                                                    |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Load test (autocannon + 1000 WS)                                            | ✅ see PERFORMANCE.md (PGlite; Postgres run pending)                      |
| Security scans (npm audit, semgrep, secret scan) + fixes + regression tests | ✅ see SECURITY_AUDIT.md                                                  |
| Accessibility pass                                                          | 🟡 labels/roles/focus rings/reduced motion done; no automated axe run yet |
| Failure injection                                                           | 🟡 RPC-down (gate), provider 429 (stale serve) tested; no chaos suite     |

## Next milestones (prioritised)

1. **M7 — Perpl/Bulk software integration** (needs your files): review → adapter via `spawnIsolated` → concurrency tests.
2. **M8 — Funded testnet/mainnet canary**: execute one tiny swap per network with a dedicated canary wallet to move
   networks from _implemented-unverified_ to _verified_; same for approve/sell and a public mint.
3. **M9 — Wallet custody upgrade**: embedded MPC wallet with server policies, or trading key in the desktop agent.
4. **M10 — Production infra**: Postgres + Redis, dedicated worker process, paid RPCs and CoinGecko Pro key,
   Postgres load test, signed agent releases, external pen-test.
