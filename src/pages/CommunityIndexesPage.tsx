// Every index anyone has made with the open factories, on Robinhood Chain and Base: its stocks, its creator, what it
// holds. Nothing curated, nothing promoted. Verdex's own indexes are on the Index page.
import { useMemo, useState } from 'react'
import { Box, Button, Typography } from '@mui/material'
import { Link } from 'react-router-dom'
import { t } from '../theme/tokens'
import { Bt, Vg } from '../theme/styles'
import { fmtCompact, useAssets } from '../lib/api'
import { usePoolsOn } from '../lib/pools'
import { BASE_INDEX, ROBINHOOD_INDEX } from '../lib/indexChains'
import { isOfficial, useIndexes, type IndexInfo } from '../lib/indexes'
import { EarlyGate } from '../components/EarlyGate'
import { Page, PageHero, Panel, Stats } from './common'

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
export default function CommunityIndexesPage() {
  const assets = useAssets()
  const rhPools = usePoolsOn(ROBINHOOD_INDEX, assets.data?.assets)
  const basePools = usePoolsOn(BASE_INDEX, assets.data?.assets)
  const rh = useIndexes(ROBINHOOD_INDEX, assets.data?.assets, rhPools.data)
  const base = useIndexes(BASE_INDEX, assets.data?.assets, basePools.data)
  const [sort, setSort] = useState<'new' | 'tvl'>('new')
  const list = useMemo(() => {
    const all: IndexInfo[] = [...(rh.data ?? []).slice().reverse(), ...(base.data ?? []).slice().reverse()].filter((x) => !isOfficial(x.address))
    return sort === 'tvl' ? all.sort((a, b) => b.tvlUsd - a.tvlUsd) : all
  }, [rh.data, base.data, sort])
  const loading = !rh.data || !base.data
  const creators = new Set(list.map((x) => x.owner.toLowerCase())).size
  return (
    <EarlyGate path="/index/community">
      <Page>
        <PageHero label="Community indexes" badges={<Box sx={{ ...Vg, ml: 0, background: 'rgba(194,234,138,.16)', color: t.color.mark }}>Live</Box>}
          title={<>Every index anyone made.<br />Both chains.</>}
          lead="Each one is a real ERC-20 from the same open factory as the Verdex indexes, backed by the stocks inside it, with fixed units nobody can change. Listed with the wallet that made it. Nothing here is curated or promoted by Verdex: read what is in an index before you buy it."
          action={<Button component={Link} to="/index/create" sx={{ ...Bt, height: 44, px: 2.5 }}>Make your own</Button>} />
        <Stats items={[{ label: 'Community indexes', value: loading ? '…' : list.length }, { label: 'Creators', value: loading ? '…' : creators }, { label: 'Held in them', value: loading ? '…' : fmtCompact(list.reduce((s, x) => s + x.tvlUsd, 0)) }, { label: 'Chains', value: 2 }]} />
        <Box sx={{ display: 'flex', gap: 1, mt: 4 }}>{(['new', 'tvl'] as const).map((k) => <Box key={k} component="button" type="button" onClick={() => setSort(k)} aria-pressed={sort === k} sx={{ all: 'unset', cursor: 'pointer', ...Vg, ml: 0, ...(sort === k && { background: t.color.text, color: t.color.page }) }}>{k === 'new' ? 'Newest' : 'Most held'}</Box>)}</Box>
        <Box sx={{ display: 'grid', gap: 1.25, mt: 2 }}>
          {list.map((x) => (
            <Panel key={x.address} sx={{ p: 0 }}>
              <Box component={Link} to={`/index/${x.chain.key}/${x.address}`} sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '2fr 3fr 1fr' }, gap: 2, alignItems: 'center', p: 2.5, textDecoration: 'none', color: t.color.text }}>
                <Box>
                  <Typography sx={{ fontSize: 15, fontWeight: 500 }}>{x.name} <Box component="span" sx={{ color: t.color.textMuted, fontWeight: 400 }}>{x.symbol}</Box></Typography>
                  <Typography sx={{ fontSize: 12, color: t.color.textLabel, mt: 0.5 }}>{x.chain.name} · by {short(x.owner)}</Typography>
                </Box>
                <Typography sx={{ fontSize: 12, color: t.color.textMuted }}>{x.components.map((c) => `${c.stock?.ticker ?? short(c.token)} ${(c.weight * 100).toFixed(0)}%`).join(' · ')}</Typography>
                <Typography sx={{ fontSize: 13, textAlign: { md: 'right' } }}>{fmtCompact(x.tvlUsd)} held</Typography>
              </Box>
            </Panel>
          ))}
          {!loading && list.length === 0 && <Panel sx={{ p: 3 }}><Typography sx={{ fontSize: 14, color: t.color.textMuted }}>Nobody has made one yet. <Link to="/index/create" style={{ color: t.color.text }}>Be the first.</Link></Typography></Panel>}
          {loading && <Panel sx={{ p: 3 }}><Typography sx={{ fontSize: 14, color: t.color.textMuted }}>Reading both factories and the pools behind every index…</Typography></Panel>}
        </Box>
      </Page>
    </EarlyGate>
  )
}
