// A basket's backtest over 30 or 90 days against SPY on the same chain, from the pools' daily closes.
import { useMemo, useState } from 'react'
import { Box, Typography } from '@mui/material'
import { useQueries } from '@tanstack/react-query'
import { t } from '../theme/tokens'
import { Vg } from '../theme/styles'
import { useAssets } from '../lib/api'
import { stockTokensOn, usePoolsOn } from '../lib/pools'
import { poolFor } from '../lib/autopilot'
import type { IndexChain } from '../lib/indexChains'
import { readCandles, type ChainKey } from '../lib/candles'
import { backtest } from '../lib/backtest'

const sign = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`
const day = (s: number) => new Date(s * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

export function BacktestPanel({ ic, legs, compact }: { ic: IndexChain; legs: { ticker: string; weight: number }[]; compact?: boolean }) {
  const [win, setWin] = useState<30 | 90>(30)
  const assets = useAssets()
  const pools = usePoolsOn(ic, assets.data?.assets)
  const tickers = useMemo(() => [...new Set([...legs.map((l) => l.ticker), 'SPY'])], [legs])
  const poolOf = useMemo(() => {
    const m = new Map<string, string>()
    if (!assets.data || !pools.data) return m
    const stocks = stockTokensOn(assets.data.assets, ic.id)
    for (const tk of tickers) { const s = stocks.find((x) => x.ticker === tk); const p = s ? poolFor(s, pools.data) : undefined; if (p) m.set(tk, p.address) }
    return m
  }, [assets.data, pools.data, tickers, ic.id])
  const qs = useQueries({ queries: tickers.map((tk) => ({ queryKey: ['candles', ic.key, poolOf.get(tk)?.toLowerCase()], queryFn: () => readCandles(ic.key as ChainKey, poolOf.get(tk)!), enabled: !!poolOf.get(tk), staleTime: 15 * 60_000, retry: 1 })) })
  const byTicker = new Map(tickers.map((tk, i) => [tk, qs[i].data]))
  const loading = !pools.data || qs.some((q, i) => poolOf.get(tickers[i]) && q.isLoading)
  const bt = loading ? null : backtest(legs.map((l) => ({ ...l, candles: byTicker.get(l.ticker) })), win)
  const spy = loading ? null : backtest([{ ticker: 'SPY', weight: 1, candles: byTicker.get('SPY') }], win)
  const W = 1000, H = compact ? 140 : 200
  const path = (vals: number[], lo: number, hi: number) => vals.map((v, i) => `${i ? 'L' : 'M'}${((i / Math.max(1, vals.length - 1)) * W).toFixed(1)},${(6 + (1 - (v - lo) / (hi - lo || 1)) * (H - 12)).toFixed(1)}`).join(' ')
  const all = [...(bt?.value ?? []), ...(spy && bt ? spy.value.slice(-bt.value.length) : [])]
  const lo = Math.min(...all), hi = Math.max(...all)
  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <Typography sx={{ fontSize: 13, fontWeight: 500 }}>Backtest, held from {bt ? day(bt.days[0]) : '…'}</Typography>
        <Box sx={{ display: 'flex', gap: 0.75 }}>{([30, 90] as const).map((w) => <Box key={w} component="button" type="button" onClick={() => setWin(w)} aria-pressed={win === w} sx={{ all: 'unset', cursor: 'pointer', ...Vg, ml: 0, fontSize: 12, ...(win === w && { background: t.color.text, color: t.color.page }) }}>{w} days</Box>)}</Box>
      </Box>
      {bt ? (
        <>
          <Box component="svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" sx={{ width: '100%', height: H, display: 'block', mt: 1.5 }} role="img" aria-label={`Basket ${sign(bt.ret)} against SPY ${spy ? sign(spy.ret) : ''} over ${bt.days.length - 1} days`}>
            <line x1={0} x2={W} y1={6 + (1 - (100 - lo) / (hi - lo || 1)) * (H - 12)} y2={6 + (1 - (100 - lo) / (hi - lo || 1)) * (H - 12)} stroke="rgba(255,255,255,.12)" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
            {spy && <path d={path(spy.value.slice(-bt.value.length), lo, hi)} fill="none" stroke="rgba(255,255,255,.35)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />}
            <path d={path(bt.value, lo, hi)} fill="none" stroke={t.color.mark} strokeWidth={2.5} vectorEffect="non-scaling-stroke" />
          </Box>
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr 1fr', sm: 'repeat(4, 1fr)' }, gap: 1, mt: 1.5 }}>
            {[['This basket', sign(bt.ret), bt.ret >= 0], ['SPY, same days', spy ? sign(spy.ret) : '…', (spy?.ret ?? 0) >= 0], ['Best day', `${sign(bt.best.pct)} · ${day(bt.best.t)}`, true], ['Worst day', `${sign(bt.worst.pct)} · ${day(bt.worst.t)}`, false]].map(([k, v, up]) => (
              <Box key={k as string} sx={{ p: 1.25, borderRadius: t.radius.input, background: t.color.raised }}>
                <Typography sx={{ fontSize: 11, color: t.color.textLabel }}>{k}</Typography>
                <Typography sx={{ fontSize: 15, fontWeight: 500, color: up ? t.color.mark : t.color.red }}>{v}</Typography>
              </Box>
            ))}
          </Box>
          <Typography sx={{ fontSize: 11, color: t.color.textLabel, mt: 1 }}>Deepest drop from a high: {bt.maxDrawdown.toFixed(2)}%. Held at fixed units from the first day, daily closes from each pool, no fees or slippage. {bt.days.length - 1 < win ? `The pools have ${bt.days.length - 1} days of shared history. ` : ''}{bt.missing.length ? `Left out, no candles: ${bt.missing.join(', ')}. ` : ''}Past moves are not a promise.</Typography>
        </>
      ) : (
        <Typography sx={{ fontSize: 12, color: t.color.textMuted, mt: 1.5, height: H, display: 'grid', placeItems: 'center' }}>{loading ? 'Reading the candles…' : 'Not enough shared history to backtest this basket.'}</Typography>
      )}
    </Box>
  )
}
