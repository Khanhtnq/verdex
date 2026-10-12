// One tokenized stock: its chart from its own pool, the moves over 1, 7 and 30 days, its pools on each chain, the
// Verdex indexes that hold it, and every way to act on it from here.
import { useMemo, useState } from 'react'
import { Avatar, Box, Button, Typography } from '@mui/material'
import { Link, useParams } from 'react-router-dom'
import { t, z } from '../theme/tokens'
import { Bt, Lt, Vg } from '../theme/styles'
import { fmtCompact, useAssets } from '../lib/api'
import { stockTokensOn, usePoolsOn } from '../lib/pools'
import { BASE_INDEX, ROBINHOOD_INDEX, type IndexChain } from '../lib/indexChains'
import { useIndexes } from '../lib/indexes'
import { poolFor } from '../lib/autopilot'
import { moveOver, useCandles, type ChainKey } from '../lib/candles'
import { resolveImg } from '../lib/img'
import { CandleChart } from '../components/CandleChart'
import { ExternalIcon } from '../components/icons'
import { Page, Panel } from './common'
import { useWatch, watch } from '../lib/watch'
import { useFeatureOpen } from '../lib/holding'

const usd = (v: number) => `$${v >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 0 }) : v.toFixed(2)}`
const Move = ({ v, label }: { v?: number; label: string }) => (
  <Box sx={{ p: 1.5, borderRadius: t.radius.input, background: t.color.raised }}>
    <Typography sx={{ fontSize: 11, color: t.color.textLabel }}>{label}</Typography>
    <Typography sx={{ fontSize: 20, fontWeight: 500, mt: 0.25, color: v === undefined ? t.color.textMuted : v >= 0 ? t.color.mark : t.color.red }}>{v === undefined ? '…' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`}</Typography>
  </Box>
)

export default function StockPage() {
  const { ticker = '' } = useParams()
  const assets = useAssets()
  const asset = assets.data?.assets.find((a) => a.ticker.toLowerCase() === ticker.toLowerCase())
  const onChains = useMemo(() => [ROBINHOOD_INDEX, BASE_INDEX].filter((ic) => asset?.tokens.some((tk) => tk.chainId === ic.id)), [asset])
  const [pick, setPick] = useState<IndexChain['key'] | null>(null)
  const ic = onChains.find((c) => c.key === pick) ?? onChains[0] ?? ROBINHOOD_INDEX
  const pools = usePoolsOn(ic, assets.data?.assets)
  const stock = useMemo(() => (assets.data && asset ? stockTokensOn(assets.data.assets, ic.id).find((s) => s.ticker === asset.ticker) : undefined), [assets.data, asset, ic.id])
  const pool = stock && pools.data ? poolFor(stock, pools.data) : undefined
  const candles = useCandles(ic.key as ChainKey, pool?.address)
  const [win, setWin] = useState<30 | 90>(90)
  const cs = useMemo(() => (candles.data ?? []).slice(-win), [candles.data, win])
  const idx = useIndexes(ic, assets.data?.assets, pools.data)
  const holdingIt = (idx.data ?? []).filter((x) => x.components.some((c) => stock && c.token.toLowerCase() === stock.address.toLowerCase()))
  const price = pool?.priceUsd ?? asset?.price
  const w = useWatch()
  const starred = !!asset && w.tickers.includes(asset.ticker)
  const watchOpen = useFeatureOpen('/watchlist')
  if (assets.data && !asset) return <Page><Typography sx={{ mt: 10, fontSize: 18 }}>No stock called {ticker} is listed. <Link to="/assets" style={{ color: t.color.text }}>All assets</Link></Typography></Page>
  return (
    <Page>
      <Box sx={{ pt: { xs: 4, md: 7 }, display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
        <Avatar src={resolveImg(asset?.logo)} alt={asset?.ticker} sx={{ width: 56, height: 56, background: z.surface2 }}>{asset?.ticker[0]}</Avatar>
        <Box sx={{ flex: 1, minWidth: 200 }}>
          <Typography component="h1" sx={{ ...t.type.h2, color: t.color.text }}>{asset?.name ?? ticker}</Typography>
          <Typography sx={{ fontSize: 14, color: t.color.textMuted, mt: 0.5 }}>{asset?.ticker} · {asset?.category}</Typography>
        </Box>
        <Box sx={{ textAlign: 'right' }}>
          <Typography sx={{ fontSize: 34, fontWeight: 500 }}>{price ? usd(price) : '…'}</Typography>
          <Typography sx={{ fontSize: 12, color: t.color.textLabel }}>{pool ? `in its ${ic.quote.symbol} pool on ${ic.name}` : 'reading the pool…'}</Typography>
        </Box>
      </Box>
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mt: 3 }}>
        {onChains.map((c) => <Box key={c.key} component="button" type="button" onClick={() => setPick(c.key)} aria-pressed={c.key === ic.key} sx={{ all: 'unset', cursor: 'pointer', ...Vg, ml: 0, ...(c.key === ic.key && { background: t.color.text, color: t.color.page }) }}>{c.name}</Box>)}
      </Box>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr 1fr', md: 'repeat(4, 1fr)' }, gap: 1.5, mt: 3 }}>
        <Move label="1 day" v={candles.data ? moveOver(candles.data, 1) : undefined} />
        <Move label="7 days" v={candles.data ? moveOver(candles.data, 7) : undefined} />
        <Move label="30 days" v={candles.data ? moveOver(candles.data, 30) : undefined} />
        <Box sx={{ p: 1.5, borderRadius: t.radius.input, background: t.color.raised }}>
          <Typography sx={{ fontSize: 11, color: t.color.textLabel }}>Pool liquidity · 24h volume</Typography>
          <Typography sx={{ fontSize: 20, fontWeight: 500, mt: 0.25 }}>{pool ? `${fmtCompact(pool.liquidityUsd)} · ${fmtCompact(pool.volume24hUsd)}` : '…'}</Typography>
        </Box>
      </Box>
      <Panel sx={{ mt: 2.5, p: { xs: 2, md: 3 } }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 2, flexWrap: 'wrap', mb: 1.5 }}>
          <Typography sx={{ fontSize: 16, fontWeight: 500 }}>Daily candles</Typography>
          <Box sx={{ display: 'flex', gap: 1 }}>{([30, 90] as const).map((w) => <Box key={w} component="button" type="button" onClick={() => setWin(w)} aria-pressed={win === w} sx={{ all: 'unset', cursor: 'pointer', ...Vg, ml: 0, ...(win === w && { background: t.color.text, color: t.color.page }) }}>{w} days</Box>)}</Box>
        </Box>
        {cs.length ? <CandleChart candles={cs} /> : <Typography sx={{ fontSize: 13, color: t.color.textMuted, height: 300, display: 'grid', placeItems: 'center' }}>{candles.isError ? 'No candles for this pool yet.' : pool || !pools.data ? 'Reading the candles…' : 'No pool deep enough on this chain.'}</Typography>}
        <Typography sx={{ fontSize: 12, color: t.color.textLabel, mt: 1.5 }}>{pool && <>From the {ic.dexName} pool {pool.address.slice(0, 6)}…{pool.address.slice(-4)}, the pool your trade goes through, so weekends are in it. <Box component="a" href={`${ic.explorer}/address/${pool.address}`} target="_blank" rel="noopener noreferrer" sx={{ color: t.color.text, display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>Pool <ExternalIcon size={11} /></Box></>}</Typography>
      </Panel>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2.5, mt: 2.5 }}>
        <Panel sx={{ p: 3 }}>
          <Typography sx={{ fontSize: 16, fontWeight: 500 }}>Act on it</Typography>
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mt: 2 }}>
            {stock && <Button component={Link} to={`/?buy=${stock.address}&chain=${ic.id}&sym=${encodeURIComponent(stock.symbol)}&dec=${stock.decimals}#swap`} sx={{ ...Bt, height: 40, px: 2.25 }}>Buy {asset?.ticker}</Button>}
            <Button component={Link} to={`/orders/without-you${ic.key === 'base' ? '?chain=base' : ''}`} sx={{ ...Lt, height: 40, px: 2 }}>Set a level</Button>
            {watchOpen && asset && <Button onClick={() => watch.toggle(asset.ticker)} aria-pressed={starred} sx={{ ...Lt, height: 40, px: 2 }}>{starred ? '★ On your watchlist' : '☆ Watch'}</Button>}
            <Button component={Link} to={`/auto-invest/without-you${ic.key === 'base' ? '?chain=base' : ''}`} sx={{ ...Lt, height: 40, px: 2 }}>Buy it every week</Button>
          </Box>
        </Panel>
        <Panel sx={{ p: 3 }}>
          <Typography sx={{ fontSize: 16, fontWeight: 500 }}>In Verdex indexes</Typography>
          <Box sx={{ display: 'grid', gap: 0.75, mt: 2 }}>
            {holdingIt.map((x) => { const c = x.components.find((k) => stock && k.token.toLowerCase() === stock.address.toLowerCase()); return <Box key={x.address} component={Link} to={`/index${ic.key === 'base' ? '?chain=base' : ''}`} sx={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: t.color.text, textDecoration: 'none', p: 1.25, borderRadius: t.radius.input, background: t.color.raised }}><span>{x.name}</span><span style={{ color: t.color.textMuted }}>{c ? `${(c.weight * 100).toFixed(1)}%` : ''}</span></Box> })}
            {idx.data && !holdingIt.length && <Typography sx={{ fontSize: 13, color: t.color.textMuted }}>No index on {ic.name} holds it yet. You will be able to make one.</Typography>}
            {!idx.data && <Typography sx={{ fontSize: 13, color: t.color.textMuted }}>Reading the indexes…</Typography>}
          </Box>
        </Panel>
      </Box>
    </Page>
  )
}
