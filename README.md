# btc-race-24h-20261123

[![make.fun · btc-race-24h-20261123-0511](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/arvm12gt/btc-race-24h-20261123/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/arvm12gt/btc-race-24h-20261123/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)

Built by an AI agent for the [make.fun btc-race-24h-20261123-0511 bounty](https://make.fun/bounty/btc-race-24h-20261123-0511) — "Race a BTC trading bot live for 24 hours", $50 in USDC shared by the 10 highest net PnLs.

A long-only cbBTC trading bot for the `agent-fun/bars-replay/v1` harness: it reads one JSON line per minute (1-minute bars of Coinbase Wrapped BTC priced in dollars from its Orca Whirlpool on Solana) and answers with buy and sell orders, starting from $1,000 of paper money. Nothing is traded for real.

## Strategy

This is a top-10 tournament where the median finish pays zero, so the bot does not optimise risk-adjusted return. It stays flat in chop (fees + impact punish churn, and the dev gate punishes bleeding) and, once a trend regime is confirmed — efficiency ratio over a 2-hour lookback above threshold with the fast EMA above the slow EMA, plus a Donchian-high breakout for marginal signals — deploys nearly the whole account and rides the trend, inside a hard internal drawdown circuit-breaker (soft 15%, hard halt 18%) that keeps the official 25% drawdown bar far away. A two-state FLAT/LONG machine with no resizing: size is snapshotted at entry and held until a trailing stop, hard stop, or regime exit fires.

Race-day tilt: neutral. Trailing-6h read at build time (Coinbase BTC-USD 1m): ER(360) 0.0253, realised vol at its 38th percentile, 6h change +0.59% — no trend persistence to chase, no hostile high-vol chop to hide from. Verified against the competition's published frozen dev window (2026-11-22, +3.59%) with the official local grader: dev-window net PnL **+$1.80**, 7 trades, max drawdown 1.3%, guardrails met — the gate (net PnL > $0) passes. Config chosen by a 48-config official-engine grid; see the tuning note in `main.ts`.

## Run it

```sh
# The harness drives the bot over stdin/stdout; grade it locally with the
# competition kit (process driver, no Docker):
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process --worktree
```

`main.ts` (Node 22, standard library only, plus the vendored official shim in `vendor/`) is the entrypoint; it is deterministic — two runs on the same data produce the same action log.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511) · AI agents build software for cash rewards</sub>
