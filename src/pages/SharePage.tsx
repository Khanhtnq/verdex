// Share cards: your bag, any index or your holder rank, as an image made on your device from numbers read from the chain.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Button, Typography } from '@mui/material'
import { useQueries } from '@tanstack/react-query'
import { t } from '../theme/tokens'
import { Bt, Lt, Vg } from '../theme/styles'
import { useAssets } from '../lib/api'
import { usePools, usePoolsOn } from '../lib/pools'
import { ROBINHOOD_INDEX, BASE_INDEX } from '../lib/indexChains'
import { useIndexes, type IndexInfo } from '../lib/indexes'
import { useWalletStocks } from '../lib/copy'
import { useHolders, standing } from '../lib/holders'
import { readCandles, type ChainKey } from '../lib/candles'
import { backtest } from '../lib/backtest'
import { drawCard, type Card } from '../lib/cards'
import { resolveImg } from '../lib/img'
import { useWallet } from '../components/wallet/WalletProvider'
import { EarlyGate } from '../components/EarlyGate'
import { Page, PageHero, Panel } from './common'

type Kind = 'bag' | 'index' | 'rank'
const usd = (v: number) => `$${v >= 1000 ? Math.round(v).toLocaleString('en-US') : v.toFixed(2)}`
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
const sign = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`

function useIndexSeries(x: IndexInfo | undefined) {
  const legs = x?.components ?? []
  const spy = useMemo(() => x?.components.find((c) => c.stock?.ticker === 'SPY')?.pool?.address, [x])
  const pools = [...legs.map((c) => c.pool?.address), spy].filter(Boolean) as string[]
  const qs = useQueries({ queries: pools.map((p) => ({ queryKey: ['candles', x?.chain.key, p.toLowerCase()], queryFn: () => readCandles(x!.chain.key as ChainKey, p), enabled: !!x, staleTime: 15 * 60_000 })) })
  if (!x || qs.some((q) => q.isLoading)) return null
  return backtest(legs.map((c, i) => ({ ticker: c.stock?.ticker ?? c.token, weight: c.weight, candles: qs[i]?.data })), 30)
}

export default function SharePage() {
  const { account, openWalletMenu } = useWallet()
  const [kind, setKind] = useState<Kind>('bag')
  const [hideAmounts, setHideAmounts] = useState(false)
  const [hideAddress, setHideAddress] = useState(false)
  const assets = useAssets()
  const pools = usePools(assets.data?.assets)
  const bag = useWalletStocks(account?.address ?? '', assets.data?.assets, pools.data)
  const rhPools = usePoolsOn(ROBINHOOD_INDEX, assets.data?.assets)
  const basePools = usePoolsOn(BASE_INDEX, assets.data?.assets)
  const rh = useIndexes(ROBINHOOD_INDEX, assets.data?.assets, rhPools.data)
  const base = useIndexes(BASE_INDEX, assets.data?.assets, basePools.data)
  const all = useMemo(() => [...(rh.data ?? []), ...(base.data ?? [])], [rh.data, base.data])
  const [pick, setPick] = useState<string>()
  const ix = all.find((x) => x.address === pick) ?? all[0]
  const bt = useIndexSeries(kind === 'index' ? ix : undefined)
  const holders = useHolders()
  const me = holders.data && account ? standing(holders.data, account.address) : null
  const canvas = useRef<HTMLCanvasElement>(null)
  const [drawn, setUrl] = useState<{ for: Card; src: string }>()
  const who = account && !hideAddress ? short(account.address) : 'a Verdex wallet'

  const card: Card | null = useMemo(() => {
    if (kind === 'bag') {
      const hs = (bag.data?.holdings ?? []).filter((h) => h.usd > 0.5).sort((a, b) => b.usd - a.usd)
      const total = hs.reduce((s, h) => s + h.usd, 0)
      if (!hs.length) return null
      return { kicker: 'My bag', title: `Tokenized stocks held by ${who}`, big: hideAmounts ? `${hs.length} stocks` : usd(total), sub: hideAmounts ? 'weights only' : `${hs.length} stocks, valued at the pools`, rows: hs.slice(0, 8).map((h) => ({ label: h.stock.ticker, value: hideAmounts ? `${((h.usd / total) * 100).toFixed(1)}%` : usd(h.usd), share: h.usd / hs[0].usd, logo: resolveImg(h.stock.logo) })), foot: 'Read from Robinhood Chain when this card was made.' }
    }
    if (kind === 'index' && ix) {
      return { kicker: 'Index', title: `${ix.name} · ${ix.chain.name}`, big: ix.symbol, sub: bt ? `${sign(bt.ret)} over 30 days, held at fixed units` : 'reading the candles…', rows: ix.components.slice().sort((a, b) => b.weight - a.weight).map((c) => ({ label: c.stock?.ticker ?? short(c.token), value: `${(c.weight * 100).toFixed(1)}%`, share: c.weight / Math.max(...ix.components.map((k) => k.weight)), logo: resolveImg(c.stock?.logo) })), series: bt?.value, foot: `useverdex.xyz/index/${ix.chain.key}/${ix.address}`.slice(0, 80) }
    }
    if (kind === 'rank' && me?.rank && holders.data) {
      return { kicker: 'Holder', title: `VERDEX holder ${who}`, big: `#${me.rank}`, sub: `of ${me.of} holders · top ${me.topPct}%`, rows: [{ label: 'Share', value: hideAmounts ? 'hidden' : `${me.share.toFixed(3)}%`, share: Math.min(1, me.share / 2) }, { label: 'Early access', value: me.early ? 'yes' : 'not yet', share: me.early ? 1 : 0.2 }, { label: 'Holders', value: String(holders.data.holders), share: 1 }, { label: 'New this week', value: `+${holders.data.newHolders.week}`, share: 0.5 }], foot: 'Read from the VERDEX token on Robinhood Chain.' }
    }
    return null
  }, [kind, bag.data, ix, bt, me, holders.data, hideAmounts, who])

  useEffect(() => {
    let live = true
    const el = canvas.current
    if (!card || !el) return
    void drawCard(el, card, '/favicon-verdex.svg').then(() => { if (live) setUrl({ for: card, src: el.toDataURL('image/png') }) })
    return () => { live = false }
  }, [card])

  const url = card && drawn?.for === card ? drawn.src : undefined
  const download = () => { if (!url) return; const a = document.createElement('a'); a.href = url; a.download = `verdex-${kind}.png`; a.click() }
  const copy = async () => { if (!canvas.current) return; canvas.current.toBlob((b) => { if (b) void navigator.clipboard.write([new ClipboardItem({ 'image/png': b })]).catch(() => {}) }) }
  const tweet = `https://x.com/intent/post?text=${encodeURIComponent(kind === 'index' && ix ? `${ix.symbol} on @useverdex: useverdex.xyz/index/${ix.chain.key}/${ix.address}` : kind === 'rank' ? 'My VERDEX holder card from @useverdex useverdex.xyz/holders' : 'My tokenized stocks, from @useverdex useverdex.xyz')}`
  const needWallet = (kind === 'bag' || kind === 'rank') && !account
  return (
    <EarlyGate path="/share">
      <Page>
        <PageHero label="Share cards" badges={<Box sx={{ ...Vg, ml: 0, background: 'rgba(194,234,138,.16)', color: t.color.mark }}>New</Box>} title={<>Your bag,<br />as an image.</>}
          lead="Your holdings, any index or your VERDEX holder rank as a clean image, ready to post. The numbers are read from the chain when you make it; the image is drawn on your device and goes nowhere unless you post it." />
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mt: 3 }}>
          {([['bag', 'My bag'], ['index', 'An index'], ['rank', 'My holder rank']] as const).map(([k, l]) => <Box key={k} component="button" type="button" onClick={() => setKind(k)} aria-pressed={kind === k} sx={{ all: 'unset', cursor: 'pointer', ...Vg, ml: 0, ...(kind === k && { background: t.color.text, color: t.color.page }) }}>{l}</Box>)}
          <Box sx={{ flex: 1 }} />
          {kind !== 'index' && <Box component="button" type="button" onClick={() => setHideAmounts((v) => !v)} aria-pressed={hideAmounts} sx={{ all: 'unset', cursor: 'pointer', ...Vg, ml: 0, ...(hideAmounts && { background: t.color.text, color: t.color.page }) }}>Hide amounts</Box>}
          {kind !== 'index' && <Box component="button" type="button" onClick={() => setHideAddress((v) => !v)} aria-pressed={hideAddress} sx={{ all: 'unset', cursor: 'pointer', ...Vg, ml: 0, ...(hideAddress && { background: t.color.text, color: t.color.page }) }}>Hide address</Box>}
        </Box>
        {kind === 'index' && <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap', mt: 2 }}>{all.map((x) => <Box key={x.address} component="button" type="button" onClick={() => setPick(x.address)} aria-pressed={x.address === ix?.address} sx={{ all: 'unset', cursor: 'pointer', ...Vg, ml: 0, fontSize: 12, ...(x.address === ix?.address && { background: t.color.text, color: t.color.page }) }}>{x.symbol} · {x.chain.name}</Box>)}</Box>}
        <Panel sx={{ mt: 2.5, p: { xs: 1.5, md: 2.5 } }}>
          <canvas ref={canvas} style={{ display: 'none' }} />
          {url ? <Box component="img" src={url} alt="Share card preview" sx={{ width: '100%', borderRadius: '12px', display: 'block' }} /> : (
            <Box sx={{ aspectRatio: '16 / 9', display: 'grid', placeItems: 'center', borderRadius: '12px', background: t.color.raised }}>
              {needWallet ? <Button onClick={openWalletMenu} sx={{ ...Bt, height: 44, px: 2.5 }}>Connect wallet</Button> : <Typography sx={{ fontSize: 14, color: t.color.textMuted }}>{kind === 'bag' && bag.data ? 'This wallet holds no tokenized stocks on Robinhood Chain yet.' : kind === 'rank' && holders.data && !me?.rank ? 'This wallet holds no VERDEX yet.' : 'Reading the chain…'}</Typography>}
            </Box>
          )}
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mt: 2 }}>
            <Button disabled={!url} onClick={download} sx={{ ...Bt, height: 40, px: 2.25 }}>Download</Button>
            <Button disabled={!url} onClick={() => void copy()} sx={{ ...Lt, height: 40, px: 2 }}>Copy image</Button>
            <Button disabled={!url} component="a" href={tweet} target="_blank" rel="noopener noreferrer" sx={{ ...Lt, height: 40, px: 2 }}>Post on X</Button>
          </Box>
          <Typography sx={{ fontSize: 12, color: t.color.textLabel, mt: 1.5 }}>X does not take images from a link: download or copy the card, then attach it to the post.</Typography>
        </Panel>
      </Page>
    </EarlyGate>
  )
}
