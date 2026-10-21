# Integrations & network capability matrix

Everything below was checked against a live endpoint or official documentation on **2026-10-19**.
"Verified" in the evidence column means we called it ourselves (see `apps/server/test/live.integration.test.ts`,
run with internet; skipped with `OFFLINE=1`).

## Network capability matrix

|                    | Monad                                                | BNB Smart Chain                         | Base                           | Robinhood Chain                                                        | Solana                                                  |
| ------------------ | ---------------------------------------------------- | --------------------------------------- | ------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------- |
| Canonical id       | EVM chain **143** (`eth_chainId` → `0x8f`, verified) | EVM chain **56**                        | EVM chain **8453**             | EVM chain **4663** (`0x1237`, verified)                                | `mainnet-beta`                                          |
| Status             | Mainnet                                              | Mainnet                                 | Mainnet (OP-stack L2)          | Mainnet (Arbitrum-Orbit L2)                                            | Mainnet                                                 |
| Native asset       | MON (18)                                             | BNB (18)                                | ETH (18)                       | ETH (18)                                                               | SOL (9)                                                 |
| Wrapped native     | WMON `0x3bd3…433A` (verified `symbol()`)             | WBNB `0xbb4C…095c`                      | WETH `0x4200…0006`             | WETH `0x0Bd7…AD73` (from Dexscreener pairs)                            | wSOL `So11…1112`                                        |
| Wallets            | Injected EIP-1193 (auth) · local vault (trading)     | same                                    | same                           | same                                                                   | local vault (ed25519)                                   |
| Default RPC        | `rpc.monad.xyz`, `rpc3.monad.xyz` (15–25 rps public) | `bsc-dataseed.bnbchain.org`, publicnode | `mainnet.base.org`, publicnode | `rpc.mainnet.chain.robinhood.com` (rate-limited, "not for production") | `api.mainnet-beta.solana.com` (heavily rate-limited)    |
| Indexing           | `eth_getLogs` (100-block window)                     | `eth_getLogs` (50)                      | `eth_getLogs` (500)            | `eth_getLogs` (500)                                                    | `getSignaturesForAddress` + `getTransaction`            |
| DEX aggregator     | KyberSwap (`/monad`, verified route + router)        | KyberSwap (`/bsc`, verified)            | KyberSwap (`/base`, verified)  | KyberSwap path recognised, **no route found** for tested tokens        | Jupiter Swap API v1 (`lite-api.jup.ag`, verified quote) |
| Simulation         | `eth_call` + `eth_estimateGas`                       | same                                    | same                           | same                                                                   | `simulateTransaction`                                   |
| Market data        | Dexscreener (`monad`), GeckoTerminal (`monad`)       | Dexscreener / GeckoTerminal (`bsc`)     | (`base`)                       | Dexscreener / GeckoTerminal (`robinhood`, verified)                    | (`solana`)                                              |
| Token security     | GoPlus chain `143` (verified)                        | `56`                                    | `8453`                         | `4663` (listed by GoPlus)                                              | GoPlus Solana endpoint                                  |
| Finality used      | receipt status (single-slot finality)                | receipt status                          | L2 receipt (soft)              | L2 receipt (soft)                                                      | `confirmed` signature status                            |
| **Trading status** | implemented-unverified                               | implemented-unverified                  | implemented-unverified         | **data-only**                                                          | implemented-unverified                                  |

### Chains added 2026-10-20 (Axiom's memecoin set)

|                    | Ethereum                                     | Arc (Circle)                                                    | Ink (Kraken)                             | HyperEVM (Hyperliquid)                |
| ------------------ | -------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------- | ------------------------------------- |
| Canonical id       | EVM chain **1**                              | EVM chain **5042** (`0x13b2`, verified on `rpc.mainnet.arc.io`) | EVM chain **57073** (`0xdef1`, verified) | EVM chain **999** (`0x3e7`, verified) |
| Native asset       | ETH (18)                                     | **USDC** as gas (18 native; ERC-20 view `0x3600…0000` has 6)    | ETH (18)                                 | HYPE (18)                             |
| Wrapped / pricing  | WETH `0xC02a…6Cc2`                           | USDC `0x3600…0000` (`symbol()` = USDC, verified)                | WETH `0x4200…0006`                       | WHYPE `0x5555…5555`                   |
| Default RPC        | publicnode, 1rpc                             | `rpc.mainnet.arc.io`                                            | `rpc-gel.inkonchain.com`, `rpc-qnd…`     | `rpc.hyperliquid.xyz/evm`             |
| Market data        | Dexscreener `ethereum` · GeckoTerminal `eth` | Dexscreener / GeckoTerminal `arc` (verified pools)              | `ink` (verified)                         | `hyperevm` (verified)                 |
| DEX aggregator     | KyberSwap `/ethereum` (live quote ✓)         | KyberSwap `/arc` (live quote ✓, Uniswap v3/v4)                  | **none** — KyberSwap `/ink` → 404        | KyberSwap `/hyperevm` (live quote ✓)  |
| Explorer           | Etherscan                                    | `explorer.arc.io`                                               | `explorer.inkonchain.com` (Blockscout)   | HyperEVMScan                          |
| **Trading status** | implemented-unverified                       | implemented-unverified                                          | **data-only**                            | implemented-unverified                |

**Trading status meanings** — _verified_: full critical path executed with real funds by us (none yet).
_implemented-unverified_: quote → risk → simulate → sign → submit → server reconciliation is implemented against the
real aggregator and quotes were verified live, **but no real-funds swap has been executed** (we hold no keys/funds and
must not use the user's). _data-only_: market data + wallet tracking, trading disabled in UI and engine.

**"Robinhood" clarification.** The requested "Robinhood" network is **Robinhood Chain**, Robinhood's
Arbitrum-Orbit EVM L2 (mainnet chain id 4663, testnet 46630; docs at `docs.robinhood.com/chain`). It is _not_ the
Robinhood brokerage app. Trading stays disabled until an aggregator returns routes there.

## Chog Genesis (NFT gate)

| Item                         | Value                                           | Evidence                                                                                                                                                                                                                                       |
| ---------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chain                        | Monad mainnet (143)                             | `eth_chainId` on `rpc.monad.xyz`                                                                                                                                                                                                               |
| Contract                     | `0xc96d31f8626c6d03fae5dcd3d61e3fb9f4a73763`    | `name()` = "Chog Genesis", `symbol()` = "CHOG", `totalSupply()` = 1969, `supportsInterface(0x80ac58cd)` = true (ERC-721)                                                                                                                       |
| Holder check                 | `balanceOf(owner) > 0` read directly from chain | live test: owner of token #1 recognised; `0x…dEaD` rejected                                                                                                                                                                                    |
| Multiple / bridged contracts | none found                                      | OpenSea page did not expose the address to our fetcher; identity established on-chain (name, symbol, supply = 1969 matches public collection size). **Recommend a one-time manual confirmation on the OpenSea collection page before launch.** |

## Providers

| Provider             | Used for                                   | Auth                              | Limits / notes                                                                                                        |
| -------------------- | ------------------------------------------ | --------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Dexscreener API      | search, token pairs, pair snapshot, prices | none                              | ~300 req/min; we token-bucket at 4 rps burst 20 and cache 5–30 s                                                      |
| GeckoTerminal API v2 | OHLCV, pool trades, new pools              | none (optional CoinGecko Pro key) | **30 req/min public** — hit 429 during testing; cache + queue + stale-serve. Production needs `COINGECKO_PRO_API_KEY` |
| GoPlus Security      | honeypot, taxes, owner privileges, holders | none                              | rate-limited; cached 5 min. Heuristic, third-party                                                                    |
| KyberSwap Aggregator | EVM quotes + calldata                      | `x-client-id` header              | router allow-list `0x6131…37b5` (identical on Monad/Base/BSC); any `extraFee` is rejected                             |
| Jupiter Swap API v1  | Solana quotes + transactions               | none (lite)                       | `platformFee` must be null; tx validated (fee payer, single signer, Jupiter program) before signing                   |
| Public RPCs          | chain reads, receipts, balances, logs      | none                              | rate-limited; configure `RPC_*` for production                                                                        |

## NFT: Top Collections and Mint Tracker

- **Top Collections** — OpenSea API v2 (`OPENSEA_API_KEY`): `/collections/top?chains=…&sort_by=…` for
  the ranking, then per collection `/stats` (floor, 24h/7d volume and sales, owners),
  `/floor_prices?timeframe=one_day` (24h floor change = first vs last point) and `/collections/{slug}`
  (supply). The free key allows ~60 requests/min, so the server enriches rows in rank order through
  one token bucket, caches them (stats 10 min, details 12 h) and the page fills in progressively.
  Chains: `monad`, `base`, `robinhood`. Without a key the page shows setup instructions.
- **Mint Tracker** — on-chain, no key: `eth_getLogs` for `Transfer(0x0 → to, tokenId)` (4 topics =
  ERC-721) following the head of Monad (100-block limit on the public RPC), Base (`base.drpc.org`;
  the official and publicnode RPCs refuse address-less log scans) and Robinhood Chain; the last hour is
  backfilled on start. RATE = mints per 10 min / hour; AIR = most mints come from transactions that
  send to ≥ 5 wallets; SUS = thin wallet spread (e.g. ≥ 10 mints from ≤ 2 wallets, or one wallet
  ≥ 60 %). DeFi LP-position NFTs (Uniswap/Aerodrome/Pancake/Ramses positions) are filtered out.
  Names/supply come from the contract; OpenSea links from the keyless contract lookup (socials and
  "verified" need the key). "Upcoming" mints and mint stage/price are not on-chain and not shown.

## Token terminal data flow (Dexscreener-first)

The terminal (Axiom / basedbot-style) has **Discover**, **Pulse**, **Watchlist** and the token page under one
toolbar (search, chain filter, per-chain quick-buy amounts, trading wallet — the wallet button exists only here).

- **Discover** (`GET /api/discover?networks=&view=trending|top&tf=5m|1h|6h|24h`): ranking per chain from
  GeckoTerminal (`/networks/{id}/trending_pools?duration=…` or `/pools?sort=h24_volume_usd_desc`, cached
  2–3 min, served stale-while-revalidate), rows refreshed from Dexscreener in **one batch call per list**
  (`/latest/dex/pairs/{chain}/{a,b,…}`, ≤ 30, cached 6 s) — which also brings logos and project links.
  Chains are merged round-robin; stables / wrapped natives / majors are filtered out. The server answers within
  ~3.5 s with whatever is ready; chains still queued under GeckoTerminal's free limit (~30/min, shared per IP)
  appear on the next poll. A `COINGECKO_PRO_API_KEY` removes that bottleneck. The server keeps the default
  Discover view and Pulse **warm** for every chain (`DISCOVER_WARM`, ~9 GeckoTerminal calls/min; a 429 pauses the client for 60 s while cached lists are served), the app
  prefetches both feeds and the terminal's code right after sign-in, the last answers are kept in
  localStorage for an instant first paint, and the table / Pulse columns are virtualized (only on-screen rows
  are in the DOM): opening the terminal measured 31–161 ms in a production build (was ~5 s).
- **Pulse** (`GET /api/discover/pulse`): newest pools (`new_pools`, 60 s) + 5-minute trending (2 min), live
  numbers from Dexscreener. Columns are computed in the browser: _New pairs_ (newest first, pools under $100
  liquidity hidden), _Heating up_ (< 24 h old with ≥ 40 trades or ≥ $10K volume in the last hour), _Trending_.
- **Watchlist** (`GET /api/discover/tokens?network=&tokens=`): best-liquidity pair per starred / recent token.
- **Quick buy** (⚡ on every row): the per-chain amount from the toolbar, through the same `prepareSwap` path as
  the order panel (quote → simulate → risk). Executes in one click only when the risk check raised nothing and
  "Confirm every trade" is off; otherwise the review dialog opens. Without an unlocked wallet it opens the wallet.

- **Search** groups Dexscreener pool results into one row per token (summed liquidity/volume, pool count, best
  pool). A pasted **token address** is resolved via `/latest/dex/tokens/{address}` (all chains); a pasted **pair
  address** via search. If it resolves to a single chain, the token page opens immediately with that pool.
- **Token page** lists every pool (`/token-pairs/v1/{chain}/{token}`) — click to switch.
- **Chart & trades** default to Dexscreener's official embed (`dexscreener.com/{chain}/{pair}?embed=1…`, sandboxed
  iframe, allowed by CSP `frame-src`). It covers every pool Dexscreener indexes and uses none of our GeckoTerminal
  quota. "Native" mode keeps the GeckoTerminal-fed chart and trades table.

## Perpetuals platforms (Perps Farm)

| Platform          | What we verified                                                                                                                                                                                                                                                                     | Integration status                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Perpl** (Monad) | Official Rust SDK `perpl-sdk` 0.2.x + `perpl-cli` (github.com/PerplFoundation/dex-sdk, MIT): on-chain exchange state cache, order builders, mainnet/testnet chains. No REST API documented.                                                                                          | **Awaiting your software.** Agent adapter registered as unavailable; UI, config, risk limits, lifecycle and logs are built. No orders are sent. |
| **Bulk**          | Docs at docs.bulk.trade: REST `https://mainnet-api1.bulk.trade/api/v1`, WS `wss://mainnet-ws1.bulk.trade`, testnet `exchange-api.bulk.trade`; Ed25519-signed, replay-protected orders; market/limit + TP/SL; agent wallets. `GET /exchangeInfo` returned **HTTP 504** on 2026-10-19. | **Awaiting your software** and a reachable API. Same boundary as Perpl.                                                                         |

Points/rewards: neither platform exposes a verified points API we could find → UI says "no verified data source yet".

## Not integrated (and why)

- **Embedded-wallet providers** (Privy, Turnkey, Dynamic…): need an account + API keys. The vault is a local,
  non-custodial alternative; see SECURITY.md for the trade-off and the recommended migration path.
- **Mempool / launchpad-level sniping** (nad.fun bonding curves, pump.fun, private RPC/bundles): would need
  dedicated infrastructure and per-launchpad contract review. Current discovery = GeckoTerminal new pools.
- **Redis**: not required for a single instance; the cache/rate-limit interfaces are where it plugs in for scale-out.
