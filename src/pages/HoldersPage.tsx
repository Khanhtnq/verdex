// VERDEX holders: who holds the token, how that has grown, and where the connected wallet stands. Every number is
// read from Robinhood Chain by the Verdex server (/api/holders) and links to the explorer.
import { useMemo, useState } from 'react'
import { Box, Button, Typography } from '@mui/material'
import { Link } from 'react-router-dom'
import { BRAND, t } from '../theme/tokens'
import { Bt, Lt, Vg } from '../theme/styles'
import { useHolders, standing, type Holders } from '../lib/holders'
import { useWallet } from '../components/wallet/WalletProvider'
import { ExternalIcon } from '../components/icons'
import { Page, PageHero, Panel, Stats } from './common'

const EXPLORER = 'https://robin.etherscan.io'
const fmt = (n: number, d = 0) => n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
const compact = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : fmt(n))
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
const pct = (v: number) => `${v >= 1 ? v.toFixed(2) : v >= 0.01 ? v.toFixed(3) : v.toFixed(4)}%`
const day = (s: number) => new Date(s * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

function Growth({ series }: { series: Holders['series'] }) {
  const W = 1000, H = 220, pad = 8
  const max = Math.max(...series.map((x) => x.holders), 1)
  const pts = series.map((x, i) => [pad + (i / Math.max(1, series.length - 1)) * (W - pad * 2), H - pad - (x.holders / max) * (H - pad * 2)])
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  return (
    <Box>
      <Box component="svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" sx={{ width: '100%', height: { xs: 160, md: 220 }, display: 'block' }} role="img" aria-label={`Holders over time, from ${series[0]?.holders} to ${series[series.length - 1]?.holders}`}>
        <path d={`${line} L${W - pad},${H - pad} L${pad},${H - pad} Z`} fill="rgba(194,234,138,.12)" />
        <path d={line} fill="none" stroke={t.color.mark} strokeWidth={2.5} vectorEffect="non-scaling-stroke" />
      </Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', mt: 1 }}>
        <Typography sx={{ fontSize: 12, color: t.color.textLabel }}>{series[0] && day(series[0].day)}</Typography>
        <Typography sx={{ fontSize: 12, color: t.color.textLabel }}>{series.length > 0 && `${fmt(series[series.length - 1].holders)} today`}</Typography>
      </Box>
    </Box>
  )
}

export default function HoldersPage() {
  const h = useHolders()
  const { account, openWalletMenu } = useWallet()
  const me = useMemo(() => (h.data ? standing(h.data, account?.address) : null), [h.data, account?.address])
  const [all, setAll] = useState(false)
  const d = h.data
  const people = d?.list.filter((r) => r.kind === 'wallet') ?? []
  const maxBucket = Math.max(1, ...(d?.buckets.map((b) => b.count) ?? [1]))
  const shown = all ? people.slice(0, 100) : people.slice(0, 25)
  return (
    <Page>
      <PageHero
        label="Holders"
        badges={<Box sx={{ ...Vg, ml: 0, background: 'rgba(194,234,138,.16)', color: t.color.mark }}>Live</Box>}
        title={<>{d ? fmt(d.holders) : '…'} wallets hold VERDEX.<br />Here they are.</>}
        lead={`Every wallet holding ${BRAND.name}'s token on Robinhood Chain, read from the token's full transfer history with each balance read from the token itself, so the list always adds up to the supply. The pool's liquidity and contracts are shown apart from people. Refreshed every two minutes.`}
        action={<Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>{!account && <Button onClick={openWalletMenu} sx={{ ...Bt, height: 44, px: 2.5 }}>Where do I stand?</Button>}<Button component={Link} to="/verdex" sx={{ ...Lt, height: 44, px: 2.5 }}>The token</Button></Box>}
      />
      <Stats items={[{ label: 'Holders', value: d ? fmt(d.holders) : '…' }, { label: 'New today', value: d ? `+${fmt(d.newHolders.day)}` : '…' }, { label: 'New this week', value: d ? `+${fmt(d.newHolders.week)}` : '…' }, { label: 'With early access', value: d ? fmt(d.earlyAccess) : '…' }]} />
      <Typography sx={{ fontSize: 12, color: t.color.textLabel, mt: 1.5 }}>
        {d ? <>Read from the token, <Box component="a" href={`${EXPLORER}/token/${d.token}`} target="_blank" rel="noopener noreferrer" sx={{ color: t.color.text }}>{short(d.token)}</Box>: {fmt(d.transfers.total)} transfers since the mint, {fmt(d.transfers.day)} in the last day. {pct(d.inPool)} of the supply sits in the Uniswap v4 pool as liquidity.</> : h.isError ? 'The holder list could not be read right now. It retries on its own.' : 'Reading the transfer history…'}
      </Typography>

      {account && d && me && (
        <Panel sx={{ mt: 4, p: { xs: 2.5, md: 3 } }}>
          <Typography sx={{ ...t.type.overline, color: t.color.textLabel }}>Your wallet</Typography>
          {me.rank ? (
            <>
              <Typography sx={{ fontSize: { xs: 26, md: 34 }, fontWeight: 500, mt: 1 }}>Holder #{fmt(me.rank)} of {fmt(me.of)}{me.topPct && me.topPct <= 50 ? <Box component="span" sx={{ color: t.color.mark }}> · top {me.topPct}%</Box> : null}</Typography>
              <Typography sx={{ fontSize: 14, color: t.color.textMuted, mt: 1 }}>{compact(me.verdex)} VERDEX, {pct(me.share)} of the supply{me.since ? `, holding since ${day(me.since)}` : ''}. {me.early ? 'You have early access: every new feature opens for you before everyone else.' : `${compact(me.toEarly)} more VERDEX and you have early access (0.5% of the supply): new features open for you first.`}</Typography>
            </>
          ) : (
            <Typography sx={{ fontSize: 15, color: t.color.textMuted, mt: 1 }}>This wallet holds no VERDEX yet. Holders at 0.5% of the supply use every new feature before it opens to everyone.</Typography>
          )}
        </Panel>
      )}

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '3fr 2fr' }, gap: 2.5, mt: 4 }}>
        <Panel sx={{ p: { xs: 2.5, md: 3 } }}>
          <Typography sx={{ fontSize: 16, fontWeight: 500 }}>Holders over time</Typography>
          <Typography sx={{ fontSize: 13, color: t.color.textMuted, mt: 0.5 }}>Wallets holding VERDEX today, counted from the day each first received it.</Typography>
          <Box sx={{ mt: 2 }}>{d ? <Growth series={d.series} /> : <Box sx={{ height: 220 }} />}</Box>
        </Panel>
        <Panel sx={{ p: { xs: 2.5, md: 3 } }}>
          <Typography sx={{ fontSize: 16, fontWeight: 500 }}>How it is spread</Typography>
          <Typography sx={{ fontSize: 13, color: t.color.textMuted, mt: 0.5 }}>Wallets by share of the supply. The top ten wallets hold {d ? pct(d.top10Share) : '…'}.</Typography>
          <Box sx={{ display: 'grid', gap: 1.25, mt: 2.5 }}>
            {(d?.buckets ?? []).map((b) => (
              <Box key={b.label}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}><Typography sx={{ fontSize: 13 }}>{b.label}</Typography><Typography sx={{ fontSize: 13, color: t.color.textMuted }}>{fmt(b.count)} wallets</Typography></Box>
                <Box sx={{ height: 8, borderRadius: 4, background: t.color.hover, mt: 0.5, overflow: 'hidden' }}><Box sx={{ height: '100%', width: `${(b.count / maxBucket) * 100}%`, background: t.color.mark, borderRadius: 4 }} /></Box>
              </Box>
            ))}
          </Box>
        </Panel>
      </Box>

      <Panel sx={{ mt: 2.5, p: { xs: 2.5, md: 3 } }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 2, flexWrap: 'wrap' }}>
          <Box>
            <Typography sx={{ fontSize: 16, fontWeight: 500 }}>Top holders</Typography>
            <Typography sx={{ fontSize: 13, color: t.color.textMuted, mt: 0.5 }}>Wallets only. The pool and contracts are listed below them.</Typography>
          </Box>
          {people.length > 25 && <Button onClick={() => setAll((x) => !x)} sx={{ ...Lt, backdropFilter: 'none', height: 34, px: 1.75 }}>{all ? 'Show 25' : 'Show 100'}</Button>}
        </Box>
        <Box sx={{ mt: 2, display: 'grid', gap: 0.5 }}>
          {shown.map((r, i) => {
            const mine = account && r.address.toLowerCase() === account.address.toLowerCase()
            return (
              <Box key={r.address} sx={{ display: 'grid', gridTemplateColumns: '44px 1fr auto auto', alignItems: 'center', gap: 2, px: 1.5, height: 44, borderRadius: t.radius.input, background: mine ? 'rgba(194,234,138,.12)' : i % 2 ? 'transparent' : t.color.raised }}>
                <Typography sx={{ fontSize: 13, color: t.color.textLabel }}>#{i + 1}</Typography>
                <Box component="a" href={`${EXPLORER}/address/${r.address}`} target="_blank" rel="noopener noreferrer" sx={{ fontSize: 13, color: t.color.text, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>{short(r.address)}{mine ? ' (you)' : ''} <ExternalIcon size={11} /></Box>
                <Typography sx={{ fontSize: 13, display: { xs: 'none', sm: 'block' } }}>{compact(r.verdex)}</Typography>
                <Typography sx={{ fontSize: 13, color: t.color.textMuted, width: 70, textAlign: 'right' }}>{pct(r.share)}</Typography>
              </Box>
            )
          })}
          {!d && <Typography sx={{ fontSize: 13, color: t.color.textMuted }}>Reading…</Typography>}
        </Box>
        {d && (
          <Box sx={{ mt: 2.5, display: 'grid', gap: 0.5 }}>
            {d.list.filter((r) => r.kind !== 'wallet').map((r) => (
              <Box key={r.address} sx={{ display: 'flex', justifyContent: 'space-between', gap: 2, px: 1.5, py: 1, borderRadius: t.radius.input, background: t.color.raised, fontSize: 13 }}>
                <Box component="a" href={`${EXPLORER}/address/${r.address}`} target="_blank" rel="noopener noreferrer" sx={{ fontSize: 13, color: t.color.text, textDecoration: 'none' }}>{r.kind === 'pool' ? 'Uniswap v4 pool (liquidity)' : `Contract ${short(r.address)}`}</Box>
                <Typography sx={{ fontSize: 13, color: t.color.textMuted }}>{compact(r.verdex)} · {pct(r.share)}</Typography>
              </Box>
            ))}
          </Box>
        )}
      </Panel>
      <Typography sx={{ fontSize: 12, color: t.color.textLabel, mt: 2 }}>The same data is open to anyone at <Box component="a" href="/api/holders" sx={{ color: t.color.text }}>/api/holders</Box>.</Typography>
    </Page>
  )
}
