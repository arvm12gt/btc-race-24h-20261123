// Race bot for "Race a BTC trading bot live for 24 hours"
// (btc-race-24h-20261123-0511) — agent-fun/bars-replay/v1, TypeScript
// (Node 22, erasable syntax only), no dependencies beyond the vendored
// official shim in vendor/.
//
// Strategy, in one paragraph: this is a top-10-of-thousands tournament
// where the median finish pays zero, so the bot does not optimise
// risk-adjusted return. It stays flat in chop (fees + impact punish
// churn, and the dev gate punishes bleeding) and, once a trend regime is
// confirmed, deploys nearly the whole account on the breakout and rides
// it — sizing for the right tail — inside a hard internal drawdown
// circuit-breaker that keeps the official 25% drawdown bar far away.
//
// The position logic is a two-state machine (FLAT / LONG) with NO
// resizing: the size is snapshotted at entry and the position is held
// until an exit condition fires. Long-only (the harness forbids shorts
// and leverage). Fully deterministic: no randomness, no clock, no
// environment, no I/O beyond the protocol.

import { runBars, type Batch, type Hello, type OrderInput } from './vendor/makefun-bars.ts';

// ================================================================ CONFIG
// Every tunable lives here. Values come from walk-forward on historical
// 24h windows: tuned on the first half, reported untouched on the
// second half. Note the efficiency ratio on 1-minute bars lives on a
// small scale (median ~0.05-0.07, p90 ~0.13-0.18 depending on the
// window) — thresholds are set accordingly.
interface Config {
  ema_fast: number;
  ema_slow: number;
  er_window: number;
  er_trend_min: number;
  exit_buffer: number;
  vol_window: number;
  vol_pct_window: number;
  breakout_lookback: number;
  reentry_cooldown: number;
  base_fraction: number;
  min_strength: number;
  trail_stop: number;
  hard_stop: number;
  dd_soft: number;
  dd_hard: number;
  dd_soft_mult: number;
  window_bars: number;
  end_no_entry: number;
  end_flatten: number;
  max_slippage_bps: number;
  tilt_size_mult: number;
  tilt_er_offset: number;
  tilt_bias: number;
  tilt_bias_fraction: number;
}

const CONFIG: Config = {
  // --- regime detection -------------------------------------------
  ema_fast: 20, // fast EMA span, bars (1m bars -> 20 minutes)
  ema_slow: 120, // slow EMA span, bars (2 hours)
  er_window: 120, // efficiency-ratio lookback, bars (2 hours)
  er_trend_min: 0.18, // ER at/above this = trend regime — gate-tuned
  // for this race's dev window (2026-11-22, +3.59%) on the OFFICIAL
  // engine: the replay tuner's +$2.27 "PASS" for the 0.14 default was
  // poisoned by the replay-only float-qty artifact (a wedged sell
  // riding to the flatten), and the official grade of the default
  // is -$8.58. A 48-config official-engine grid (grade-local,
  // --driver process) ranks 0.18/0.60 first on the gate+retention
  // trade-off: official dev +$1.80, 7 trades, DD 1.3%, replay
  // retention 0.68 with >=1 trade in every trend window. The
  // higher-dev 0.26 configs (+$4.81) were rejected: retention 0.0,
  // zero trades in 2 of 5 historical trend windows — a bot that may
  // not trade at all on the race window fails the >=1-trade bar.
  exit_buffer: 0.7, // exit the trend when ER < er_trend_min *
  // this (hysteresis against boundary flips)
  vol_window: 120, // realised-vol lookback (1m log returns)
  vol_pct_window: 720, // history of vol readings for its percentile
  // --- entry -------------------------------------------------------
  breakout_lookback: 60, // Donchian high lookback for entries, bars
  reentry_cooldown: 30, // bars to wait after an exit before the
  // next entry (anti-whipsaw)
  // --- sizing ------------------------------------------------------
  base_fraction: 0.6, // equity fraction deployed at full strength
  // (gate-tuned: 0.60 with er 0.18 — see er_trend_min note)
  min_strength: 0.6, // at ER just above threshold, deploy this
  // share of full size; ramps to 1.0 as ER
  // rises 0.10 above the threshold
  // --- exits -------------------------------------------------------
  trail_stop: 0.035, // exit if close falls this far below the
  // highest close since entry — walk-forward default; the dev
  // window cannot distinguish 0.020/0.035/0.050/0.080 (identical
  // official PnL for every config), so the backtest value stands
  hard_stop: 0.06, // exit if close falls this far below entry
  // --- risk: drawdown circuit-breaker (official bar is 25%) --------
  dd_soft: 0.15, // equity DD from peak: next entries at 1/4
  dd_hard: 0.18, // equity DD from peak: go flat, halt trading
  dd_soft_mult: 0.25,
  // --- end of window ----------------------------------------------
  window_bars: 1440, // scored bars in this race series' windows
  end_no_entry: 20, // stop opening positions this many bars out
  end_flatten: 3, // flatten this many bars before the end
  // --- orders ------------------------------------------------------
  max_slippage_bps: 120, // per-order slippage cap vs the decided
  // close; covers the 2 bps modelled slippage,
  // ~10 bps of full-size impact, and gaps

  // --- scenario tilt (race-day call, 2026-11-23) -------------------
  // Trailing-6h read at build time (Coinbase BTC-USD 1m): ER(360)
  // 0.0253 (flat/choppy, far below the 0.09 trend line), realised
  // vol at the 38th percentile of its trailing 720 bars, 6h change
  // +0.59% after a +3.77% 24h drift. Mechanical rule (backtest
  // tilt_for): neutral — no trend persistence to chase, no hostile
  // high-vol chop to hide from. The regime machinery still runs;
  // the tilt only moves its knobs, and today it moves nothing.
  tilt_size_mult: 1.0,
  tilt_er_offset: 0.0,
  tilt_bias: 0, // 0 = neutral, no chop sleeve
  tilt_bias_fraction: 0.25, // chop-sleeve size when tilt_bias = +1
};
// ================================================================ /CONFIG

const BPS = 10_000;

/** A bounded FIFO of numbers with Python deque(maxlen) semantics. */
class Ring {
  private items: number[] = [];
  private readonly maxlen: number;
  constructor(maxlen: number) {
    this.maxlen = maxlen;
  }
  push(x: number): void {
    this.items.push(x);
    if (this.items.length > this.maxlen) this.items.shift();
  }
  get length(): number {
    return this.items.length;
  }
  /** Python-style indexing: negative counts back from the newest. */
  at(i: number): number {
    return this.items[i < 0 ? this.items.length + i : i]!;
  }
  toArray(): number[] {
    return this.items;
  }
  /** Sum oldest -> newest, the order Python's sum() visits a deque. */
  sum(): number {
    let s = 0;
    for (const x of this.items) s += x;
    return s;
  }
}

/** Python int(x) as a decimal string (truncation toward zero), exact. */
function intStr(x: number): string {
  return BigInt(Math.trunc(x)).toString();
}

class Bot {
  private readonly cfg: Config;
  private readonly symbol: string;
  private readonly priceScale: number;
  private readonly qtyScale: number;
  private readonly quoteScale: number;
  private readonly capital: number;
  private readonly warmupBars: number;
  private readonly minNotional: number;
  private readonly maxWeight: number;
  // indicator state
  private emaFast: number | null = null;
  private emaSlow: number | null = null;
  private readonly closes: Ring;
  private readonly absMoves: Ring;
  private readonly returns: Ring;
  private readonly volHist: Ring;
  private prevClose: number | null = null;
  // position/risk state (the FLAT/LONG state machine)
  private inPosition = false; // mirrors the account, for logic only
  private posKind: 'trend' | 'sleeve' | null = null;
  private toppedUp = false; // sleeve already upgraded to trend size
  private entryPrice: number | null = null;
  private peakSinceEntry: number | null = null;
  private cooldown = 0;
  private peakEquity: number;
  private halted = false;
  private scoredBars = 0;
  private cid = 0;

  constructor(hello: Hello, config?: Partial<Config>) {
    this.cfg = { ...CONFIG, ...(config ?? {}) };
    const cfg = this.cfg;
    const sym = hello.symbols[0]!;
    this.symbol = sym.symbol;
    this.priceScale = 10 ** sym.price_scale;
    this.qtyScale = 10 ** sym.qty_scale;
    this.quoteScale = 10 ** hello.capital.quote_scale;
    this.capital = Number(hello.capital.quote_units) / this.quoteScale;
    this.warmupBars = hello.warmup_bars ?? 0;
    this.minNotional = Number(hello.fees.min_notional_quote_units) / this.quoteScale;
    this.maxWeight = hello.caps.max_weight_bps / BPS;
    this.closes = new Ring(Math.max(cfg.er_window, cfg.breakout_lookback) + 2);
    this.absMoves = new Ring(cfg.er_window);
    this.returns = new Ring(cfg.vol_window);
    this.volHist = new Ring(cfg.vol_pct_window);
    this.peakEquity = this.capital;
  }

  // ------------------------------------------------------------ helpers
  private nextId(): string {
    this.cid += 1;
    return `o${this.cid}`;
  }

  private updateIndicators(close: number): void {
    const cfg = this.cfg;
    if (this.prevClose !== null) {
      this.absMoves.push(Math.abs(close - this.prevClose));
      if (this.prevClose > 0 && close > 0) {
        this.returns.push(Math.log(close / this.prevClose));
      }
    }
    this.prevClose = close;
    this.closes.push(close);
    const kf = 2.0 / (cfg.ema_fast + 1);
    const ks = 2.0 / (cfg.ema_slow + 1);
    this.emaFast = this.emaFast === null ? close : this.emaFast + kf * (close - this.emaFast);
    this.emaSlow = this.emaSlow === null ? close : this.emaSlow + ks * (close - this.emaSlow);
    if (this.returns.length >= 30) {
      const m = this.returns.sum() / this.returns.length;
      let varSum = 0;
      for (const r of this.returns.toArray()) varSum += (r - m) ** 2;
      this.volHist.push(Math.sqrt(varSum / this.returns.length));
    }
  }

  private efficiencyRatio(): number | null {
    const w = this.cfg.er_window;
    if (this.closes.length <= w || this.absMoves.length < w) return null;
    const path = this.absMoves.sum();
    if (path <= 0) return 0.0;
    return Math.abs(this.closes.at(-1) - this.closes.at(-1 - w)) / path;
  }

  // ------------------------------------------------------------ main
  onBatch(batch: Batch): OrderInput[] {
    try {
      return this.innerOnBatch(batch);
    } catch {
      return []; // a crashed reply fails the run; an empty one only loses a minute
    }
  }

  private innerOnBatch(batch: Batch): OrderInput[] {
    const cfg = this.cfg;
    const seq = batch.seq;
    let bar: Batch['bars'][number] | undefined;
    for (const b of batch.bars) {
      if (b.symbol === this.symbol) bar = b;
    }
    if (bar === undefined) return [];
    const close = Number(bar.c) / this.priceScale;
    this.updateIndicators(close);

    const account = batch.account;
    const cash = Number(account.cash_quote_units) / this.quoteScale;
    const equity = Number(account.equity_quote_units) / this.quoteScale;
    let qty = 0.0;
    let cost = 0.0;
    for (const p of account.positions) {
      if (p.symbol === this.symbol) {
        qty = Number(p.qty) / this.qtyScale;
        cost = Number(p.cost_quote_units) / this.quoteScale;
      }
    }

    if (seq >= this.warmupBars) this.scoredBars += 1;
    if (equity > this.peakEquity) this.peakEquity = equity;
    const dd = this.peakEquity > 0 ? (this.peakEquity - equity) / this.peakEquity : 0.0;
    if (this.cooldown > 0) this.cooldown -= 1;

    // sync the state machine with the account (fills land a bar late)
    if (qty > 0 && !this.inPosition) {
      this.inPosition = true;
      this.entryPrice = qty > 0 ? cost / qty : close;
      this.peakSinceEntry = close;
    } else if (qty > 0) {
      if (this.peakSinceEntry !== null && close > this.peakSinceEntry) {
        this.peakSinceEntry = close;
      }
    } else if (this.inPosition) {
      this.inPosition = false;
      this.posKind = null;
      this.toppedUp = false;
      this.entryPrice = null;
      this.peakSinceEntry = null;
      this.cooldown = cfg.reentry_cooldown;
    }

    if (seq < this.warmupBars) return []; // orders here are rejected (warmup) anyway

    const sellAll = (): OrderInput[] => [{
      side: 'sell',
      client_id: this.nextId(),
      symbol: this.symbol,
      qty: intStr(qty * this.qtyScale),
      max_slippage_bps: cfg.max_slippage_bps,
    }];

    const buy = (notional: number): OrderInput[] => [{
      side: 'buy',
      client_id: this.nextId(),
      symbol: this.symbol,
      notional_quote_units: intStr(notional * this.quoteScale),
      max_slippage_bps: cfg.max_slippage_bps,
    }];

    // --- risk overrides ------------------------------------------
    if (dd >= cfg.dd_hard) this.halted = true;
    if (this.halted) return qty > 0 ? sellAll() : [];

    const barsLeft = cfg.window_bars - this.scoredBars;
    if (qty > 0 && barsLeft <= cfg.end_flatten) return sellAll();

    // --- regime -----------------------------------------------------
    const er = this.efficiencyRatio();
    if (er === null) return []; // indicators not ready yet
    let erMin = cfg.er_trend_min + cfg.tilt_er_offset;
    if (cfg.tilt_bias === -1) erMin += 0.03;
    const uptrend = this.emaFast! > this.emaSlow!;
    const inTrend = er >= erMin && uptrend;

    let sizeMult = cfg.tilt_size_mult * (dd >= cfg.dd_soft ? cfg.dd_soft_mult : 1.0);
    if (cfg.tilt_bias === -1) sizeMult *= 0.8;

    // --- LONG: hold, exit only on a real exit condition -------------
    if (qty > 0) {
      if (this.entryPrice && close <= this.entryPrice * (1 - cfg.hard_stop)) {
        return sellAll();
      }
      if (this.peakSinceEntry && close <= this.peakSinceEntry * (1 - cfg.trail_stop)) {
        return sellAll();
      }
      if (this.posKind === 'trend') {
        // regime exit needs BOTH signals gone: either one alone
        // is mostly pullback noise on 1-minute bars
        if (er < erMin * cfg.exit_buffer && !uptrend) return sellAll();
      } else if (this.posKind === 'sleeve') {
        if (!uptrend) return sellAll();
        if (inTrend && !this.toppedUp) {
          // upgrade the sleeve to full trend size, once
          const strength = cfg.min_strength + (1 - cfg.min_strength) * Math.min(1.0, (er - erMin) / 0.10);
          const targetValue = Math.min(cfg.base_fraction * strength * sizeMult, this.maxWeight) * equity;
          const gap = targetValue - qty * close;
          if (gap >= this.minNotional) {
            this.toppedUp = true;
            this.posKind = 'trend';
            return buy(Math.min(gap, cash));
          }
        }
      }
      return [];
    }

    // --- FLAT: entries ------------------------------------------------
    if (this.halted || this.cooldown > 0 || barsLeft <= cfg.end_no_entry) return [];
    if (inTrend) {
      // a strong regime enters on the regime alone; a marginal one
      // must also break the Donchian high (late, confirmed entries
      // at marginal strength were pure cost in the backtest)
      const closesArr = this.closes.toArray();
      const look = closesArr.slice(
        Math.max(0, closesArr.length - (cfg.breakout_lookback + 1)),
        closesArr.length - 1,
      );
      const strong = er >= erMin + 0.08;
      if (strong || (look.length > 0 && close >= Math.max(...look))) {
        const strength = cfg.min_strength + (1 - cfg.min_strength) * Math.min(1.0, (er - erMin) / 0.10);
        const frac = Math.min(cfg.base_fraction * strength * sizeMult, this.maxWeight);
        const notional = Math.min(frac * equity, cash);
        if (notional >= this.minNotional) {
          this.posKind = 'trend';
          return buy(notional);
        }
      }
      return [];
    }
    if (cfg.tilt_bias === 1 && uptrend) {
      // chop sleeve: a small long while the drift is up
      const notional = Math.min(cfg.tilt_bias_fraction * sizeMult * equity, cash);
      if (notional >= this.minNotional) {
        this.posKind = 'sleeve';
        return buy(notional);
      }
    }
    return [];
  }
}

// ================================================================ wire loop
// The vendored official shim owns the wire: hello once, one reply per
// batch echoing seq, done ends the run.

let bot: Bot | null = null;

await runBars({
  onHello(state) {
    bot = new Bot(state.hello);
  },
  onBatch(_state, batch) {
    return bot === null ? [] : bot.onBatch(batch);
  },
});
