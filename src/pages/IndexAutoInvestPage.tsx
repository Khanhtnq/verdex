// Auto-Invest into any index: a recurring buy of a Verdex or community index on Robinhood Chain that runs while the
// wallet is closed, through contracts/VerdexIndexPlans.sol.
import { useMemo, useState } from 'react'
import { Box, Button, Typography } from '@mui/material'
import { useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { formatUnits, parseUnits } from 'viem'
import { t } from '../theme/tokens'
import { Bt, Lt, Vg } from '../theme/styles'
import { useAssets, useChains } from '../lib/api'
import { describeError, type ChainX } from '../lib/lifi'
import { PHASE_LABEL, usePoolsOn, type Phase } from '../lib/pools'
import { ROBINHOOD_INDEX } from '../lib/indexChains'
import { isOfficial, useIndexes } from '../lib/indexes'
import { CADENCES, PLANS, TIP, UNTIL_STOPPED, budgetFor, cancelPlan, createPlan, revoke, setPaused, useAllowance, usePlans } from '../lib/indexPlans'
import { useWallet } from '../components/wallet/WalletProvider'
import { EarlyGate } from '../components/EarlyGate'
import { ExternalIcon } from '../components/icons'
import { Page, PageHero, Panel } from './common'

const Label = ({ children }: { children: React.ReactNode }) => <Typography sx={{ ...t.type.overline, color: t.color.textLabel, mb: 1.25 }}>{children}</Typography>
const $ = (v: bigint) => `$${Number(formatUnits(v, 6)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const when = (s: number) => new Date(s * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const chip = (on: boolean) => ({ all: 'unset', cursor: 'pointer', ...Vg, ml: 0, ...(on && { background: t.color.text, color: t.color.page }) }) as const

export default function IndexAutoInvestPage() {
  const wallet = useWallet()
  const { data: chains } = useChains()
  const chain = chains?.find((c) => c.id === 4663) as ChainX | undefined
  const assets = useAssets()
  const pools = usePoolsOn(ROBINHOOD_INDEX, assets.data?.assets)
  const indexes = useIndexes(ROBINHOOD_INDEX, assets.data?.assets, pools.data)
  const list = useMemo(() => (indexes.data ?? []).filter((x) => x.tradable).sort((a, b) => Number(isOfficial(b.address)) - Number(isOfficial(a.address))), [indexes.data])
  const [pick, setPick] = useState<string>()
  const x = list.find((i) => i.address === pick) ?? list[0]
  const [amount, setAmount] = useState(50)
  const [cad, setCad] = useState(CADENCES[1])
  const [buys, setBuys] = useState(12)
  const [tx, setTx] = useState<{ phase: Phase; error?: string }>({ phase: 'idle' })
  const busy = tx.phase !== 'idle' && tx.phase !== 'done' && tx.phase !== 'failed'
  const plans = usePlans(wallet.account?.address)
  const allowance = useAllowance(wallet.account?.address)
  const qc = useQueryClient()
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['index-plans'] }); void qc.invalidateQueries({ queryKey: ['index-plans-allowance'] }) }
  const ctx = (set: (p: Phase) => void) => ({ walletClient: wallet.walletClient!, account: wallet.account!, chain, switchChain: wallet.switchChain, onPhase: set })
  const raw = parseUnits(String(amount), 6)
  const budget = budgetFor(raw, buys, cad.s)
  const go = async () => {
    if (!wallet.account || !x) return
    setTx({ phase: 'switching' })
    try { await createPlan(ctx((p) => setTx({ phase: p })), x, raw, cad.s, buys, allowance.data ?? 0n); setTx({ phase: 'done' }); refresh() } catch (e) { setTx({ phase: 'failed', error: describeError(e) }) }
  }
  const act = async (f: () => Promise<unknown>) => { try { await f(); refresh() } catch { /* the wallet shows it */ } }
  const nameOf = (a: string) => indexes.data?.find((i) => i.address.toLowerCase() === a.toLowerCase())
  return (
    <EarlyGate path="/index/auto-invest">
      <Page>
        <PageHero label="Auto-Invest into any index" badges={<Box sx={{ ...Vg, ml: 0, background: 'rgba(194,234,138,.16)', color: t.color.mark }}>New</Box>} title={<>A basket that<br />buys itself.</>}
          lead="A daily, weekly or monthly buy of any index on Robinhood Chain, a Verdex one or one the community made, that runs while your wallet is closed. You approve an exact USDG budget; on schedule the executor buys the shares through the index router with a cap on every leg, and the shares land in your wallet with whatever was not spent. Nothing is held between buys. Pause, cancel or revoke whenever you like." />
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0,1fr)', md: 'minmax(0,1fr) 420px' }, gap: 2.5, mt: 4, alignItems: 'start' }}>
          <Panel sx={{ p: { xs: 2.5, md: 3 } }}>
            <Typography sx={{ fontSize: 16, fontWeight: 500 }}>Your plans</Typography>
            <Box sx={{ display: 'grid', gap: 1, mt: 2 }}>
              {(plans.data ?? []).map((p) => { const ix = nameOf(p.index); const state = p.cancelled ? 'Cancelled' : p.buysLeft === 0 ? 'Finished' : p.paused ? 'Paused' : `Next buy ${when(p.nextAt)}`; return (
                <Box key={p.id.toString()} sx={{ p: 1.75, borderRadius: t.radius.input, background: t.color.raised }}>
                  <Typography sx={{ fontSize: 14, fontWeight: 500 }}>{$(p.amount)} of {ix?.symbol ?? p.index.slice(0, 8)} · {CADENCES.find((c) => c.s === p.interval)?.label.toLowerCase() ?? `every ${p.interval / 3600}h`}</Typography>
                  <Typography sx={{ fontSize: 12, color: t.color.textMuted, mt: 0.5 }}>{state} · {p.buysDone} buys, {$(p.spent)} spent, {Number(formatUnits(p.shares, 18)).toFixed(4)} shares{p.buysLeft !== UNTIL_STOPPED && !p.cancelled ? ` · ${p.buysLeft} left` : ''} · plan #{p.id.toString()}</Typography>
                  {!p.cancelled && p.buysLeft > 0 && <Box sx={{ display: 'flex', gap: 1, mt: 1.25 }}>
                    <Button onClick={() => void act(() => setPaused(ctx(() => {}), p.id, !p.paused))} sx={{ ...Lt, backdropFilter: 'none', height: 30, px: 1.5 }}>{p.paused ? 'Resume' : 'Pause'}</Button>
                    <Button onClick={() => void act(() => cancelPlan(ctx(() => {}), p.id))} sx={{ ...Lt, backdropFilter: 'none', height: 30, px: 1.5, color: t.color.red }}>Cancel</Button>
                  </Box>}
                </Box>) })}
              {wallet.account && plans.data?.length === 0 && <Typography sx={{ fontSize: 13, color: t.color.textMuted }}>No plan yet. Set one up on the right.</Typography>}
              {!wallet.account && <Typography sx={{ fontSize: 13, color: t.color.textMuted }}>Connect to see your plans.</Typography>}
            </Box>
            {wallet.account && (allowance.data ?? 0n) > 0n && <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 2, mt: 2.5, p: 1.5, borderRadius: t.radius.input, background: t.color.hover }}><Typography sx={{ fontSize: 13 }}>The contract may pull up to {$(allowance.data ?? 0n)} USDG.</Typography><Button onClick={() => void act(() => revoke(ctx(() => {})))} sx={{ ...Lt, backdropFilter: 'none', height: 30, px: 1.5, color: t.color.red }}>Revoke</Button></Box>}
            <Typography sx={{ fontSize: 12, color: t.color.textLabel, mt: 2.5 }}>contracts/VerdexIndexPlans.sol, verified, unaudited. The admin keeps only the executor list. <Box component="a" href={`https://robin.etherscan.io/address/${PLANS}`} target="_blank" rel="noopener noreferrer" sx={{ color: t.color.text, display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>Contract <ExternalIcon size={11} /></Box></Typography>
          </Panel>
          <Panel sx={{ p: { xs: 2.5, md: 3 } }}>
            <Label>Index</Label>
            <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap' }}>{list.map((i) => <Box key={i.address} component="button" type="button" onClick={() => setPick(i.address)} aria-pressed={i.address === x?.address} sx={chip(i.address === x?.address)}>{i.symbol}{isOfficial(i.address) ? '' : ' ·c'}</Box>)}</Box>
            {x && <Typography sx={{ fontSize: 12, color: t.color.textLabel, mt: 1 }}>{x.name}: {x.components.map((c) => c.stock?.ticker).join(', ')}. <Link to={`/index/robinhood/${x.address}`} style={{ color: t.color.text }}>Backtest</Link></Typography>}
            <Box sx={{ mt: 2.5 }}><Label>Each buy, in USDG</Label></Box>
            <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap' }}>{[25, 50, 100, 250, 500].map((a) => <Box key={a} component="button" type="button" onClick={() => setAmount(a)} aria-pressed={a === amount} sx={chip(a === amount)}>${a}</Box>)}</Box>
            <Box sx={{ mt: 2.5 }}><Label>How often</Label></Box>
            <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap' }}>{CADENCES.map((c) => <Box key={c.s} component="button" type="button" onClick={() => setCad(c)} aria-pressed={c.s === cad.s} sx={chip(c.s === cad.s)}>{c.label}</Box>)}</Box>
            <Box sx={{ mt: 2.5 }}><Label>How many buys</Label></Box>
            <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap' }}>{[4, 12, 26, 52, UNTIL_STOPPED].map((b) => <Box key={b} component="button" type="button" onClick={() => setBuys(b)} aria-pressed={b === buys} sx={chip(b === buys)}>{b === UNTIL_STOPPED ? 'Until I stop it' : b}</Box>)}</Box>
            <Box sx={{ display: 'grid', gap: 0.75, mt: 2.5 }}>
              {[['Each buy', `$${amount}, router fee included, the rest refunded`], ['Tip per buy', `${$(TIP)} to whoever runs it`], ['Price cap', '1% over the pools’ spot, on every leg'], ['Allowance to approve', `${$(budget)}${buys === UNTIL_STOPPED ? ', a year of buys' : ''}`], ['First buy', 'within ten minutes']].map(([k, v]) => <Box key={k} sx={{ display: 'flex', justifyContent: 'space-between', gap: 2 }}><Typography sx={{ fontSize: 13, color: t.color.textMuted }}>{k}</Typography><Typography sx={{ fontSize: 13, textAlign: 'right' }}>{v}</Typography></Box>)}
            </Box>
            <Button fullWidth disabled={!!wallet.account && (busy || !x)} onClick={() => (wallet.account ? void go() : wallet.openWalletMenu())} sx={{ ...Bt, height: 48, mt: 2.5 }}>{!wallet.account ? 'Connect wallet' : busy ? PHASE_LABEL[tx.phase] : `Approve and start buying ${x?.symbol ?? ''}`}</Button>
            {tx.phase === 'failed' && <Typography sx={{ fontSize: 12, color: t.color.red, mt: 1 }}>{tx.error}</Typography>}
            {tx.phase === 'done' && <Typography sx={{ fontSize: 13, color: t.color.mark, mt: 1 }}>The plan is on the chain. The first buy runs within ten minutes.</Typography>}
          </Panel>
        </Box>
      </Page>
    </EarlyGate>
  )
}
