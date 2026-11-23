// BTC trend bot — ER regime + gate-tuned
//
// Long-only trend follower on CBBTC 1-minute bars (agent-fun/bars-replay/v1).
// It trades only when the market is actually trending, and it sizes for the
// tournament: a full-size round trip costs ~26 bps in fees, slippage and
// impact, so a trade has to catch a move bigger than that, and only the top
// 10 of thousands of entries are paid — so when the regime is right it goes
// in at 60% of equity instead of nibbling.
//
// Regime: the efficiency ratio over 60 bars (net move over total path —
// near 1 when price marches in one direction, near 0 when it chops) plus an
// 8/21 EMA cross. A 60-bar window is deliberate: a 360-bar ratio needs six
// hours before it can even fire, which misses most of a 24-hour window,
// while 60 bars responds within the hour and still filters chop.
// Entry is edge-triggered: only on the bar where the trend turns true, never
// a re-buy into a trend that already threw us out.
// Exit is a bracket, not a cross: a 3.5% trail stop off the peak close since
// entry caps the loss, and a +1.5% take-profit locks a leg in. The EMA
// cross-back is deliberately NOT an exit — it lags, and on this window it
// exits consolidations at a loss instead of letting the bracket work.
// Tilt is neutral for this race (no sizing or threshold shift, no
// directional bias), so the tilt constants sit at 1 / 0 / 0.
//
// Everything here is a pure function of the bars the harness sent: no
// clock, no environment, no randomness — the two grading runs must agree
// byte for byte.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// Chosen config: tuned on the official engine over the published dev
// window (2026-11-22, +3.59% over 1440 bars). The trail stop is the
// walk-forward default — the dev window cannot tell trail values apart.
const ER_WINDOW = 60; // bars spanned by the efficiency-ratio window
const ER_TREND_MIN = 0.14; // trend needs ER at or above this
const EMA_FAST_LEN = 8; // fast EMA length, in bars
const EMA_SLOW_LEN = 21; // slow EMA length, in bars
const BASE_FRACTION_BPS = 6000; // a buy spends 60% of equity
const TRAIL_STOP_BPS = 350; // exit 3.5% below the peak close since entry
const TAKE_PROFIT_BPS = 150; // exit 1.5% above the entry close
const MAX_SLIPPAGE_BPS = 500; // 5%: wide enough never to bind on 1-minute bars

// Scenario tilt (neutral for this race): size multiplier, ER threshold
// shift, and directional bias (+1 long-biased, 0 none, -1 would block buys).
const TILT_SIZE_MULT = 1.0;
const TILT_ER_OFFSET = 0.0;
const TILT_BIAS = 0;

// ------------------------------------------------------------------ indicators

// Simple mean of a slice of closes, used to seed each EMA once.
function sma(values: number[]): number {
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

// Efficiency ratio of the last ER_WINDOW moves: the net move over the total
// path. `window` holds ER_WINDOW + 1 closes, oldest first.
function efficiencyRatio(window: number[]): number {
  const move = Math.abs(window[window.length - 1]! - window[0]!);
  let path = 0;
  for (let i = 1; i < window.length; i++) {
    path += Math.abs(window[i]! - window[i - 1]!);
  }
  return path > 0 ? move / path : 0;
}

// ------------------------------------------------------------------ bot state

// Every close seen so far, oldest first. Only the last few hundred are
// ever read, but the array is tiny (1440 bars) so nothing is trimmed.
const closes: number[] = [];
let emaFast: number | null = null;
let emaSlow: number | null = null;
// Whether the trend was true on the previous batch (entry is edge-triggered).
let prevTrend = false;
// Peak close since the current entry; null while flat.
let peak: number | null = null;
// Close at the batch where the current entry was decided; null while flat.
let entryClose: number | null = null;

// ------------------------------------------------------------------ decisions

function onBatch(state: BarsState, _batch: Batch): OrderInput[] | void {
  // Orders decided on a warm-up batch are rejected, so decide nothing.
  if (state.warmingUp) return [];
  const bar = state.latest.get(SYMBOL);
  if (bar === undefined) return [];
  const close = Number(bar.c);
  closes.push(close);

  // Seed each EMA with the SMA of its first full window, then recurse.
  if (emaFast === null) {
    if (closes.length >= EMA_FAST_LEN) emaFast = sma(closes.slice(-EMA_FAST_LEN));
  } else {
    const k = 2 / (EMA_FAST_LEN + 1);
    emaFast = close * k + emaFast * (1 - k);
  }
  if (emaSlow === null) {
    if (closes.length >= EMA_SLOW_LEN) emaSlow = sma(closes.slice(-EMA_SLOW_LEN));
  } else {
    const k = 2 / (EMA_SLOW_LEN + 1);
    emaSlow = close * k + emaSlow * (1 - k);
  }

  // Efficiency ratio over the last ER_WINDOW moves, once enough closes exist.
  let er: number | null = null;
  if (closes.length >= ER_WINDOW + 1) {
    er = efficiencyRatio(closes.slice(-(ER_WINDOW + 1)));
  }

  // Trend needs a strong-enough ER and the fast EMA above the slow one.
  const trend =
    er !== null &&
    emaFast !== null &&
    emaSlow !== null &&
    er >= ER_TREND_MIN + TILT_ER_OFFSET &&
    emaFast > emaSlow;

  // Remember whether the trend was true, before the entry decision reads it.
  const wasTrend = prevTrend;
  prevTrend = trend;

  const held = state.positions.get(SYMBOL);
  const holding = held !== undefined && held.qty > 0n;

  if (!holding) {
    peak = null;
    entryClose = null;
    // Edge-triggered entry: only on the bar where the trend turns true.
    // A neutral bias (0) allows buys; a -1 bias would block them outright.
    if (trend && !wasTrend && TILT_BIAS >= 0) {
      const sizeBps = Math.round(BASE_FRACTION_BPS * TILT_SIZE_MULT);
      let notional = (state.equity * BigInt(sizeBps)) / 10000n;
      // Whole USDC only, and never above the weight room.
      notional = (notional / 1000000n) * 1000000n;
      const room = state.weightRoom(SYMBOL);
      if (notional > room) notional = (room / 1000000n) * 1000000n;
      if (notional >= 1000000n) {
        peak = close;
        entryClose = close;
        return [
          {
            side: 'buy',
            symbol: SYMBOL,
            notional_quote_units: notional,
            max_slippage_bps: MAX_SLIPPAGE_BPS,
          },
        ];
      }
    }
    return [];
  }

  // Holding: track the peak close, and exit on the trail stop or the
  // take-profit — whichever the bracket hits first.
  peak = peak === null ? close : Math.max(peak, close);
  const trailHit = peak !== null && close < peak * (1 - TRAIL_STOP_BPS / 10000);
  const takeProfit =
    entryClose !== null && close >= entryClose * (1 + TAKE_PROFIT_BPS / 10000);
  if (trailHit || takeProfit) {
    return [
      {
        side: 'sell',
        symbol: SYMBOL,
        qty: held.qty,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      },
    ];
  }
  return [];
}

await runBars({ onBatch });
