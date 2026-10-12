// One index, Verdex's or the community's: what is in it, its backtest, who made it, and a buy button.
import { Avatar, Box, Button, Typography } from '@mui/material'
import { Link, useParams } from 'react-router-dom'
import { t, z } from '../theme/tokens'
import { Bt, Lt, Vg } from '../theme/styles'
import { fmtCompact, useAssets } from '../lib/api'
import { usePoolsOn } from '../lib/pools'
import { indexChain } from '../lib/indexChains'
import { isOfficial, useIndexes } from '../lib/indexes'
import { resolveImg } from '../lib/img'
import { BacktestPanel } from '../components/BacktestPanel'
import { ExternalIcon } from '../components/icons'
import { Page, Panel } from './common'

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
export default function IndexViewPage() {
  const { chain = 'robinhood', address = '' } = useParams()
  const ic = indexChain(chain)
  const assets = useAssets()
  const pools = usePoolsOn(ic, assets.data?.assets)
  const indexes = useIndexes(ic, assets.data?.assets, pools.data)
  const x = indexes.data?.find((i) => i.address.toLowerCase() === address.toLowerCase())
  const official = isOfficial(address)
  if (indexes.data && !x) return <Page><Typography sx={{ mt: 10, fontSize: 18 }}>No index at {short(address)} on {ic.name}. <Link to="/index/community" style={{ color: t.color.text }}>Community indexes</Link></Typography></Page>
  const sharesOut = x ? Number(x.totalSupply) / 1e18 : 0
  return (
    <Page>
      <Box sx={{ pt: { xs: 4, md: 7 } }}>
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
          <Box sx={{ ...Vg, ml: 0 }}>{ic.name}</Box>
          <Box sx={{ ...Vg, ml: 0, ...(official ? { background: 'rgba(194,234,138,.16)', color: t.color.mark } : {}) }}>{official ? 'Verdex index' : 'Community index'}</Box>
        </Box>
        <Typography component="h1" sx={{ ...t.type.h2, color: t.color.text, mt: 2 }}>{x?.name ?? 'Reading the index…'} <Box component="span" sx={{ color: t.color.textMuted }}>{x?.symbol}</Box></Typography>
        <Typography sx={{ fontSize: 14, color: t.color.textMuted, mt: 1 }}>
          {x ? <>${x.navUsd.toFixed(4)} per share · {fmtCompact(x.tvlUsd)} held · {sharesOut.toLocaleString('en-US', { maximumFractionDigits: 2 })} shares issued{!official && <> · made by <Box component="a" href={`${ic.explorer}/address/${x.owner}`} target="_blank" rel="noopener noreferrer" sx={{ color: t.color.text }}>{short(x.owner)}</Box></>}</> : ' '}
        </Typography>
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mt: 2.5 }}>
          <Button component={Link} to={`/index?${ic.key === 'base' ? 'chain=base&' : ''}index=${address}#index-composer`} disabled={!x?.tradable} sx={{ ...Bt, height: 44, px: 2.5 }}>Buy {x?.symbol ?? ''}</Button>
          <Button component={Link} to={`/index/create${ic.key === 'base' ? '?chain=base' : ''}`} sx={{ ...Lt, height: 44, px: 2.5 }}>Make your own</Button>
          <Box component="a" href={`${ic.explorer}/address/${address}`} target="_blank" rel="noopener noreferrer" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, fontSize: 13, color: t.color.text, textDecoration: 'none', ml: 1 }}>Contract <ExternalIcon size={12} /></Box>
        </Box>
      </Box>
      {!official && <Typography sx={{ fontSize: 12, color: t.color.textLabel, mt: 2 }}>Made by its creator with the open factory, not by Verdex. Its units are fixed and nobody can change them; check what is in it before you buy.</Typography>}
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '2fr 3fr' }, gap: 2.5, mt: 4 }}>
        <Panel sx={{ p: 3 }}>
          <Typography sx={{ fontSize: 16, fontWeight: 500 }}>What one share holds</Typography>
          <Box sx={{ display: 'grid', gap: 0.75, mt: 2 }}>
            {(x?.components ?? []).map((c) => (
              <Box key={c.token} component={Link} to={`/assets/${c.stock?.ticker ?? ''}`} sx={{ display: 'flex', alignItems: 'center', gap: 1.25, p: 1.25, borderRadius: t.radius.input, background: t.color.raised, textDecoration: 'none', color: t.color.text }}>
                <Avatar src={resolveImg(c.stock?.logo)} sx={{ width: 22, height: 22, background: z.surface2, fontSize: 9 }}>{(c.stock?.ticker ?? '?')[0]}</Avatar>
                <Typography sx={{ fontSize: 13, fontWeight: 500, flex: 1 }}>{c.stock?.ticker ?? short(c.token)}</Typography>
                <Typography sx={{ fontSize: 13, color: t.color.textMuted }}>{(c.weight * 100).toFixed(1)}%</Typography>
              </Box>
            ))}
          </Box>
        </Panel>
        <Panel sx={{ p: 3 }}>
          {x ? <BacktestPanel ic={ic} legs={x.components.map((c) => ({ ticker: c.stock?.ticker ?? c.token, weight: c.weight }))} /> : <Box sx={{ height: 260 }} />}
        </Panel>
      </Box>
    </Page>
  )
}
