// The index league: every index on Robinhood Chain and Base, Verdex's and the community's, ranked by how a share
// moved over 7 or 30 days, from each component's daily close in its own pool (the backtest maths: fixed units, held).
import { useMemo, useState } from 'react'
import { Box, Button, Typography } from '@mui/material'
import { Link } from 'react-router-dom'
import { useQueries } from '@tanstack/react-query'
import { t } from '../theme/tokens'
import { Bt, Vg } from '../theme/styles'
import { fmtCompact, useAssets } from '../lib/api'
import { usePoolsOn } from '../lib/pools'
import { BASE_INDEX, ROBINHOOD_INDEX } from '../lib/indexChains'
import { isOfficial, useIndexes, type IndexInfo } from '../lib/indexes'
import { readCandles, type Candle, type ChainKey } from '../lib/candles'
import { backtest } from '../lib/backtest'
import { EarlyGate } from '../components/EarlyGate'
import { Page, PageHero, Panel, Stats } from './common'

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
const sign = (v?: number) => (v === undefined ? '…' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`)
export default function LeaguePage() {
  const assets = useAssets()
  const rhPools = usePoolsOn(ROBINHOOD_INDEX, assets.data?.assets)
  const basePools = usePoolsOn(BASE_INDEX, assets.data?.assets)
  const rh = useIndexes(ROBINHOOD_INDEX, assets.data?.assets, rhPools.data)
  const base = useIndexes(BASE_INDEX, assets.data?.assets, basePools.data)
  const all: IndexInfo[] = useMemo(() => [...(rh.data ?? []), ...(base.data ?? [])], [rh.data, base.data])
  const legs = useMemo(() => { const m = new Map<string, { chain: ChainKey; pool: string }>(); for (const x of all) for (const c of x.components) if (c.pool) m.set(`${x.chain.key}:${c.pool.address.toLowerCase()}`, { chain: x.chain.key as ChainKey, pool: c.pool.address }); return [...m.entries()] }, [all])
  const qs = useQueries({ queries: legs.map(([k, l]) => ({ queryKey: ['candles', l.chain, l.pool.toLowerCase()], queryFn: () => readCandles(l.chain, l.pool), staleTime: 15 * 60_000, retry: 2, meta: { k } })) })
  const byKey = new Map<string, Candle[] | undefined>(legs.map(([k], i) => [k, qs[i]?.data]))
  const ready = qs.filter((q) => q.data).length
  const [win, setWin] = useState<7 | 30>(7)
  const [who, setWho] = useState<'all' | 'community' | 'verdex'>('all')
  const rows = all.map((x) => {
    const L = x.components.map((c) => ({ ticker: c.stock?.ticker ?? c.token, weight: c.weight, candles: c.pool ? byKey.get(`${x.chain.key}:${c.pool.address.toLowerCase()}`) : undefined }))
    const done = L.every((l) => l.candles)
    const bt = done ? backtest(L, win) : null
    return { x, ret: bt?.ret, days: bt ? bt.days.length - 1 : 0, official: isOfficial(x.address) }
  }).filter((r) => who === 'all' || (who === 'verdex') === r.official).sort((a, b) => (b.ret ?? -1e9) - (a.ret ?? -1e9))
  return (
    <EarlyGate path="/league">
      <Page>
        <PageHero label="Index league" badges={<Box sx={{ ...Vg, ml: 0, background: 'rgba(194,234,138,.16)', color: t.color.mark }}>Live</Box>} title={<>Every index,<br />ranked.</>}
          lead="Every index on Robinhood Chain and Base, Verdex's own and the community's, ranked by how one share moved over the last 7 or 30 days: its fixed units valued at each stock's daily close in its own pool. What it holds and who made it are next to every row. Nothing is promoted; Verdex's indexes sit in the same table. Past moves are not a promise."
          action={<Button component={Link} to="/index/create" sx={{ ...Bt, height: 44, px: 2.5 }}>Make your own</Button>} />
        <Stats items={[{ label: 'Indexes', value: rh.data && base.data ? all.length : '…' }, { label: 'Community', value: rh.data && base.data ? all.filter((x) => !isOfficial(x.address)).length : '…' }, { label: 'Held in them', value: rh.data && base.data ? fmtCompact(all.reduce((s, x) => s + x.tvlUsd, 0)) : '…' }, { label: 'Pools read', value: legs.length ? `${ready} of ${legs.length}` : '…' }]} />
        <Box sx={{ display: 'flex', gap: 1, mt: 4, flexWrap: 'wrap' }}>
          {([7, 30] as const).map((w) => <Box key={w} component="button" type="button" onClick={() => setWin(w)} aria-pressed={win === w} sx={{ all: 'unset', cursor: 'pointer', ...Vg, ml: 0, ...(win === w && { background: t.color.text, color: t.color.page }) }}>{w} days</Box>)}
          <Box sx={{ width: 12 }} />
          {(['all', 'community', 'verdex'] as const).map((k) => <Box key={k} component="button" type="button" onClick={() => setWho(k)} aria-pressed={who === k} sx={{ all: 'unset', cursor: 'pointer', ...Vg, ml: 0, ...(who === k && { background: t.color.text, color: t.color.page }) }}>{k === 'all' ? 'All' : k === 'community' ? 'Community' : 'Verdex'}</Box>)}
        </Box>
        <Panel sx={{ mt: 2, p: { xs: 1.5, md: 2 } }}>
          {rows.map((r, i) => (
            <Box key={r.x.address} component={Link} to={`/index/${r.x.chain.key}/${r.x.address}`} sx={{ display: 'grid', gridTemplateColumns: { xs: '36px 1fr 90px', md: '44px 2fr 3fr 110px 110px' }, gap: 2, alignItems: 'center', px: 1.5, py: 1.5, borderRadius: t.radius.input, textDecoration: 'none', color: t.color.text, background: i % 2 ? 'transparent' : t.color.raised }}>
              <Typography sx={{ fontSize: 15, fontWeight: 600, color: i < 3 && r.ret !== undefined ? t.color.mark : t.color.textLabel }}>#{i + 1}</Typography>
              <Box sx={{ minWidth: 0 }}>
                <Typography sx={{ fontSize: 14, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.x.name} <Box component="span" sx={{ color: t.color.textMuted, fontWeight: 400 }}>{r.x.symbol}</Box></Typography>
                <Typography sx={{ fontSize: 12, color: t.color.textLabel }}>{r.x.chain.name} · {r.official ? 'Verdex' : `by ${short(r.x.owner)}`}</Typography>
              </Box>
              <Typography sx={{ fontSize: 12, color: t.color.textMuted, display: { xs: 'none', md: 'block' } }}>{r.x.components.slice().sort((a, b) => b.weight - a.weight).slice(0, 6).map((c) => c.stock?.ticker).join(' · ')}{r.x.components.length > 6 ? ` +${r.x.components.length - 6}` : ''}</Typography>
              <Typography sx={{ fontSize: 13, color: t.color.textMuted, display: { xs: 'none', md: 'block' } }}>{fmtCompact(r.x.tvlUsd)} held</Typography>
              <Typography sx={{ fontSize: 16, fontWeight: 600, textAlign: 'right', color: r.ret === undefined ? t.color.textMuted : r.ret >= 0 ? t.color.mark : t.color.red }}>{sign(r.ret)}</Typography>
            </Box>
          ))}
          {!rows.length && <Typography sx={{ fontSize: 14, color: t.color.textMuted, p: 2 }}>{rh.data && base.data ? 'No index in this table yet.' : 'Reading both factories and the pools behind every index…'}</Typography>}
        </Panel>
      </Page>
    </EarlyGate>
  )
}
