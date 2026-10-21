# Product spec — Chog Toolhub

NFT-gated (Chog Genesis) desktop trading workstation: token terminal, token sniper, wallet tracker with copy
trading, NFT public-mint sniper, perpetuals points-farming control panel, portfolio with PnL calendar and
shareable PnL cards. Desktop/laptop only; phones get a dedicated notice.

## Principles (as implemented)

- **No Chog Toolhub commission** on swaps. Aggregator routes carrying an integrator fee are rejected. The UI still
  states that network gas, DEX/pool fees, aggregator costs and token taxes apply.
- **No fabricated data.** Every market value shows its provider and age; missing values render as "—"; stale data
  is flagged; estimates are labelled as estimates; FDV and market cap are shown separately.
- **Submitted ≠ successful.** Only server-side chain reconciliation marks a transaction confirmed.
- **User-controlled execution.** Signing keys stay on the user's device; every automation needs explicit enabling,
  limits, and runs only while the tab (or local agent) is running.

## Sections

| Section            | What it does                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Gate**           | EIP-6963 wallet picker → SIWE signature → on-chain Chog Genesis check. Clear errors for not-holder / RPC outage / rejection. Shows the gate contract with an explorer link.                                                                                                                                                                                                       |
| **Dashboard**      | Holder identity + last ownership check, portfolio estimate (marks unpriced assets), net realized PnL, tracked/copy counts, armed automations, balances, recent reconciled transactions, live tracker feed.                                                                                                                                                                        |
| **Token Terminal** | Search (symbol/name/address, network filter, virtualised), watchlist (server), recent (device). Token view: price, 5m/1h/24h change, liquidity, FDV vs market cap, volume, txns, pair age, pool selector, candles (1m–1D, live last-bar updates), recent pool trades, GoPlus risk scan, order panel (presets, slippage, priority where supported) with a full confirmation sheet. |
| **Token Sniper**   | Configs (alert or auto) with discovery filters (liquidity range, 5m volume, pool age, quote asset, name), execution (entry, max $, slippage, priority/deadline only where the chain supports them), tax limits, required scan, TP/SL. Live new-pool feed with matching badges, sniper log.                                                                                        |
| **Wallet Tracker** | Track public addresses per network with label/colour, enable toggle, notification categories, buy/sell/transfer filters, virtualised history + live events, explorer links, estimates labelled. Per-wallet copy trading (fixed or % sizing, per-trade/day caps, slippage, min liquidity, cooldown, allow/block lists, copy sells) with explicit acknowledgement.                  |
| **NFT Sniper**     | Public-mint tasks: contract inspection (code, name, symbol, supply), simple mint signature + args with `{quantity}`/`{recipient}`, unit price, hard total-spend cap, start time, attempts, priority. Simulates before start; submits only once simulation passes; never bypasses contract rules.                                                                                  |
| **Perps Farm**     | Modular platform cards (Perpl, Bulk), task configs (pair, direction, size, leverage, entry/exit type, offsets, hold/interval) with risk limits, lifecycle (start/pause/resume/stop) and logs via the paired local agent. Platforms report "awaiting software" until the user's software is integrated.                                                                            |
| **Portfolio**      | Trading-wallet addresses and balances, open positions (avg cost, value, unrealized), PnL calendar (user time zone, month/30d/all), summary, transaction history with chain states, PnL card generator (Chog reacts to the result, Flex/Classic art, 3 themes, privacy, stats, 1×/2× PNG, animated video).                                                                         |
| **Settings**       | Appearance (dark/light/system, accent, reduced motion, density, background incl. per-device custom image), trading defaults & presets, notifications (categories, sound, duration, position, time zone), risk limits, privacy & security (sessions, wallet, agent, emergency stop, reminders).                                                                                    |

## PnL methodology <a id="pnl"></a>

- Inputs: only **confirmed swaps** from the user's trading wallet, as reconciled from chain data.
- Cost basis: **weighted average** per (network, token), USD at fill time.
- Realized on sell = proceeds − avg cost × qty sold. Fees (network gas) are tracked separately and subtracted for
  "net realized".
- USD values = native leg (balance delta) × native price at reconciliation time (Dexscreener, third-party estimate).
- Unknown USD value ⇒ the position/day is marked **incomplete**; no value is guessed.
- Tokens that arrived by transfer have no cost basis; selling them realizes nothing for the untracked part.
- Deposits, withdrawals and transfers are never PnL.
- Days are bucketed in the user's IANA time zone (auto-detected, editable).

## Out of scope for this milestone

Mobile UI; limit orders on spot DEXs; mempool/launchpad bonding-curve sniping; perps execution (pending the user's
software); embedded-wallet provider integration; multi-instance deployment tooling.
