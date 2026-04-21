# 72h Trade Analysis (Server Data)

- Generated (KST): `2026-04-21 20:19:18`
- Window (UTC): `2026-04-18T11:08:44.037Z` ~ `2026-04-21T11:07:25.262Z`
- Source: `/Users/aicompany/Documents/github/funding-fee-program/data/remote-47.128.214.182/events-all-all.json`

## 1) Core Snapshot

- Executed pairs: **18**
- Realized PnL: **-55.2808 USD**
- Win rate: **50.00%**
- Funding / Price / Fee: `398.9178 / -403.4729 / 50.7256`
- Expected@execute sum: `120.6457`, prediction error sum: `-175.9265`
- Expected positive but loss: `9` pairs

## 2) Live Setting/State Check

- Scheduler active: `true`
- SIM snipe active: `true`, REAL snipe active: `false`
- Simulation mode: `true`
- Config: investment `250`, leverage `17`, minSpread `0.3%`
- Timing: entryLead `3500ms`, closeDelay `1000ms`
- confirmedSnipeConfig present: `false`, enabled toggles: `0`
- Equity (initial/current/net): `2000 / 1949.037427 / -50.962573`
- Equity return: `-2.548129%`

## 3) Failure Reasons

- Execute failed by reason:
  - `funding_window_shifted`: 45
  - `profitability_insufficient`: 31
  - `live_spread_reverted`: 24
  - `slippage_exceeded`: 7
  - `position_already_active`: 4
  - `orderbook_unavailable`: 3
  - `entry_gap_exceeded`: 2
- Execute failed with expectedNetProfit>0: `25` (sum `185.1807`)
- Guard block by reason:
  - `funding_window_shifted`: 45
  - `profitability_insufficient`: 31
  - `live_spread_reverted`: 24
  - `slippage_exceeded`: 7
  - `position_already_active`: 4
  - `orderbook_unavailable`: 3
  - `entry_gap_exceeded`: 2

## 4) Milestone Coverage

- `derived_1h`: 17/18
- `pre_30m`: 18/18
- `derived_15m`: 17/18
- `pre_10m`: 18/18
- `pre_5m`: 18/18
- `pre_3m`: 18/18
- `pre_1m`: 18/18
- `execute`: 18/18
- `execute_success`: 18/18
- `post_1m`: 17/18
- `post_3m`: 17/18
- `post_5m`: 17/18
- `post_10m`: 17/18
- `post_30m`: 17/18

## 5) Top/Worst Pairs

### Best
- `2026-04-20 16:59:44` `SUPER:bingx->bybit` pnl=`63.3261` expected@execute=`0.163837`
- `2026-04-20 07:59:37` `RAVE:bingx->binance` pnl=`32.8581` expected@execute=`4.232585`
- `2026-04-20 05:59:38` `RAVE:bingx->binance` pnl=`14.0362` expected@execute=`18.256226`
- `2026-04-21 15:59:59` `RAVE:bybit->binance` pnl=`5.6722` expected@execute=`1.258041`
- `2026-04-19 00:59:53` `API3:bingx->bybit` pnl=`2.3823` expected@execute=`3.934168`

### Worst
- `2026-04-19 04:59:40` `RAVE:bingx->bybit` pnl=`-78.1195` expected@execute=`33.755233`
- `2026-04-21 00:59:47` `SUPER:bingx->gate` pnl=`-55.5412` expected@execute=`9.173637`
- `2026-04-19 00:59:45` `SIREN:bingx->bybit` pnl=`-21.8963` expected@execute=`15.621606`
- `2026-04-20 08:59:41` `SOON:bingx->bybit` pnl=`-9.5929` expected@execute=`1.537102`
- `2026-04-20 00:59:40` `ENJ:bingx->bybit` pnl=`-4.0013` expected@execute=`4.418747`

## 6) Pair Table

| Entry(KST) | Route | Exp@1m | Exp@Execute | Realized | Error |
|---|---|---:|---:|---:|---:|
| 2026-04-19 00:59:37 | RAVE:bingx->bybit | 13.8014 | 22.6106 | -2.9439 | -25.5545 |
| 2026-04-19 00:59:45 | SIREN:bingx->bybit | 7.3079 | 15.6216 | -21.8963 | -37.5179 |
| 2026-04-19 00:59:53 | API3:bingx->bybit | 2.9809 | 3.9342 | 2.3823 | -1.5519 |
| 2026-04-19 02:59:45 | RAVE:bingx->binance | -2.9928 | 0.0692 | 0.3623 | 0.2930 |
| 2026-04-19 04:59:40 | RAVE:bingx->bybit | 27.7581 | 33.7552 | -78.1195 | -111.8747 |
| 2026-04-19 20:59:37 | RAVE:bingx->bybit | 1.4200 | 1.1851 | -1.5467 | -2.7318 |
| 2026-04-19 20:59:45 | GENIUS:bingx->bybit | -6.1383 | 0.8582 | -1.9938 | -2.8520 |
| 2026-04-20 00:59:40 | ENJ:bingx->bybit | -2.5128 | 4.4187 | -4.0013 | -8.4200 |
| 2026-04-20 01:00:13 | HIGH:bybit->gate | -1.8531 | 0.5852 | 1.1654 | 0.5801 |
| 2026-04-20 05:59:38 | RAVE:bingx->binance | 22.6188 | 18.2562 | 14.0362 | -4.2200 |
| 2026-04-20 07:59:37 | RAVE:bingx->binance | 11.9922 | 4.2326 | 32.8581 | 28.6255 |
| 2026-04-20 08:59:41 | SOON:bingx->bybit | -0.9981 | 1.5371 | -9.5929 | -11.1300 |
| 2026-04-20 09:00:54 | EWY:gate->binance | 2.2498 | 1.8634 | 1.6457 | -0.2177 |
| 2026-04-20 16:59:44 | SUPER:bingx->bybit | -13.6655 | 0.1638 | 63.3261 | 63.1622 |
| 2026-04-21 00:59:39 | PIEVERSE:bingx->bybit | -0.4177 | 0.7616 | -2.3723 | -3.1339 |
| 2026-04-21 00:59:47 | SUPER:bingx->gate | -2.6794 | 9.1736 | -55.5412 | -64.7149 |
| 2026-04-21 14:59:53 | RAVE:bybit->binance | 1.8020 | 0.3611 | 1.2788 | 0.9177 |
| 2026-04-21 15:59:59 | RAVE:bybit->binance | 7.4531 | 1.2580 | 5.6722 | 4.4141 |

