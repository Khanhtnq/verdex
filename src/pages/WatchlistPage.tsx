// Watchlist and price alerts: starred stocks with their price and moves, and levels that notify when crossed.
import { useMemo, useState } from 'react'
import { Avatar, Box, Button, InputBase, Typography } from '@mui/material'
import { Link } from 'react-router-dom'
import { useQueries } from '@tanstack/react-query'
import { t, z } from '../theme/tokens'
import { Bt, Lt, Vg } from '../theme/styles'
import { useAssets } from '../lib/api'
import { stockTokens, usePools } from '../lib/pools'
import { poolFor } from '../lib/autopilot'
import { moveOver, readCandles } from '../lib/candles'
import { askNotify, useWatch, watch } from '../lib/watch'
import { resolveImg } from '../lib/img'
import { Spark } from '../components/CandleChart'
import { EarlyGate } from '../components/EarlyGate'
import { Page, PageHero, Panel } from './common'

const sign = (v?: number) => (v === undefined ? '…' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`)
export default function WatchlistPage() {
  const s = useWatch()
  const assets = useAssets()
  const pools = usePools(assets.data?.assets)
  const stocks = useMemo(() => (assets.data ? stockTokens(assets.data.assets) : []), [assets.data])
  const rows = useMemo(() => s.tickers.map((tk) => { const st = stocks.find((x) => x.ticker === tk); return { tk, st, pool: st && pools.data ? poolFor(st, pools.data) : undefined } }), [s.tickers, stocks, pools.data])
  const cq = useQueries({ queries: rows.map((r) => ({ queryKey: ['candles', 'robinhood', r.pool?.address.toLowerCase()], queryFn: () => readCandles('robinhood', r.pool!.address), enabled: !!r.pool, staleTime: 15 * 60_000 })) })
  const [q, setQ] = useState('')
  const [form, setForm] = useState<{ tk: string; dir: 'above' | 'below'; level: string } | null>(null)
  const [perm, setPerm] = useState<string>(() => ('Notification' in window ? Notification.permission : 'unsupported'))
  const found = q ? stocks.filter((x) => x.ticker.toLowerCase().startsWith(q.toLowerCase()) || x.name.toLowerCase().includes(q.toLowerCase())).slice(0, 8) : []
  const add = async () => { if (!form || !(Number(form.level) > 0)) return; setPerm(String(await askNotify())); watch.addAlert(form.tk, form.dir, Number(form.level)); setForm(null) }
  return (
    <EarlyGate path="/watchlist">
      <Page>
        <PageHero label="Watchlist" badges={<Box sx={{ ...Vg, ml: 0, background: 'rgba(194,234,138,.16)', color: t.color.mark }}>New</Box>} title={<>Star it.<br />Set a level.</>}
          lead="The stocks you care about in one place, priced from their own pools, and alerts that notify you when a pool crosses your level. Your list and your levels stay in this browser. Keep a Verdex tab open or install Verdex as an app: the page checks the pools every minute." />
        {perm !== 'granted' && <Typography sx={{ fontSize: 13, color: t.color.textMuted, mt: 2 }}>{perm === 'denied' ? 'Notifications are blocked for this site in your browser settings; alerts will still show here.' : perm === 'unsupported' ? 'This browser cannot show notifications; alerts will show here.' : 'Notifications are asked for when you set your first alert.'}</Typography>}
        <Panel sx={{ mt: 3, p: { xs: 2.5, md: 3 } }}>
          <InputBase value={q} onChange={(e) => setQ(e.target.value)} placeholder="Add a stock: NVDA, Tesla, SPY…" inputProps={{ 'aria-label': 'Add a stock' }} sx={{ width: '100%', height: 44, px: 1.5, borderRadius: t.radius.input, background: t.color.hover, fontSize: 14 }} />
          {found.length > 0 && <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap', mt: 1.5 }}>{found.map((x) => <Box key={x.address} component="button" type="button" onClick={() => { if (!s.tickers.includes(x.ticker)) watch.toggle(x.ticker); setQ('') }} sx={{ all: 'unset', cursor: 'pointer', ...Vg, ml: 0 }}>★ {x.ticker}</Box>)}</Box>}
          <Box sx={{ display: 'grid', gap: 0.75, mt: 2.5 }}>
            {rows.map((r, i) => {
              const cs = cq[i]?.data ?? []
              const alerts = s.alerts.filter((a) => a.ticker === r.tk)
              return (
                <Box key={r.tk} sx={{ p: 1.5, borderRadius: t.radius.input, background: t.color.raised }}>
                  <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr auto', md: '200px 110px 90px 90px 110px 1fr' }, gap: 1.5, alignItems: 'center' }}>
                    <Box component={Link} to={`/assets/${r.tk}`} sx={{ display: 'flex', alignItems: 'center', gap: 1, textDecoration: 'none', color: t.color.text }}><Avatar src={resolveImg(r.st?.logo)} sx={{ width: 24, height: 24, background: z.surface2, fontSize: 10 }}>{r.tk[0]}</Avatar><Typography sx={{ fontSize: 14, fontWeight: 500 }}>{r.tk}</Typography></Box>
                    <Typography sx={{ fontSize: 14 }}>{r.pool ? `$${r.pool.priceUsd.toFixed(2)}` : '…'}</Typography>
                    <Typography sx={{ fontSize: 12, color: (moveOver(cs, 1) ?? 0) >= 0 ? t.color.mark : t.color.red, display: { xs: 'none', md: 'block' } }}>1d {sign(moveOver(cs, 1))}</Typography>
                    <Typography sx={{ fontSize: 12, color: (moveOver(cs, 7) ?? 0) >= 0 ? t.color.mark : t.color.red, display: { xs: 'none', md: 'block' } }}>7d {sign(moveOver(cs, 7))}</Typography>
                    <Box sx={{ display: { xs: 'none', md: 'block' } }}><Spark candles={cs.slice(-30)} w={100} h={28} /></Box>
                    <Box sx={{ display: 'flex', gap: 0.75, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                      <Button onClick={() => setForm({ tk: r.tk, dir: 'above', level: r.pool ? (r.pool.priceUsd * 1.05).toFixed(2) : '' })} sx={{ ...Lt, backdropFilter: 'none', height: 30, px: 1.25, fontSize: 12 }}>Alert</Button>
                      <Button component={Link} to="/orders/without-you" sx={{ ...Lt, backdropFilter: 'none', height: 30, px: 1.25, fontSize: 12 }}>Order</Button>
                      <Button onClick={() => watch.toggle(r.tk)} sx={{ ...Lt, backdropFilter: 'none', height: 30, px: 1.25, fontSize: 12, color: t.color.textMuted }}>Remove</Button>
                    </Box>
                  </Box>
                  {alerts.map((a) => <Box key={a.id} sx={{ display: 'flex', justifyContent: 'space-between', gap: 1, mt: 1, fontSize: 12, color: a.firedAt ? t.color.mark : t.color.textMuted }}><span>{a.firedAt ? '✓ crossed' : 'When'} {a.dir} ${a.level}{a.firedAt ? ` · ${new Date(a.firedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : ''}</span><Box component="button" type="button" onClick={() => watch.removeAlert(a.id)} sx={{ all: 'unset', cursor: 'pointer', color: t.color.text }}>Delete</Box></Box>)}
                  {form?.tk === r.tk && (
                    <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', mt: 1.25, flexWrap: 'wrap' }}>
                      {(['above', 'below'] as const).map((d) => <Box key={d} component="button" type="button" onClick={() => setForm({ ...form, dir: d })} aria-pressed={form.dir === d} sx={{ all: 'unset', cursor: 'pointer', ...Vg, ml: 0, ...(form.dir === d && { background: t.color.text, color: t.color.page }) }}>{d}</Box>)}
                      <InputBase value={form.level} onChange={(e) => setForm({ ...form, level: e.target.value.replace(/[^0-9.]/g, '') })} inputProps={{ 'aria-label': 'Alert level', inputMode: 'decimal' }} startAdornment={<span style={{ fontSize: 13, color: t.color.textMuted, marginRight: 4 }}>$</span>} sx={{ width: 110, height: 32, px: 1, borderRadius: t.radius.input, background: t.color.hover, fontSize: 13 }} />
                      <Button onClick={() => void add()} sx={{ ...Bt, height: 32, px: 1.75 }}>Set alert</Button>
                    </Box>
                  )}
                </Box>
              )
            })}
            {rows.length === 0 && <Typography sx={{ fontSize: 14, color: t.color.textMuted }}>Nothing starred yet. Search above, or tap the star on any stock page.</Typography>}
          </Box>
        </Panel>
      </Page>
    </EarlyGate>
  )
}
