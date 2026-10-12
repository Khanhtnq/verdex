// The backtest: a basket bought at its weights on the first day of the window and held, the way an index share is
// held (fixed units, no rebalancing), valued every day at each stock's close in its own pool. No fees, no slippage.
import type { Candle } from './candles'

export type Leg = { ticker: string; weight: number; candles?: Candle[] }
export type Backtest = { days: number[]; value: number[]; ret: number; best: { t: number; pct: number }; worst: { t: number; pct: number }; maxDrawdown: number; missing: string[] }

export function backtest(legs: Leg[], windowDays: number): Backtest | null {
  const usable = legs.filter((l) => l.weight > 0 && l.candles && l.candles.length > 1)
  const missing = legs.filter((l) => l.weight > 0 && !(l.candles && l.candles.length > 1)).map((l) => l.ticker)
  if (!usable.length) return null
  // Days every usable leg has a close for, last `windowDays + 1` of them.
  const sets = usable.map((l) => new Map(l.candles!.map((c) => [c.t, c.c])))
  const common = [...sets[0].keys()].filter((t) => sets.every((m) => m.has(t))).sort((a, b) => a - b).slice(-(windowDays + 1))
  if (common.length < 2) return null
  const wSum = usable.reduce((s, l) => s + l.weight, 0)
  const units = usable.map((l, i) => l.weight / wSum / sets[i].get(common[0])!)
  const value = common.map((t) => 100 * usable.reduce((s, _l, i) => s + units[i] * sets[i].get(t)!, 0))
  let best = { t: common[1], pct: -Infinity }, worst = { t: common[1], pct: Infinity }, peak = value[0], maxDrawdown = 0
  for (let i = 1; i < value.length; i++) {
    const d = (value[i] / value[i - 1] - 1) * 100
    if (d > best.pct) best = { t: common[i], pct: d }
    if (d < worst.pct) worst = { t: common[i], pct: d }
    peak = Math.max(peak, value[i]); maxDrawdown = Math.min(maxDrawdown, (value[i] / peak - 1) * 100)
  }
  return { days: common, value, ret: value[value.length - 1] - 100, best, worst, maxDrawdown, missing }
}
