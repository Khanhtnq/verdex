// Vaults without you: target weights over tokenized stocks kept by a contract on Robinhood Chain and
// rebalanced while the owner is away. The page creates vaults, approves the holdings, lists vaults with
// their live drift, and pauses, resumes or runs them.
import { useMemo, useState } from 'react'
import { Avatar, Box, Button, InputBase, Typography } from '@mui/material'
import { Link, useSearchParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { BRAND, t, z } from '../theme/tokens'
import { Bt, Lt, Vg } from '../theme/styles'
import { fmtCompact, useAssets, useChains } from '../lib/api'
import { useClock, useFeatureOpen } from '../lib/holding'
import { describeError, type ChainX } from '../lib/lifi'
import { PHASE_LABEL, stockTokensOn, usePoolsOn, type Phase, type Pool, type StockToken } from '../lib/pools'
import { DEFAULT_SLIPPAGE_BPS, DEFAULT_TIP, INTERVALS, PRESETS, THRESHOLDS, VAULT_CHAINS, approveHoldings, createVault, deepEnough, fmtUsdg, fmtWhen, intervalLabel, normalise, poolFor, presetTargets, revokeHoldings, runNow, setPaused, toBps, useOnchainVaults, useVaultTotals, vaultChain, type OnchainLeg, type OnchainVault, type Target, type VaultChain } from '../lib/vaultsOnchain'
import { EarlyGate } from '../components/EarlyGate'
import { BacktestPanel } from '../components/BacktestPanel'
import { resolveImg } from '../lib/img'
import { useWallet } from '../components/wallet/WalletProvider'
import { CheckIcon, ExternalIcon, LockIcon, PauseIcon, RefreshIcon, ShieldIcon, VaultIcon, WalletIcon } from '../components/icons'
import { MarkIcon } from '../components/Logo'
import { Page, PageHero, Panel, Stats } from './common'

type Ctx = ReturnType<typeof useWallet>
type Tx = { phase: Phase; error?: string; hash?: string }
const txCtx = (w: Ctx, chain: ChainX | undefined, onPhase: (p: Phase) => void) => ({ walletClient: w.walletClient!, account: w.account!, chain, switchChain: w.switchChain, onPhase })

function Label({ children }: { children: React.ReactNode }) {
  return <Typography sx={{ ...t.type.overline, color: t.color.textLabel, mb: 1.25 }}>{children}</Typography>
}
function Choice({ on, onClick, children, disabled }: { on: boolean; onClick: () => void; children: React.ReactNode; disabled?: boolean }) {
  return (
    <Box component="button" type="button" onClick={onClick} disabled={disabled} aria-pressed={on} sx={{ all: 'unset', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.4 : 1, display: 'inline-flex', alignItems: 'center', gap: '8px', height: 34, px: '12px', borderRadius: t.radius.input, fontSize: 13, fontWeight: 500, background: on ? t.color.text : t.color.chip, color: on ? t.color.page : t.color.text, '&:hover': { background: on ? t.color.text : t.color.hover } }}>
      {children}
    </Box>
  )
}
function Step({ n, icon, title, text }: { n: number; icon: React.ReactNode; title: string; text: string }) {
  return (
    <Panel sx={{ p: 3 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Box sx={{ width: 44, height: 44, borderRadius: '12px', background: t.color.hover, display: 'grid', placeItems: 'center', color: t.color.mark }}>{icon}</Box>
        <Typography sx={{ ...t.type.caption, color: t.color.textFaint }}>0{n}</Typography>
      </Box>
      <Typography sx={{ ...t.type.cardTitle, color: t.color.text, mt: 2.5 }}>{title}</Typography>
      <Typography sx={{ ...t.type.small, color: t.color.textMuted, mt: 1 }}>{text}</Typography>
    </Panel>
  )
}
function Row({ k, v, strong }: { k: string; v: React.ReactNode; strong?: boolean }) {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 2, fontSize: 13 }}>
      <Typography sx={{ fontSize: 13, color: t.color.textMuted }}>{k}</Typography>
      <Typography sx={{ fontSize: 13, fontWeight: strong ? 500 : 400, textAlign: 'right' }}>{v}</Typography>
    </Box>
  )
}
const pct = (bps: number, d = 1) => `${(bps / 100).toFixed(d)}%`

function Composer({ vc, stocks, pools, loading, wallet, chain, onDone }: { vc: VaultChain; stocks: StockToken[]; pools: Pool[]; loading: boolean; wallet: Ctx; chain: ChainX | undefined; onDone: () => void }) {
  // A draft can arrive in the query string (from Copy a wallet): TICKER:WEIGHT pairs become the custom targets.
  const [params] = useSearchParams()
  const btOpen = useFeatureOpen('/backtest', wallet.account?.address)
  const [wanted] = useState(() => (params.get('tokens') ?? '').split(',').map((x) => { const [tk, w] = x.split(':'); return { ticker: tk.trim().toUpperCase(), weight: Number(w) } }).filter((x) => x.ticker && isFinite(x.weight) && x.weight > 0))
  const [presetId, setPresetId] = useState(wanted.length ? 'query' : 'mag7')
  const [custom, setCustom] = useState<Target[]>([])
  const [threshold, setThreshold] = useState(500)
  const [interval, setInterval_] = useState(INTERVALS[1])
  const [tx, setTx] = useState<Tx>({ phase: 'idle' })
  const [more, setMore] = useState(false)
  // The targets are derived: a preset over today's deep pools, or the custom list once the user touches it.
  const targets = useMemo(() => { if (presetId === 'query') return normalise(wanted.map((w) => { const stock = stocks.find((s) => s.ticker === w.ticker); const pool = stock ? poolFor(stock, pools) : undefined; return stock && pool && deepEnough(pool) ? { stock, pool, weight: w.weight } : undefined }).filter((x): x is Target => !!x)); const p = PRESETS.find((x) => x.id === presetId); return p ? presetTargets(p, stocks, pools) : custom }, [presetId, custom, stocks, pools, wanted])
  const edit = (next: Target[]) => { setCustom(next); setPresetId('custom') }
  const bps = toBps(targets)
  const toggle = (s: StockToken) => {
    const pool = poolFor(s, pools)
    if (!pool) return
    edit(normalise(targets.some((x) => x.stock.address === s.address) ? targets.filter((x) => x.stock.address !== s.address) : [...targets, { stock: s, pool, weight: targets.length ? 1 / targets.length : 1 }]))
  }
  const setWeight = (i: number, pctValue: string) => { const w = Number(pctValue); if (!isFinite(w) || w < 0) return; edit(targets.map((x, k) => (k === i ? { ...x, weight: w / 100 } : x))) }
  const sum = targets.reduce((s, x) => s + x.weight, 0)
  const busy = tx.phase !== 'idle' && tx.phase !== 'done' && tx.phase !== 'failed'
  const ok = targets.length >= 2 && targets.length <= 12 && Math.abs(sum - 1) < 0.002 && targets.every((x) => x.weight > 0)
  const ready = !!wallet.account && ok && !busy
  const go = async () => {
    if (!wallet.walletClient || !wallet.account) return
    setTx({ phase: 'switching' })
    try {
      const ctx = txCtx(wallet, chain, (p) => setTx((x) => ({ ...x, phase: p })))
      const hash = await createVault(ctx, vc, { targets: normalise(targets), thresholdBps: threshold, interval: interval.seconds, slippageBps: DEFAULT_SLIPPAGE_BPS, tip: DEFAULT_TIP })
      await approveHoldings(ctx, vc, targets.map((x) => x.stock.address))
      setTx({ phase: 'done', hash })
      onDone()
    } catch (e) {
      setTx({ phase: 'failed', error: describeError(e) })
    }
  }
  const list = useMemo(() => (more ? stocks : stocks.filter((s) => targets.some((x) => x.stock.address === s.address) || ['NVDA', 'TSLA', 'SPY', 'AAPL', 'GOOGL', 'META', 'MSFT', 'AMZN', 'QQQ', 'SPCX', 'MU', 'AMD'].includes(s.ticker))), [stocks, targets, more])
  return (
    <Panel sx={{ p: { xs: 2.5, md: 3 } }}>
      <Label>Start from</Label>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
        {PRESETS.map((p) => <Choice key={p.id} on={p.id === presetId} onClick={() => setPresetId(p.id)}>{p.name}</Choice>)}
        <Choice on={presetId === 'custom' || presetId === 'query'} onClick={() => edit(targets)}>Custom</Choice>
      </Box>
      {presetId !== 'custom' && presetId !== 'query' && <Typography sx={{ fontSize: 12, color: t.color.textLabel, mt: 1.25 }}>{PRESETS.find((p) => p.id === presetId)?.blurb} Stocks without a deep {vc.quote.symbol} pool today are left out.</Typography>}
      <Box sx={{ mt: 2.5 }}>
        <Label>Stocks</Label>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
          {list.map((s) => {
            const on = targets.some((x) => x.stock.address === s.address)
            return (
              <Choice key={s.address} on={on} onClick={() => toggle(s)} disabled={!deepEnough(poolFor(s, pools))}>
                <Avatar src={resolveImg(s.logo)} sx={{ width: 16, height: 16, background: z.surface2, fontSize: 8 }}>{s.ticker[0]}</Avatar>
                {s.ticker}
              </Choice>
            )
          })}
          {stocks.length > 0 && <Choice on={false} onClick={() => setMore((m) => !m)}>{more ? 'Fewer' : `All ${stocks.length}`}</Choice>}
        </Box>
        {loading && stocks.length === 0 && <Typography sx={{ fontSize: 12, color: t.color.textLabel, mt: 1.25 }}>Reading the stock pools on {vc.ic.name}…</Typography>}
      </Box>
      {targets.length > 0 && (
        <Box sx={{ mt: 2.5, display: 'grid', gap: 0.75 }}>
          <Label>Target weights</Label>
          {targets.map((x, i) => (
            <Box key={x.stock.address} sx={{ display: 'flex', alignItems: 'center', gap: 1.5, p: 1, pl: 1.5, borderRadius: t.radius.input, background: t.color.raised }}>
              <Avatar src={resolveImg(x.stock.logo)} sx={{ width: 20, height: 20, background: z.surface2, fontSize: 9 }}>{x.stock.ticker[0]}</Avatar>
              <Typography sx={{ fontSize: 13, fontWeight: 500, width: 64 }}>{x.stock.ticker}</Typography>
              <Typography sx={{ fontSize: 12, color: t.color.textMuted, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{x.pool.fee / 10_000}% pool · {fmtCompact(x.pool.liquidityUsd)}</Typography>
              <InputBase value={(x.weight * 100).toFixed(1).replace(/\.0$/, '')} onChange={(e) => setWeight(i, e.target.value.replace(/[^0-9.]/g, ''))} inputProps={{ 'aria-label': `${x.stock.ticker} weight`, inputMode: 'decimal' }} sx={{ width: 64, height: 32, px: 1, borderRadius: t.radius.input, background: t.color.hover, fontSize: 13, textAlign: 'right' }} />
              <Typography sx={{ fontSize: 12, color: t.color.textMuted }}>%</Typography>
            </Box>
          ))}
          <Box sx={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: Math.abs(sum - 1) < 0.002 ? t.color.textLabel : t.color.red }}>
            <span>{targets.length} stocks</span>
            <span>{(sum * 100).toFixed(1)}% {Math.abs(sum - 1) < 0.002 ? '' : '· must add up to 100%'}</span>
            <Box component="button" type="button" onClick={() => edit(targets.map((x) => ({ ...x, weight: 1 / targets.length })))} sx={{ all: 'unset', cursor: 'pointer', color: t.color.text }}>Equal weight</Box>
          </Box>
        </Box>
      )}
      {btOpen && targets.length > 0 && <Box sx={{ mt: 2.5, p: 2, borderRadius: t.radius.input, background: t.color.raised }}><BacktestPanel ic={vc.ic} legs={targets.map((x) => ({ ticker: x.stock.ticker, weight: x.weight }))} compact /></Box>}
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 2.5, mt: 3 }}>
        <Box>
          <Label>Rebalance when a weight drifts</Label>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>{THRESHOLDS.map((b) => <Choice key={b} on={threshold === b} onClick={() => setThreshold(b)}>{pct(b, 0)} or more</Choice>)}</Box>
        </Box>
        <Box>
          <Label>And no more often than</Label>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>{INTERVALS.map((x) => <Choice key={x.key} on={x.key === interval.key} onClick={() => setInterval_(x)}>{x.label.replace(' at most', '')}</Choice>)}</Box>
        </Box>
      </Box>
      <Box sx={{ mt: 3, p: 2, borderRadius: t.radius.panel, background: t.color.raised, display: 'grid', gap: 1 }}>
        <Row k="The vault" v={ok ? `${targets.length} stocks, ${bps.map((b, i) => `${targets[i].stock.ticker} ${pct(b, 0)}`).join(', ')}` : '…'} strong />
        <Row k="Runs when" v={`any weight is ${pct(threshold, 0)} off, ${interval.label.toLowerCase()}`} />
        <Row k="Each run" v={`sells the overweight to ${vc.quote.symbol}, buys the underweight with it, sends it all to you`} />
        <Row k="Price floor" v={`${DEFAULT_SLIPPAGE_BPS / 100}% below spot on every leg, read at run time`} />
        <Row k="Tip to whoever runs it" v={`${fmtUsdg(DEFAULT_TIP)} per run, from the sale proceeds`} />
        <Row k="Allowances" v="each stock, exactly what you hold today" />
        <Row k={`${BRAND.name} fee`} v="None" />
      </Box>
      <Button onClick={() => (wallet.account ? void go() : wallet.openWalletMenu())} disabled={!!wallet.account && !ready} sx={{ ...Bt, width: '100%', mt: 2.5, height: 44 }}>
        {!wallet.account ? 'Connect wallet' : busy ? PHASE_LABEL[tx.phase] : 'Create the vault and approve the holdings'}
      </Button>
      {tx.phase === 'failed' && <Typography sx={{ fontSize: 12, color: t.color.red, mt: 1.5 }}>{tx.error}</Typography>}
      {tx.phase === 'done' && tx.hash && chain && (
        <Box sx={{ mt: 2, p: 2, borderRadius: t.radius.panel, background: 'rgba(194,234,138,.10)', border: '1px solid rgba(194,234,138,.3)' }}>
          <Typography sx={{ fontSize: 14, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 1 }}><CheckIcon size={16} /> The vault is on the chain.</Typography>
          <Typography sx={{ fontSize: 13, color: t.color.textMuted, mt: 0.5 }}>It rebalances from the allowances you approved whenever the weights drift past your line. Buy more of a stock later and approve it again from the vault card. Close the tab; it does not need you.</Typography>
          <Box component="a" href={`${vc.ic.explorer}/tx/${tx.hash}`} target="_blank" rel="noopener noreferrer" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, mt: 1, fontSize: 13, color: t.color.text, textDecoration: 'none' }}>Transaction <ExternalIcon size={12} /></Box>
        </Box>
      )}
    </Panel>
  )
}

function VaultCard({ vc, v, wallet, chain, onChanged }: { vc: VaultChain; v: OnchainVault; wallet: Ctx; chain: ChainX | undefined; onChanged: () => void }) {
  const [tx, setTx] = useState<Tx>({ phase: 'idle' })
  const now = useClock(v.state === 'active')
  const busy = tx.phase !== 'idle' && tx.phase !== 'done' && tx.phase !== 'failed'
  const act = async (fn: (ctx: ReturnType<typeof txCtx>) => Promise<unknown>) => {
    if (!wallet.walletClient || !wallet.account) return
    setTx({ phase: 'switching' })
    try { await fn(txCtx(wallet, chain, (ph) => setTx((x) => ({ ...x, phase: ph })))); setTx({ phase: 'done' }); onChanged() } catch (e) { setTx({ phase: 'failed', error: describeError(e) }) }
  }
  // A leg needs an allowance for what a rebalance would sell of it today: the overweight part. Legs at or under
  // their target need none until they drift over, so a fresh buy by the vault does not nag for an approval.
  const sellUnits = (l: OnchainLeg) => { const target = (v.totalUsdg * BigInt(l.targetBps)) / 10_000n; return l.valueUsdg > target && l.valueUsdg > 0n ? (l.balance * (l.valueUsdg - target)) / l.valueUsdg : 0n }
  const short = (l: OnchainLeg) => l.balance > 0n && l.allowance < sellUnits(l)
  const unapproved = v.legs.filter(short)
  const dot = v.state === 'paused' ? '#FFE866' : v.due ? '#FFE866' : t.color.mark
  const nextAt = v.lastRun + v.interval
  return (
    <Panel sx={{ p: 2.5 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
        <Box sx={{ width: 44, height: 44, borderRadius: '12px', background: t.color.hover, display: 'grid', placeItems: 'center', color: t.color.mark, flexShrink: 0 }}><VaultIcon size={20} /></Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography sx={{ fontSize: 15, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
            {v.legs.map((l) => l.stock?.ticker ?? '?').join(' · ')}
            <Box component="span" sx={{ width: 8, height: 8, borderRadius: '50%', background: dot }} />
            <Box component="span" sx={{ fontSize: 12, color: t.color.textMuted, fontWeight: 400 }}>{v.state === 'paused' ? 'Paused' : v.due ? 'Due, runs within ten minutes' : 'Watching'}</Box>
          </Typography>
          <Typography sx={{ fontSize: 12, color: t.color.textMuted }}>
            {fmtUsdg(v.totalUsdg)} at spot · drift {pct(v.driftBps)} of {pct(v.thresholdBps, 0)} · {intervalLabel(v.interval).toLowerCase()}{v.runs ? ` · ${v.runs} run${v.runs === 1 ? '' : 's'}, last ${fmtWhen(v.lastRun)}` : ' · never run'}{v.lastRun && now > 0 && now / 1000 < nextAt ? ` · next from ${fmtWhen(nextAt)}` : ''} · vault #{String(v.id)}
          </Typography>
        </Box>
      </Box>
      <Box sx={{ display: 'grid', gap: 0.5, mt: 2 }}>
        {v.legs.map((l) => {
          const off = l.weightBps - l.targetBps
          return (
            <Box key={l.token} sx={{ display: 'flex', alignItems: 'center', gap: 1.5, fontSize: 12 }}>
              <Avatar src={resolveImg(l.stock?.logo)} sx={{ width: 18, height: 18, background: z.surface2, fontSize: 8 }}>{(l.stock?.ticker ?? '?')[0]}</Avatar>
              <Typography sx={{ fontSize: 13, fontWeight: 500, width: 60 }}>{l.stock?.ticker ?? l.token.slice(0, 6)}</Typography>
              <Box sx={{ flex: 1, height: 6, borderRadius: 3, background: t.color.hover, overflow: 'hidden', position: 'relative' }}>
                <Box sx={{ width: `${Math.min(100, l.weightBps / 100)}%`, height: '100%', background: Math.abs(off) >= v.thresholdBps ? '#FFE866' : t.color.mark, borderRadius: 3 }} />
                <Box sx={{ position: 'absolute', left: `${l.targetBps / 100}%`, top: -2, width: 2, height: 10, background: t.color.text }} />
              </Box>
              <Typography sx={{ fontSize: 12, color: t.color.textMuted, width: 150, textAlign: 'right' }}>{pct(l.weightBps)} of {pct(l.targetBps, 0)} · {fmtUsdg(l.valueUsdg, 0)}{short(l) ? ' · approve' : ''}</Typography>
            </Box>
          )
        })}
      </Box>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 2 }}>
        {v.due && v.state === 'active' && <Button disabled={busy} onClick={() => void act((c) => runNow(c, vc, v.id))} sx={{ ...Bt, height: 34, px: 1.75, gap: 0.75 }}><RefreshIcon size={13} /> Rebalance now</Button>}
        {unapproved.length > 0 && <Button disabled={busy} onClick={() => void act((c) => approveHoldings(c, vc, unapproved.map((l) => l.token)))} sx={{ ...Lt, backdropFilter: 'none', height: 34, px: 1.75 }}>Approve {unapproved.map((l) => l.stock?.ticker ?? '?').join(', ')}</Button>}
        <Button disabled={busy} onClick={() => void act((c) => setPaused(c, vc, v.id, v.state === 'active'))} sx={{ ...Lt, backdropFilter: 'none', height: 34, px: 1.75, gap: 0.75 }}>{v.state === 'active' ? <><PauseIcon size={13} /> Pause</> : <><RefreshIcon size={13} /> Resume</>}</Button>
        <Button disabled={busy} onClick={() => void act((c) => revokeHoldings(c, vc, v.legs.map((l) => l.token)))} sx={{ ...Lt, backdropFilter: 'none', height: 34, px: 1.75, color: t.color.red }}>Revoke allowances</Button>
        {busy && <Typography sx={{ fontSize: 12, color: t.color.textMuted, alignSelf: 'center' }}>{PHASE_LABEL[tx.phase]}</Typography>}
      </Box>
      {tx.phase === 'failed' && <Typography sx={{ fontSize: 12, color: t.color.red, mt: 1 }}>{tx.error}</Typography>}
    </Panel>
  )
}

export default function VaultsWithoutYouPage() {
  const wallet = useWallet()
  const { account, openWalletMenu } = wallet
  const { data: chains } = useChains()
  const [params, setParams] = useSearchParams()
  const vc = vaultChain(params.get('chain'))
  const DEPLOYED = vc.deployed
  const chain = chains?.find((c) => c.id === vc.ic.id) as ChainX | undefined
  const assets = useAssets()
  const pools = usePoolsOn(vc.ic, assets.data?.assets)
  const stocks = useMemo(() => (assets.data ? stockTokensOn(assets.data.assets, vc.ic.id).filter((s) => deepEnough(poolFor(s, pools.data ?? []))) : []), [assets.data, pools.data, vc.ic.id])
  const vaults = useOnchainVaults(vc, account?.address, assets.data?.assets)
  const totals = useVaultTotals(vc)
  const qc = useQueryClient()
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['vaults-onchain'] }); void qc.invalidateQueries({ queryKey: ['vaults-onchain-totals'] }) }
  const list = vaults.data ?? []

  const page = (
    <Page>
      <PageHero
        label="Vaults without you"
        badges={<Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>{VAULT_CHAINS.map((c) => <Box key={c.key} component="button" type="button" onClick={() => setParams((prev) => { const n = new URLSearchParams(prev); if (c.key === 'robinhood') n.delete('chain'); else n.set('chain', c.key); return n })} aria-pressed={c.key === vc.key} sx={{ all: 'unset', cursor: 'pointer', ...Vg, ml: 0, ...(c.key === vc.key && { background: t.color.text, color: t.color.page }) }}>{c.ic.name}</Box>)}<Box sx={{ ...Vg, ml: 0, background: 'rgba(194,234,138,.16)', color: t.color.mark }}>{DEPLOYED ? 'Live' : 'Contract not deployed'}</Box></Box>}
        title={<>Drift past the line.<br />It rebalances.</>}
        lead={`Target weights over tokenized stocks on ${vc.ic.name}, kept by a contract while your wallet is closed. You name the stocks, the weights, a drift threshold and how often it may run; you approve each stock for what you hold. When a weight drifts past the line, the contract sells the overweight stocks for ${vc.quote.symbol}, buys the underweight ones with the proceeds and sends everything back to you, inside one transaction with a floor on every leg. Nothing held between runs. No fee.`}
        action={
          <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
            <Button onClick={() => (account ? document.getElementById('vaults-composer')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) : openWalletMenu())} sx={{ ...Bt, gap: 1 }}>
              <VaultIcon size={15} /> {account ? 'Create a vault' : 'Connect wallet'}
            </Button>
            <Button component={Link} to="/vaults" sx={{ ...Lt, backdropFilter: 'none', gap: 1 }}>
              <WalletIcon size={14} /> Vaults on this device
            </Button>
          </Box>
        }
      />

      <Stats items={[{ label: 'Vaults', value: totals.data ? totals.data.vaults : DEPLOYED ? '…' : '0' }, { label: 'Active', value: totals.data ? totals.data.active : DEPLOYED ? '…' : '0' }, { label: 'Rebalances', value: totals.data ? totals.data.runs : DEPLOYED ? '…' : '0' }, { label: `${BRAND.name} fee`, value: '0%' }]} />
      <Typography sx={{ fontSize: 13, color: t.color.textLabel, mt: 1.5 }}>
        Read from the {BRAND.name} Vaults contract on {vc.ic.name}{DEPLOYED ? <>, <Box component="a" href={`${vc.ic.explorer}/address/${vc.contract}`} target="_blank" rel="noopener noreferrer" sx={{ color: t.color.text }}>{vc.contract.slice(0, 6)}…{vc.contract.slice(-4)}</Box></> : ''}. Weights are valued at the stocks' pool prices; the executor checks every vault every ten minutes.
      </Typography>

      {!DEPLOYED && (
        <Panel sx={{ mt: 5, p: { xs: 3, md: 4 } }}>
          <Typography sx={{ fontSize: 16, fontWeight: 500 }}>The contract is not on the chain yet.</Typography>
          <Typography sx={{ fontSize: 14, color: t.color.textMuted, mt: 0.75 }}>The code is in the repository. Vaults open here on {vc.ic.name} the moment it is deployed.</Typography>
        </Panel>
      )}

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0,1fr)', md: 'minmax(0,1fr) 460px' }, gap: 2.5, mt: { xs: 5, md: 7 }, alignItems: 'start' }}>
        <Box sx={{ minWidth: 0 }}>
          <Typography component="h2" sx={{ ...t.type.h3, color: t.color.text, mb: 2 }}>Your vaults</Typography>
          {!account ? (
            <Panel sx={{ p: { xs: 3, md: 4 }, display: 'flex', alignItems: 'center', gap: 2.5, flexWrap: 'wrap' }}>
              <Box sx={{ flex: 1, minWidth: 240 }}>
                <Typography sx={{ fontSize: 16, fontWeight: 500 }}>Connect to see your vaults.</Typography>
                <Typography sx={{ fontSize: 14, color: t.color.textMuted, mt: 0.75 }}>Vaults live in the contract, under your address. Any device, any wallet app, the same vaults.</Typography>
              </Box>
              <Button onClick={openWalletMenu} sx={{ ...Bt, gap: 1 }}><WalletIcon size={14} /> Connect</Button>
            </Panel>
          ) : (
            <Box sx={{ display: 'grid', gap: 1.5 }}>
              {list.map((v) => <VaultCard key={String(v.id)} vc={vc} v={v} wallet={wallet} chain={chain} onChanged={refresh} />)}
              {vaults.data && list.length === 0 && <Panel sx={{ p: 3 }}><Typography sx={{ fontSize: 14, color: t.color.textMuted }}>{DEPLOYED ? 'No vault yet. Create one on the right.' : 'Vaults open once the contract is deployed.'}</Typography></Panel>}
            </Box>
          )}
        </Box>
        <Box id="vaults-composer" sx={{ minWidth: 0, scrollMarginTop: 96 }}>
          {DEPLOYED ? <Composer vc={vc} stocks={stocks} pools={pools.data ?? []} loading={pools.isLoading || assets.isLoading} wallet={wallet} chain={chain} onDone={refresh} /> : null}
        </Box>
      </Box>

      <Box sx={{ mt: { xs: 8, md: 12 } }}>
        <Typography component="h2" sx={{ ...t.type.h3, color: t.color.text }}>How it works</Typography>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(3, minmax(0,1fr))' }, gap: 2.5, mt: 4 }}>
          <Step n={1} icon={<LockIcon size={20} />} title="Approve what you hold" text="For each stock in the vault you approve the contract for exactly your balance: the most a rebalance can ever sell of it. Buy more later and approve again from the card. Revoke and the vault stops, whatever anyone does." />
          <Step n={2} icon={<RefreshIcon size={20} />} title="Drift past the line" text={`${BRAND.name}'s executor values your holdings at the pools' spot prices every ten minutes. When any weight is further from its target than your threshold, and the interval has passed, it runs the vault: sells the overweight stocks to ${vc.quote.symbol}, takes a ten-cent tip, buys the underweight ones, sends it all to you. One transaction.`} />
          <Step n={3} icon={<ShieldIcon size={20} />} title="A floor on every leg" text="Each sale and each buy must return at least the pool's spot less 1%, read in the same transaction. A pool that moved makes the run wait, not fill badly. The contract holds nothing between runs and no admin can touch a vault." />
        </Box>
      </Box>

      <Panel sx={{ mt: { xs: 8, md: 12 }, p: { xs: 3, md: 5 }, display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 4, alignItems: 'center' }}>
        <Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <Box sx={{ width: 40, height: 40, borderRadius: '10px', background: '#000', border: `1px solid ${t.color.borderStrong}`, display: 'grid', placeItems: 'center' }}><MarkIcon size={22} /></Box>
            <Box sx={{ ...Vg, ml: 0 }}>Phase 2, box 8</Box>
          </Box>
          <Typography component="h2" sx={{ ...t.type.h3, color: t.color.text, mt: 2.5 }}>The vault you set today, kept by a contract.</Typography>
          <Typography sx={{ ...t.type.body, color: t.color.textMuted, mt: 2 }}>
            Vaults on this device needed your tab open and your tap on every trade. These do not: the weights, the threshold and the cadence live in the contract, the executor that already runs Auto-Invest and Orders checks them, and a rebalance is one transaction with a floor on every leg. The contract holds no balance, takes no fee, and its admin can only keep the executor list. Unaudited; read it before you trust it with more than you would lose.
          </Typography>
          <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', mt: 2 }}>
            {DEPLOYED && <Box component="a" href={`${vc.ic.explorer}/address/${vc.contract}`} target="_blank" rel="noopener noreferrer" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, fontSize: 13, color: t.color.text, textDecoration: 'none' }}>Contract on the explorer <ExternalIcon size={12} /></Box>}
            <Box component="a" href="https://github.com/useverdex/verdex/blob/main/contracts/VerdexVaults.sol" target="_blank" rel="noopener noreferrer" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, fontSize: 13, color: t.color.text, textDecoration: 'none' }}>Source <ExternalIcon size={12} /></Box>
            <Box component={Link} to="/docs#vaults-without-you" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, fontSize: 13, color: t.color.text, textDecoration: 'none' }}>Docs</Box>
          </Box>
        </Box>
        <Box sx={{ display: 'grid', gap: 1.5 }}>
          {[
            [<LockIcon key="a" size={18} />, 'The allowances are the limit', 'Each stock is approved for what you hold; the contract can never sell more of it than that.'],
            [<ShieldIcon key="b" size={18} />, 'Spot prices, read at run time', 'Weights and floors both come from the pools in the same transaction. There is no oracle to feed and no price to post.'],
            [<CheckIcon key="c" size={18} />, 'Unaudited, and small', 'No third party has audited this contract. It is short, tested on a fork of the chain, and the source is in the repository with the compiled bytecode.'],
          ].map(([icon, title, text]) => (
            <Box key={title as string} sx={{ display: 'flex', gap: 1.5, p: 2, borderRadius: t.radius.panel, background: t.color.raised }}>
              <Box sx={{ color: t.color.mark, mt: 0.25, flexShrink: 0 }}>{icon}</Box>
              <Box>
                <Typography sx={{ fontSize: 14, fontWeight: 500 }}>{title}</Typography>
                <Typography sx={{ fontSize: 13, color: t.color.textMuted, mt: 0.25 }}>{text}</Typography>
              </Box>
            </Box>
          ))}
        </Box>
      </Panel>
    </Page>
  )
  return vc.key === 'base' ? <EarlyGate path="/vaults/without-you/base">{page}</EarlyGate> : page
}
