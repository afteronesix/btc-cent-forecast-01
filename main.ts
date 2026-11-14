// btc-cent-forecast-01 entry (Node 22, standard library only): a two-leg ensemble
// around persistence. It forecasts Bitcoin's US-dollar price 240 minutes after
// each checkpoint, from the one-minute closes up to the checkpoint.
//
// NOTE (in-window rewrite, 2026-11-15, after the 03:00 WIB open): this file was
// re-typed in full in this session and then revised here, so the entry it
// carries is authored inside the competition window. The forecasting rule is
// unchanged from the pre-open build: the same two legs, the same constants
// (0.1, 240, 1440, 0.05, 720), the same practice MAE of 45,733.42 cents.
//
//   legA = last + 0.1 * slope1440 * 240, where slope1440 is the least-squares
//          slope of the last 1,440 closes against minute index
//   legB = last + 0.05 * (mean720 - last), where mean720 is the arithmetic mean
//          of the last 720 closes
//   guess = (legA + legB) / 2
//
// The trend leg extrapolates the last day's drift a little; the mean-reversion
// leg pulls the guess a little toward the last 12 hours' average. Both legs
// are anchored on the last close (the price at the checkpoint), so in a flat
// market the guess stays near persistence. The program is deterministic and
// offline: it reads only the case's own prices and writes one guess per case.
//
// Input: every <id>.in in the input directory (MAKEFUN_INPUT_DIR, else /input):
//   {"schema":"makefun/btc-cent-case/v1","competition","case","at",
//    "horizon_minutes","markets":[{"id","name","start","prices"}]}
// Output: <id>.out in the output directory (MAKEFUN_OUTPUT_DIR, else /output):
//   {"forecasts":[{"case":"<the case's id>","price":<number>}]}
// The guess is rounded to 5 decimals, then clamped into (0, 10,000,000).

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The smallest positive price on the grid: one unit of its 5 decimals. */
const MIN_PRICE = 0.00001;
/** The largest grid price below the scorer's exclusive 10,000,000-dollar cap. */
const MAX_PRICE = 9_999_999.99999;

/** Closes used for the trend leg: the last 24 hours of one-minute bars. */
const TREND_WINDOW = 1440;
/** Closes used for the mean-reversion leg: the last 12 hours of bars. */
const MEAN_WINDOW = 720;
/** Fraction of the trend slope, per minute, carried 240 minutes forward. */
const TREND_WEIGHT = 0.1;
/** Fraction of the gap to the 12-hour mean that the guess closes. */
const MEAN_PULL = 0.05;
/** Forecast horizon in minutes. */
const HORIZON_MINUTES = 240;

interface CaseMarket {
  id: string;
  prices: number[];
}

interface Case {
  markets: CaseMarket[];
}

/** Round to the grid's 5 decimals, then clamp inside the scorer's (0, 10,000,000). */
const price5 = (x: number): number =>
  Math.min(MAX_PRICE, Math.max(MIN_PRICE, Math.round(x * 1e5) / 1e5));

/**
 * Replace every non-finite close with the most recent finite close seen
 * before it (a leading run with no finite close yet takes the first finite
 * close in the series instead, so the series stays fully finite).
 */
function forwardFill(prices: number[]): number[] {
  const firstFinite = prices.find((p) => typeof p === 'number' && Number.isFinite(p));
  if (firstFinite === undefined) throw new Error('market has no finite prices');
  const out: number[] = new Array<number>(prices.length);
  let lastFinite = firstFinite;
  for (let i = 0; i < prices.length; i++) {
    const p = prices[i] as number;
    if (typeof p === 'number' && Number.isFinite(p)) lastFinite = p;
    out[i] = lastFinite;
  }
  return out;
}

/** Least-squares slope of y against minute index 0..n-1 (mean-centred form). */
function leastSquaresSlope(y: number[]): number {
  const n = y.length;
  if (n < 2) return 0;
  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += y[i] as number;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - meanX;
    sxy += dx * ((y[i] as number) - meanY);
    sxx += dx * dx;
  }
  return sxx === 0 ? 0 : sxy / sxx;
}

/** Arithmetic mean of the given closes. */
function mean(values: number[]): number {
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** The two-leg ensemble guess for one market, in US dollars per whole BTC. */
function forecast(m: CaseMarket): number {
  if (!Array.isArray(m.prices) || m.prices.length === 0) {
    throw new Error(`market ${m.id} has no prices`);
  }
  const closes = forwardFill(m.prices);
  const last = closes[closes.length - 1] as number;

  const trendWindow = closes.slice(-TREND_WINDOW);
  const slope = leastSquaresSlope(trendWindow);
  const legA = last + TREND_WEIGHT * slope * HORIZON_MINUTES;

  const meanWindow = closes.slice(-MEAN_WINDOW);
  const legB = last + MEAN_PULL * (mean(meanWindow) - last);

  return price5((legA + legB) / 2);
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (!Array.isArray(c.markets) || c.markets.length !== 1) {
    throw new Error(`${file} does not hold exactly one market`);
  }
  const guess = forecast(c.markets[0] as CaseMarket);
  writeFileSync(
    join(OUTPUT_DIR, `${id}.out`),
    `${JSON.stringify({ forecasts: [{ case: id, price: guess }] })}\n`,
  );
}
