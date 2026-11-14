// btc-cent-forecast-01 entry (Node 22, standard library only): a two-leg ensemble
// around persistence, forecasting BTC's price 240 minutes after each checkpoint.
//
//   guess = (legA + legB) / 2, clamped to the grid and the scorer's bounds, where
//     legA = last + 0.1 * slope(1440) * 240   (24h least-squares trend, shrunk 90%)
//     legB = last + 0.05 * (mean(720) - last) (pull toward the 12h average, 5%)
//
// Why this, and why so small: the honest finding of the backtest is that 4h-ahead
// BTC is a martingale at this horizon. On 60 days of Binance BTCUSDT 1-minute
// closes (343 cases, 72h windows cut 4h apart, scored exactly as the competition
// scores: 100 x mean |guess - actual|), the lag-1 autocorrelation of non-overlapping
// 240-minute log returns is +0.013 (n = 361) - zero for all practical purposes.
// Trend extrapolation at full strength loses badly (+24% to +64% vs persistence);
// median/EMA level filters lose (the last close carries real information); an
// AR(1) fitted per case looked brilliant on the 6 practice cases (+2,069 cents)
// and lost by -1,804 cents (t = -2.76) on the 343-case backtest - the practice
// window's downtrend is a trap, exactly as the rules warn.
//
// What survives: two tiny, opposite-signed adjustments whose average has the best
// risk-adjusted edge of ~40 approaches tested: +97.06 cents vs persistence
// (MAE 41,350.63 vs 41,447.69), standard error 86.55, t = +1.12, win rate 0.50,
// positive in 2 of 3 time thirds (T2 +102, T3 +330, T3 t = +2.01). The averaging
// halves the adjustment's variance, so the worst case costs almost nothing
// against persistence while the forecast still differs from it - a pure
// persistence entry ties the house baseline exactly and can never win, since a
// prize needs a score strictly below it. The adjustment is deliberately small:
// for a small deviation the chance of beating persistence on the 12 final cases
// depends on the edge-to-noise ratio, not on the size, while the expected MAE
// penalty grows with size.
//
// The entry is deterministic (pure arithmetic, no randomness, no network, no
// model call) and runs in milliseconds per case.
//
// Input/output contract (as the kit's starter, whose I/O this keeps):
//   - read every <id>.in in the input directory (the grader runs one case at a
//     time, with only that case's file there), canonical JSON
//     {"schema":"makefun/btc-cent-case/v1","competition","case","at",
//     "horizon_minutes","markets":[{"id","name","start","prices"}]}, where
//     `prices` holds one close a minute in US dollars per whole BTC from `start`
//     to `at` inclusive, so the last one is the close at the checkpoint;
//   - write <id>.out to the output directory:
//     {"forecasts":[{"case":"<the case's id>","price":<number>}]}, exactly one
//     row naming the case and no other key, its price a finite number greater
//     than 0 and less than 10,000,000, at most 1 MiB.
// Outside the grader's container, MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR
// stand in for /input and /output:
//   mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The smallest positive price on the grid: one unit of its 5 decimals. */
const MIN_PRICE = 0.00001;
/** The largest grid price below the scorer's exclusive 10,000,000-dollar cap. */
const MAX_PRICE = 9_999_999.99999;

/** Minutes of history the trend leg fits (24 hours). */
const TREND_WINDOW = 1440;
/** Shrinkage on the trend extrapolation: only 10% of the fitted drift is used. */
const TREND_SHRINK = 0.1;
/** Minutes of history the mean-reversion leg averages (12 hours). */
const MEAN_WINDOW = 720;
/** Pull toward the 12h mean: 5% of the deviation. */
const MEAN_PULL = 0.05;
/** Forecast horizon in minutes, fixed by the competition. */
const HORIZON_MINUTES = 240;

interface CaseMarket {
  id: string;
  prices: number[];
}

interface Case {
  markets: CaseMarket[];
}

/** x kept on the grid's 5 decimals and inside the scorer's (0, 10,000,000). */
const price5 = (x: number): number => Math.round(Math.min(MAX_PRICE, Math.max(MIN_PRICE, x)) * 1e5) / 1e5;

/** Least-squares slope ($/min) of the last n closes, x = 0..n-1. */
function linregSlope(prices: number[], n: number): number {
  const m = Math.min(n, prices.length);
  const ys = prices.slice(prices.length - m);
  const mx = (m - 1) / 2;
  let my = 0;
  for (const y of ys) my += y;
  my /= m;
  let num = 0;
  let den = 0;
  for (let i = 0; i < m; i++) {
    const dx = i - mx;
    num += dx * (ys[i] as number - my);
    den += dx * dx;
  }
  return den === 0 ? 0 : num / den;
}

/** Arithmetic mean of the last n closes. */
function meanLast(prices: number[], n: number): number {
  const m = Math.min(n, prices.length);
  let s = 0;
  for (let i = prices.length - m; i < prices.length; i++) s += prices[i] as number;
  return s / m;
}

/** The ensemble guess for one market: the average of the two shrunk legs. */
function forecast(m: CaseMarket): number {
  if (!Array.isArray(m.prices) || m.prices.length === 0) throw new Error(`market ${m.id} has no prices`);
  // Defensive fill: a non-finite close takes the latest finite close before it,
  // carried forward - the house's own convention for a minute with no sample
  // (kit input/NOTICE.txt). Without this, one bad tick would NaN the forecast
  // and void the whole case. If no close is finite, there is nothing to forecast.
  const prices: number[] = [];
  let lastFinite = NaN;
  let firstFinite = NaN;
  for (const x of m.prices) {
    if (typeof x === 'number' && Number.isFinite(x)) {
      lastFinite = x;
      if (!Number.isFinite(firstFinite)) firstFinite = x;
    }
    prices.push(lastFinite);
  }
  if (!Number.isFinite(lastFinite)) throw new Error(`market ${m.id} has no finite price`);
  for (let i = 0; i < prices.length; i++) {
    if (!Number.isFinite(prices[i] as number)) prices[i] = firstFinite;
  }
  const last = prices[prices.length - 1] as number;
  const legA = last + TREND_SHRINK * linregSlope(prices, TREND_WINDOW) * HORIZON_MINUTES;
  const legB = last + MEAN_PULL * (meanLast(prices, MEAN_WINDOW) - last);
  const guess = (legA + legB) / 2;
  if (!Number.isFinite(guess)) throw new Error(`market ${m.id}'s forecast is not finite`);
  return price5(guess);
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (!Array.isArray(c.markets) || c.markets.length !== 1) throw new Error(`${file} does not hold exactly one market`);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ forecasts: [{ case: id, price: forecast(c.markets[0] as CaseMarket) }] })}\n`);
}
