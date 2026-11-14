# btc-cent-forecast-01 — two-leg ensemble around persistence

Forecasts Bitcoin's US-dollar price 240 minutes after each checkpoint, from the
4,320 one-minute closes of the 72 hours up to it. Score: mean absolute error in
cents (100 × mean |guess − actual|) over 12 final cases. A prize needs a score
strictly below the house persistence baseline.

## The forecast

```
guess = (legA + legB) / 2
legA  = last + 0.1  × slope(last 1440 closes) × 240   # 24h trend, shrunk 90%
legB  = last + 0.05 × (mean(last 720 closes) − last)  # pull to 12h mean, 5%
```

Clamped to the price grid (5 decimals) and the scorer's (0, 10,000,000).
Deterministic, offline, standard library only, milliseconds per case.

## Why this — evidence, not intuition

Backtest: 60 days of Binance BTCUSDT 1-minute closes (15 Sep – 14 Nov 2026),
343 cases of 72h windows cut 4h apart, scored exactly as the competition
scores. Headline finding: **4h-ahead BTC is a martingale at this horizon** —
lag-1 autocorrelation of non-overlapping 240-minute log returns is +0.013
(n = 361), i.e. zero. Consequences, all measured:

| approach | MAE (cents) vs persistence 41,447.69 |
|---|---|
| trend extrapolation, full strength | +24% to +64% worse |
| median / EMA level filters | worse (last close carries signal) |
| AR(1) fitted per case | −1,804 cents, t = −2.76 (but +2,069 on the 6 practice cases — the practice window's downtrend is a trap) |
| **this ensemble** | **41,350.63, +97.06 ± 86.55, t = +1.12, win rate 0.50** |

No approach beats persistence beyond noise; this ensemble has the best
risk-adjusted edge of ~40 tested, positive in 2 of 3 time thirds
(T2 +102, T3 +330, T3 t = +2.01), with the smallest adjustment variance.
A pure-persistence entry ties the baseline exactly and can never win, so the
entry deviates by a small, hedged amount: the two legs are opposite-signed
(trend vs reversion), and averaging them halves the adjustment's variance.

Full backtest tables: `../btc-cent-forecast-01/backtest*.py` (work dir, not
part of this repo).

## Run

```
mkdir -p out && MAKEFUN_INPUT_DIR=<kit>/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Reads every `*.in` in the input dir, writes `<id>.out` per case:
`{"forecasts":[{"case":"<id>","price":<number>}]}`.

## License

MIT (see LICENSE).
