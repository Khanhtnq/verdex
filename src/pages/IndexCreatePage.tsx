// Make your own index: pick stocks and weights, name it, backtest it, and deploy it from your wallet through the same
// factory as the Verdex indexes. The page turns weights into fixed units at today's pool prices (one share worth one
// dollar at creation); the factory checks the components and deploys the ERC-20.
import { useMemo, useState } from 'react'
import { Avatar, Box, Button, InputBase, Typography } from '@mui/material'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { t, z } from '../theme/tokens'
import { Bt, Lt, Vg } from '../theme/styles'
import { fmtCompact, useAssets, useChains } from '../lib/api'
import { describeError, type ChainX } from '../lib/lifi'
import { PHASE_LABEL, stockTokensOn, usePoolsOn, type Phase } from '../lib/pools'
import { INDEX_CHAINS, indexChain } from '../lib/indexChains'
import { COMMUNITY_CAP, createIndex, createdIndex, planWeights, poolForOn } from '../lib/indexes'
import { deepEnough } from '../lib/autopilot'
import { useFeatureOpen } from '../lib/holding'
import { resolveImg } from '../lib/img'
import { useWallet } from '../components/wallet/WalletProvider'
import { BacktestPanel } from '../components/BacktestPanel'
import { EarlyGate } from '../components/EarlyGate'
import { Page, PageHero, Panel } from './common'

type Tx = { phase: Phase; hash?: string; error?: string }
const Label = ({ children }: { children: React.ReactNode }) => <Typography sx={{ ...t.type.overline, color: t.color.textLabel, mb: 1.25 }}>{children}</Typography>
const nameProblem = (n: string) => (n.trim().length < 3 ? 'At least 3 characters.' : n.length > 40 ? 'At most 40 characters.' : /^\s*verdex/i.test(n) ? 'Names starting with Verdex are kept for Verdex’s own indexes.' : null)
const symbolProblem = (s: string) => (!/^[A-Z0-9]{2,8}$/.test(s) ? '2 to 8 letters or digits.' : /^VX/.test(s) ? 'Tickers starting with VX are kept for Verdex’s own indexes.' : null)

export default function IndexCreatePage() {
  const wallet = useWallet()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const ic = indexChain(params.get('chain') ?? undefined)
  const baseOpen = useFeatureOpen('/index/community', wallet.account?.address)
  const { data: chains } = useChains()
  const chain = chains?.find((c) => c.id === ic.id) as ChainX | undefined
  const assets = useAssets()
  const pools = usePoolsOn(ic, assets.data?.assets)
  const stocks = useMemo(() => (assets.data && pools.data ? stockTokensOn(assets.data.assets, ic.id).filter((s) => deepEnough(poolForOn(ic, s, pools.data!))) : []), [assets.data, pools.data, ic])
  const [q, setQ] = useState('')
  const [picked, setPicked] = useState<{ ticker: string; weight: number }[]>([])
  const [name, setName] = useState('')
  const [symbol, setSymbol] = useState('')
  const [tx, setTx] = useState<Tx>({ phase: 'idle' })
  const busy = tx.phase !== 'idle' && tx.phase !== 'done' && tx.phase !== 'failed'
  const toggle = (tk: string) => setPicked((p) => { const has = p.some((x) => x.ticker === tk); const next = has ? p.filter((x) => x.ticker !== tk) : p.length >= 20 ? p : [...p, { ticker: tk, weight: 0 }]; return next.map((x) => ({ ...x, weight: 1 / Math.max(1, next.length) })) })
  const setW = (i: number, v: string) => setPicked((p) => p.map((x, k) => (k === i ? { ...x, weight: Math.max(0, Number(v) || 0) / 100 } : x)))
  const sum = picked.reduce((s, x) => s + x.weight, 0)
  const plan = useMemo(() => (pools.data && picked.length ? planWeights(ic, name.trim(), symbol, picked, stocks, pools.data) : null), [pools.data, picked, ic, name, symbol, stocks])
  const problem = nameProblem(name) ?? symbolProblem(symbol) ?? (picked.length < 2 ? 'Pick at least 2 stocks.' : Math.abs(sum - 1) > 0.002 ? 'Weights must add up to 100%.' : plan?.missing.length ? `No deep pool for ${plan.missing.join(', ')}.` : null)
  const shown = stocks.filter((s) => !q || s.ticker.toLowerCase().includes(q.toLowerCase()) || s.name.toLowerCase().includes(q.toLowerCase())).slice(0, q ? 40 : 24)
  const go = async () => {
    if (!wallet.walletClient || !wallet.account || !plan || problem) return
    setTx({ phase: 'switching' })
    try {
      const hash = await createIndex({ walletClient: wallet.walletClient, account: wallet.account, chain, switchChain: wallet.switchChain, onPhase: (p: Phase) => setTx((x) => ({ ...x, phase: p })) }, ic, ic.factory, plan, COMMUNITY_CAP)
      setTx({ phase: 'pending', hash })
      const address = await createdIndex(ic, hash)
      setTx({ phase: 'done', hash })
      if (address) navigate(`/index/${ic.key}/${address}`)
    } catch (e) { setTx({ phase: 'failed', error: describeError(e) }) }
  }
  const page = (
    <Page>
      <PageHero label="Make your own index" badges={<Box sx={{ ...Vg, ml: 0, background: 'rgba(194,234,138,.16)', color: t.color.mark }}>New</Box>}
        title={<>Your stocks. Your ticker.<br />Your index.</>}
        lead={`Up to 20 tokenized stocks at your weights, as a real ERC-20 on ${ic.name} backed by the stocks themselves. Anyone can buy it, sell it or redeem it for the stocks through the same router as the Verdex indexes. The units are fixed at creation and nobody can change them, including you. You pay the gas; there is nothing else to pay.`}
        action={<Button component={Link} to="/index/community" sx={{ ...Lt, height: 44, px: 2.5 }}>Community indexes</Button>} />
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mt: 3 }}>
        {INDEX_CHAINS.filter((c) => c.deployed && (c.key === 'robinhood' || baseOpen)).map((c) => <Box key={c.key} component="button" type="button" onClick={() => { setParams(c.key === 'robinhood' ? {} : { chain: c.key }); setPicked([]) }} aria-pressed={c.key === ic.key} sx={{ all: 'unset', cursor: 'pointer', ...Vg, ml: 0, ...(c.key === ic.key && { background: t.color.text, color: t.color.page }) }}>{c.name}</Box>)}
      </Box>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0,1fr)', md: 'minmax(0,1fr) 420px' }, gap: 2.5, mt: 4, alignItems: 'start' }}>
        <Panel sx={{ p: { xs: 2.5, md: 3 } }}>
          <Label>Stocks on {ic.name}, deep pools only</Label>
          <InputBase value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a ticker or a name" inputProps={{ 'aria-label': 'Search stocks' }} sx={{ width: '100%', height: 40, px: 1.5, borderRadius: t.radius.input, background: t.color.hover, fontSize: 14 }} />
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, mt: 1.5 }}>
            {shown.map((s) => { const on = picked.some((x) => x.ticker === s.ticker); return (
              <Box key={s.address} component="button" type="button" onClick={() => toggle(s.ticker)} aria-pressed={on} sx={{ all: 'unset', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 0.75, height: 32, px: 1.25, borderRadius: t.radius.input, fontSize: 13, fontWeight: 500, background: on ? t.color.text : t.color.chip, color: on ? t.color.page : t.color.text }}>
                <Avatar src={resolveImg(s.logo)} sx={{ width: 16, height: 16, background: z.surface2, fontSize: 8 }}>{s.ticker[0]}</Avatar>{s.ticker}
              </Box>) })}
            {!pools.data && <Typography sx={{ fontSize: 13, color: t.color.textMuted }}>Reading the pools on {ic.name}…</Typography>}
          </Box>
          {picked.length > 0 && (
            <Box sx={{ mt: 3, display: 'grid', gap: 0.75 }}>
              <Label>Weights</Label>
              {picked.map((x, i) => { const leg = plan?.legs.find((l) => l.ticker === x.ticker); return (
                <Box key={x.ticker} sx={{ display: 'flex', alignItems: 'center', gap: 1.5, p: 1, pl: 1.5, borderRadius: t.radius.input, background: t.color.raised }}>
                  <Typography sx={{ fontSize: 13, fontWeight: 500, width: 70 }}>{x.ticker}</Typography>
                  <Typography sx={{ fontSize: 12, color: t.color.textMuted, flex: 1 }}>{leg ? `$${leg.priceUsd.toFixed(2)} · pool ${fmtCompact(leg.liquidityUsd)}` : ''}</Typography>
                  <InputBase value={(x.weight * 100).toFixed(1).replace(/\.0$/, '')} onChange={(e) => setW(i, e.target.value.replace(/[^0-9.]/g, ''))} inputProps={{ 'aria-label': `${x.ticker} weight`, inputMode: 'decimal' }} sx={{ width: 64, height: 32, px: 1, borderRadius: t.radius.input, background: t.color.hover, fontSize: 13 }} />
                  <Typography sx={{ fontSize: 12, color: t.color.textMuted }}>%</Typography>
                </Box>) })}
              <Box sx={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: Math.abs(sum - 1) < 0.002 ? t.color.textLabel : t.color.red }}>
                <span>{picked.length} of 20 stocks</span><span>{(sum * 100).toFixed(1)}%</span>
                <Box component="button" type="button" onClick={() => setPicked((p) => p.map((x) => ({ ...x, weight: 1 / p.length })))} sx={{ all: 'unset', cursor: 'pointer', color: t.color.text }}>Equal weights</Box>
              </Box>
              {picked.length >= 2 && Math.abs(sum - 1) < 0.002 && <Box sx={{ mt: 2, p: 2, borderRadius: t.radius.input, background: t.color.raised }}><BacktestPanel ic={ic} legs={picked} compact /></Box>}
            </Box>
          )}
        </Panel>
        <Panel sx={{ p: { xs: 2.5, md: 3 }, position: { md: 'sticky' }, top: { md: 96 } }}>
          <Label>Name</Label>
          <InputBase value={name} onChange={(e) => setName(e.target.value.slice(0, 40))} placeholder="Space and Rockets" inputProps={{ 'aria-label': 'Index name' }} sx={{ width: '100%', height: 44, px: 1.5, borderRadius: t.radius.input, background: t.color.hover, fontSize: 15 }} />
          <Box sx={{ mt: 2 }}><Label>Ticker</Label></Box>
          <InputBase value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8))} placeholder="ROCKET" inputProps={{ 'aria-label': 'Index ticker' }} sx={{ width: '100%', height: 44, px: 1.5, borderRadius: t.radius.input, background: t.color.hover, fontSize: 15 }} />
          <Box sx={{ mt: 2.5, display: 'grid', gap: 1, fontSize: 13 }}>
            {[['One share at creation', '$1.00 of the basket'], ['Most shares ever', '1,000,000'], ['Units', 'fixed forever, set from today’s prices'], ['You pay', 'the gas, nothing else'], ['Verdex fee on trades', '0.25%, none for VERDEX holders']].map(([k, v]) => <Box key={k} sx={{ display: 'flex', justifyContent: 'space-between', gap: 2 }}><Typography sx={{ fontSize: 13, color: t.color.textMuted }}>{k}</Typography><Typography sx={{ fontSize: 13, textAlign: 'right' }}>{v}</Typography></Box>)}
          </Box>
          {problem && (name || symbol || picked.length > 0) && <Typography sx={{ fontSize: 12, color: t.color.red, mt: 2 }}>{problem}</Typography>}
          <Button fullWidth disabled={!!wallet.account && (!!problem || busy)} onClick={() => (wallet.account ? void go() : wallet.openWalletMenu())} sx={{ ...Bt, height: 48, mt: 2.5 }}>{!wallet.account ? 'Connect wallet' : busy ? PHASE_LABEL[tx.phase] : `Deploy ${symbol || 'the index'} on ${ic.name}`}</Button>
          {tx.phase === 'failed' && <Typography sx={{ fontSize: 12, color: t.color.red, mt: 1 }}>{tx.error}</Typography>}
          <Typography sx={{ fontSize: 12, color: t.color.textLabel, mt: 2 }}>The index contract is the same verified code as the Verdex indexes, and unaudited. It holds the stocks and nothing else. Your index is listed with your wallet as its creator.</Typography>
        </Panel>
      </Box>
    </Page>
  )
  return <EarlyGate path={ic.key === 'base' ? '/index/community' : '/index/create'}>{page}</EarlyGate>
}
