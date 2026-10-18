// Leverage: two-times long and short on tokenized stocks, built on Verdex Lend. The page lists the stocks
// with a long and a short market, your open positions with their health and liquidation price, and a
// composer that shows the whole position before you sign.
import { useEffect, useMemo, useState } from 'react'
import { Avatar, Box, Button, InputBase, Typography } from '@mui/material'
import { Link } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { formatUnits, parseUnits } from 'viem'
import { BRAND, t, z } from '../theme/tokens'
import { Bt, Lt, Vg } from '../theme/styles'
import { ROBINHOOD, fmtCompact, fmtUsd, useAssets, useChains } from '../lib/api'
import { describeError, explorerTx, type ChainX } from '../lib/lifi'
import { PHASE_LABEL, usePools, type Phase } from '../lib/pools'
import { explorerAddress } from '../lib/autopilot'
import { useMarkets } from '../lib/lend'
import { DEPLOYED, LEVERAGE, MAX_LONG, MAX_SHORT, addMargin, closeLong, closeShort, fmtHealth, fmtUsdg, openLong, openShort, pairMarkets, planLong, planShort, settle, useCaps, useLevWallet, valueOf, type LevPosition, type Pair, type Plan } from '../lib/leverage'
import { resolveImg } from '../lib/img'
import { useWallet } from '../components/wallet/WalletProvider'
import { CheckIcon, ExternalIcon, HandCoinIcon, LockIcon, ShieldIcon, TrendIcon, WalletIcon } from '../components/icons'
import { MarkIcon } from '../components/Logo'
import { Page, PageHero, Panel, Stats } from './common'

type Side = 'long' | 'short'
type Ctx = ReturnType<typeof useWallet>
type Tx = { phase: Phase; error?: string; hash?: string }
const txCtx = (w: Ctx, chain: ChainX | undefined, onPhase: (p: Phase) => void) => ({ walletClient: w.walletClient!, account: w.account!, chain, switchChain: w.switchChain, onPhase })
const MARGINS = [25, 100, 250, 1000]
const LONG_LEVERAGE = [1.25, 1.5, 1.9]
const SHORT_LEVERAGE = [1.25, 1.5, 2]
const pct = (n: number) => `${n.toFixed(2)}%`
const signed = (n: number) => `${n >= 0 ? '+' : ''}${fmtUsd(n)}`

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
function Row({ k, v, strong, accent, red }: { k: string; v: React.ReactNode; strong?: boolean; accent?: boolean; red?: boolean }) {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 2, fontSize: 13 }}>
      <Typography sx={{ fontSize: 13, color: t.color.textMuted }}>{k}</Typography>
      <Typography sx={{ fontSize: 13, fontWeight: strong ? 500 : 400, textAlign: 'right', color: red ? t.color.red : accent ? t.color.mark : t.color.text, fontVariantNumeric: 'tabular-nums' }}>{v}</Typography>
    </Box>
  )
}
function Step({ n, icon, title, text }: { n: number; icon: React.ReactNode; title: string; text: string }) {
  return (
    <Panel sx={{ p: 3 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 1.5 }}>
        <Box sx={{ width: 36, height: 36, borderRadius: t.radius.input, background: t.color.chip, display: 'grid', placeItems: 'center', color: t.color.mark }}>{icon}</Box>
        <Typography sx={{ ...t.type.overline, color: t.color.textLabel }}>Step {n}</Typography>
      </Box>
      <Typography sx={{ fontSize: 16, fontWeight: 500, mb: 0.75 }}>{title}</Typography>
      <Typography sx={{ fontSize: 14, color: t.color.textMuted, lineHeight: 1.6 }}>{text}</Typography>
    </Panel>
  )
}

function PairCard({ p, openLong: oiL, capLong, openShort: oiS, capShort, posL, posS, selected, onPick, onClose, onSettle, onAdd, busyId }: { p: Pair; openLong: bigint; capLong: bigint; openShort: bigint; capShort: bigint; posL?: LevPosition; posS?: LevPosition; selected: boolean; onPick: (side: Side) => void; onClose: (side: Side) => void; onSettle: (side: Side) => void; onAdd: (side: Side) => void; busyId?: string }) {
  const bar = (o: bigint, c: bigint) => (c > 0n ? Math.min(100, Number((o * 10_000n) / c) / 100) : 0)
  const Position = ({ side, pos }: { side: Side; pos: LevPosition }) => {
    const v = valueOf(p, pos)
    const liquidated = pos.side !== 0 && pos.debt === 0n
    const id = side === 'long' ? p.long.id : p.short?.id
    const busy = busyId === `${side}-${id?.toString()}`
    return (
      <Box sx={{ mt: 2, pt: 1.5, borderTop: `1px solid ${t.color.border}`, display: 'grid', gap: 0.75 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Box sx={{ ...Vg, ml: 0, background: side === 'long' ? 'rgba(194,234,138,.16)' : 'rgba(248,113,113,.16)', color: side === 'long' ? t.color.mark : t.color.red }}>{side === 'long' ? 'Long' : 'Short'} {(Number(formatUnits(pos.exposure, 6)) / Math.max(1e-9, Number(formatUnits(pos.margin, 6)))).toFixed(2)}x</Box>
          <Typography sx={{ fontSize: 12, color: t.color.textMuted }}>opened {new Date(pos.openedAt * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</Typography>
        </Box>
        <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0.75 }}>
          <Row k="Margin" v={fmtUsdg(pos.margin)} />
          <Row k="Exposure" v={fmtUsdg(pos.exposure, 0)} />
          <Row k={side === 'long' ? 'Stock locked' : 'Stock owed'} v={`${Number(formatUnits(side === 'long' ? pos.collateral : pos.debt, p.stock.decimals)).toLocaleString('en-US', { maximumFractionDigits: 4 })} ${p.stock.ticker}`} />
          <Row k={side === 'long' ? 'USDG owed' : 'USDG locked'} v={fmtUsdg(side === 'long' ? pos.debt : pos.collateral)} />
          <Row k="Equity now" v={fmtUsd(v.equity)} strong />
          <Row k="Profit" v={liquidated ? 'liquidated' : signed(v.pnl)} accent={v.pnl >= 0 && !liquidated} red={v.pnl < 0 || liquidated} />
          <Row k="Health" v={fmtHealth(pos.health)} accent={Number(pos.health) >= 12_000} red={Number(pos.health) < 11_000} />
          <Row k={`Liquidation ${side === 'long' ? 'below' : 'above'}`} v={v.liqPrice > 0 ? fmtUsd(v.liqPrice) : '-'} />
        </Box>
        <Box sx={{ display: 'flex', gap: 1, mt: 0.5, flexWrap: 'wrap' }}>
          {liquidated ? <Button onClick={() => onSettle(side)} disabled={busy} sx={{ ...Bt, height: 34, fontSize: 13, px: 1.75 }}>{busy ? 'Working…' : 'Settle'}</Button> : <>
            <Button onClick={() => onClose(side)} disabled={busy} sx={{ ...Bt, height: 34, fontSize: 13, px: 1.75 }}>{busy ? 'Working…' : 'Close'}</Button>
            <Button onClick={() => onAdd(side)} disabled={busy} sx={{ ...Lt, backdropFilter: 'none', height: 34, fontSize: 13, px: 1.75 }}>Add margin</Button>
          </>}
        </Box>
      </Box>
    )
  }
  return (
    <Panel sx={{ p: 2.5, borderColor: selected ? 'rgba(194,234,138,.45)' : undefined }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
        <Avatar src={resolveImg(p.stock.logo)} sx={{ width: 36, height: 36, background: z.surface2, fontSize: 12 }}>{p.stock.ticker[0]}</Avatar>
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography sx={{ fontSize: 16, fontWeight: 500 }}>{p.stock.ticker} <Box component="span" sx={{ color: t.color.textMuted, fontWeight: 400, fontSize: 13 }}>{p.stock.name}</Box></Typography>
          <Typography sx={{ fontSize: 12, color: t.color.textMuted }}>{fmtUsd(p.price)} · long borrows at {pct(p.long.borrowApr)} · {p.short ? `short borrows at ${pct(p.short.borrowApr)}` : 'no short market yet'}</Typography>
        </Box>
      </Box>
      <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1.5, mt: 2, fontSize: 13 }}>
        <Box>
          <Row k="Long open interest" v={`${fmtUsdg(oiL, 0)} of ${fmtUsdg(capLong, 0)}`} />
          <Box sx={{ height: 4, borderRadius: 2, background: t.color.chip, mt: 0.75, overflow: 'hidden' }}><Box sx={{ width: `${bar(oiL, capLong)}%`, height: '100%', background: t.color.mark }} /></Box>
        </Box>
        <Box>
          <Row k="Short open interest" v={`${fmtUsdg(oiS, 0)} of ${fmtUsdg(capShort, 0)}`} />
          <Box sx={{ height: 4, borderRadius: 2, background: t.color.chip, mt: 0.75, overflow: 'hidden' }}><Box sx={{ width: `${bar(oiS, capShort)}%`, height: '100%', background: t.color.red }} /></Box>
        </Box>
        <Row k="USDG to borrow" v={fmtUsdg(p.long.available, 0)} />
        <Row k={`${p.stock.ticker} to borrow`} v={p.short ? `${Number(formatUnits(p.short.available, p.stock.decimals)).toLocaleString('en-US', { maximumFractionDigits: 2 })}` : '-'} />
      </Box>
      {posL && posL.side !== 0 && <Position side="long" pos={posL} />}
      {posS && posS.side !== 0 && <Position side="short" pos={posS} />}
      <Box sx={{ display: 'flex', gap: 1, mt: 2, flexWrap: 'wrap' }}>
        <Button onClick={() => onPick('long')} sx={{ ...Bt, height: 34, fontSize: 13, px: 1.75 }}>Long</Button>
        <Button onClick={() => onPick('short')} disabled={!p.short} sx={{ ...Lt, backdropFilter: 'none', height: 34, fontSize: 13, px: 1.75 }}>Short</Button>
      </Box>
    </Panel>
  )
}

function Composer({ pairs, pair, side, setPair, setSide, wallet, chain, usdg, allowance, holder, feeBps, capRoom, onDone }: { pairs: Pair[]; pair: Pair | undefined; side: Side; setPair: (p: Pair) => void; setSide: (s: Side) => void; wallet: Ctx; chain: ChainX | undefined; usdg: bigint; allowance: bigint; holder: boolean; feeBps: number; capRoom: bigint; onDone: () => void }) {
  const [margin, setMargin] = useState('100')
  const [lev, setLev] = useState(1.5)
  const [tx, setTx] = useState<Tx>({ phase: 'idle' })
  useEffect(() => { setLev((l) => Math.min(l, side === 'long' ? MAX_LONG : MAX_SHORT)) }, [side])
  const raw = useMemo(() => { try { return Number(margin) > 0 ? parseUnits(Number(margin).toFixed(6), 6) : 0n } catch { return 0n } }, [margin])
  const plan: Plan | undefined = useMemo(() => (pair && raw > 0n ? (side === 'long' ? planLong(pair, raw, lev, feeBps, holder) : planShort(pair, raw, lev, feeBps, holder)) : undefined), [pair, raw, lev, side, feeBps, holder])
  const busy = tx.phase !== 'idle' && tx.phase !== 'done' && tx.phase !== 'failed'
  const need = plan ? plan.margin + plan.fee : 0n
  const short = raw > 0n && usdg < need
  const liquidity = pair ? (side === 'long' ? pair.long.available : pair.short?.available ?? 0n) : 0n
  const noLiquidity = !!plan && (side === 'long' ? plan.borrow > liquidity : plan.units > liquidity)
  const overCap = !!plan && plan.exposure > capRoom
  const ready = !!wallet.account && !!pair && !!plan && (side === 'long' || !!pair.short) && !busy && !short && !noLiquidity && !overCap
  const go = async () => {
    if (!wallet.walletClient || !wallet.account || !pair || !plan) return
    setTx({ phase: 'switching' })
    try {
      const ctx = txCtx(wallet, chain, (p) => setTx((x) => ({ ...x, phase: p })))
      const hash = side === 'long' ? await openLong(ctx, pair, plan, allowance) : await openShort(ctx, pair, plan, allowance)
      setTx({ phase: 'done', hash })
      onDone()
    } catch (e) {
      setTx({ phase: 'failed', error: describeError(e) })
    }
  }
  const levs = side === 'long' ? LONG_LEVERAGE : SHORT_LEVERAGE
  return (
    <Panel sx={{ p: { xs: 2.5, md: 3 } }}>
      <Label>Side</Label>
      <Box sx={{ display: 'flex', gap: 1, mb: 2.5 }}>
        <Choice on={side === 'long'} onClick={() => { setSide('long'); setTx({ phase: 'idle' }) }}>Long</Choice>
        <Choice on={side === 'short'} onClick={() => { setSide('short'); setTx({ phase: 'idle' }) }}>Short</Choice>
      </Box>
      <Label>Stock</Label>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mb: 2.5 }}>
        {pairs.map((x) => <Choice key={x.long.id.toString()} on={x.long.id === pair?.long.id} onClick={() => { setPair(x); setTx({ phase: 'idle' }) }} disabled={side === 'short' && !x.short}>{x.stock.ticker}</Choice>)}
      </Box>
      <Label>Margin, in USDG</Label>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mb: 1 }}>{MARGINS.map((a) => <Choice key={a} on={Number(margin) === a} onClick={() => setMargin(String(a))}>${a}</Choice>)}</Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, height: 44, px: 1.5, borderRadius: t.radius.input, background: t.color.hover }}>
        <Typography sx={{ fontSize: 15, color: t.color.textMuted }}>$</Typography>
        <InputBase value={margin} onChange={(e) => setMargin(e.target.value.replace(/[^0-9.]/g, ''))} inputProps={{ inputMode: 'decimal', 'aria-label': 'Margin' }} sx={{ flex: 1, fontSize: 15, fontWeight: 500 }} />
        <Box component="button" type="button" onClick={() => setMargin(formatUnits(holder || feeBps === 0 ? usdg : (usdg * 10_000n) / BigInt(10_000 + Math.ceil(lev * feeBps)), 6))} sx={{ all: 'unset', cursor: 'pointer', fontSize: 12, fontWeight: 500, color: t.color.mark }}>Max</Box>
      </Box>
      <Typography sx={{ fontSize: 12, color: short ? t.color.red : t.color.textMuted, mt: 0.75 }}>Wallet: {fmtUsdg(usdg)} USDG{plan && plan.fee > 0n ? ` · fee ${fmtUsdg(plan.fee)}` : holder ? ' · no fee for VERDEX holders' : ''}</Typography>
      <Label>Leverage</Label>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mb: 2 }}>{levs.map((l) => <Choice key={l} on={lev === l} onClick={() => setLev(l)}>{l}x</Choice>)}</Box>
      {pair && plan && (
        <Box sx={{ p: 1.75, borderRadius: t.radius.panel, background: t.color.raised, display: 'grid', gap: 0.75 }}>
          <Row k="Exposure" v={`${fmtUsdg(plan.exposure, 0)} of ${pair.stock.ticker}`} strong />
          <Row k={side === 'long' ? `${pair.stock.ticker} bought and locked` : `${pair.stock.ticker} borrowed and sold`} v={`${Number(formatUnits(plan.units, pair.stock.decimals)).toLocaleString('en-US', { maximumFractionDigits: 4 })}`} />
          {side === 'long' ? <Row k="USDG borrowed" v={fmtUsdg(plan.borrow)} /> : <Row k="USDG locked" v={fmtUsdg(plan.margin + plan.exposure)} />}
          <Row k="Health at open" v={plan.health === Infinity ? '∞' : plan.health.toFixed(2)} accent={plan.health >= 1.2} />
          <Row k={`Liquidation if ${pair.stock.ticker} is ${side === 'long' ? 'below' : 'above'}`} v={fmtUsd(plan.liqPrice)} red />
          <Row k="Interest" v={pct(side === 'long' ? pair.long.borrowApr : pair.short?.borrowApr ?? 0) + ' a year, on what is borrowed'} />
          <Row k={`${BRAND.name} fee`} v={plan.fee > 0n ? fmtUsdg(plan.fee) : 'none'} />
          {noLiquidity && <Typography sx={{ fontSize: 12, color: t.color.red }}>Not enough {side === 'long' ? 'USDG' : pair.stock.ticker} supplied in the Lend market for this size.</Typography>}
          {overCap && <Typography sx={{ fontSize: 12, color: t.color.red }}>Over this market's open-interest cap. Room left: {fmtUsdg(capRoom, 0)}.</Typography>}
        </Box>
      )}
      <Button onClick={() => (wallet.account ? void go() : wallet.openWalletMenu())} disabled={!!wallet.account && !ready} sx={{ ...Bt, width: '100%', height: 48, mt: 2 }}>
        {!wallet.account ? 'Connect wallet' : busy ? PHASE_LABEL[tx.phase] : !pair ? 'No market' : short ? 'Not enough USDG' : `Open ${lev}x ${side} ${pair.stock.ticker}`}
      </Button>
      {tx.phase === 'failed' && <Typography sx={{ fontSize: 12, color: t.color.red, mt: 1 }}>{tx.error}</Typography>}
      {tx.phase === 'done' && tx.hash && chain && <Typography sx={{ fontSize: 12, color: t.color.mark, mt: 1 }}>Done. <Box component="a" href={explorerTx(chain, ROBINHOOD, tx.hash)} target="_blank" rel="noopener noreferrer" sx={{ color: t.color.text }}>Transaction</Box></Typography>}
      <Typography sx={{ fontSize: 11, color: t.color.textLabel, mt: 1.5, lineHeight: 1.5 }}>Unaudited. One swap in the stock's Uniswap v3 pool, paid inside the callback; the position lives in Verdex Lend under an account that is yours. A position under its liquidation line can be liquidated by anyone, with the market's bonus taken from it. Leverage multiplies a move both ways.</Typography>
    </Panel>
  )
}

export default function LeveragePage() {
  const wallet = useWallet()
  const { account, openWalletMenu } = wallet
  const { data: chains } = useChains()
  const chain = chains?.find((c) => c.id === ROBINHOOD) as ChainX | undefined
  const assets = useAssets()
  const pools = usePools(assets.data?.assets)
  const markets = useMarkets(assets.data?.assets, pools.data)
  const caps = useCaps(markets.data)
  const w = useLevWallet(account?.address, markets.data)
  const qc = useQueryClient()
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['lend-markets'] }); void qc.invalidateQueries({ queryKey: ['leverage-caps'] }); void qc.invalidateQueries({ queryKey: ['leverage-wallet'] }) }
  const pairs = useMemo(() => pairMarkets(markets.data ?? []), [markets.data])
  const [side, setSide] = useState<Side>('long')
  const [picked, setPicked] = useState<string>()
  const pair = pairs.find((p) => p.long.id.toString() === picked) ?? pairs[0]
  useEffect(() => { if (!picked && pair) setPicked(pair.long.id.toString()) }, [picked, pair])
  const [busyId, setBusyId] = useState<string>()
  const [err, setErr] = useState<string>()
  const cap = (id?: bigint) => (id === undefined ? 0n : caps.data?.cap[id.toString()] ?? 0n)
  const oi = (id?: bigint) => (id === undefined ? 0n : caps.data?.open[id.toString()] ?? 0n)
  const pos = (id?: bigint) => (id === undefined ? undefined : w.data?.positions[id.toString()])
  const totalOi = pairs.reduce((s, p) => s + Number(formatUnits(oi(p.long.id) + oi(p.short?.id), 6)), 0)
  const myPositions = pairs.flatMap((p) => [pos(p.long.id), pos(p.short?.id)]).filter((x): x is LevPosition => !!x && x.side !== 0)
  const myEquity = pairs.reduce((s, p) => { const a = pos(p.long.id), b = pos(p.short?.id); return s + (a && a.side !== 0 ? valueOf(p, a).equity : 0) + (b && b.side !== 0 ? valueOf(p, b).equity : 0) }, 0)
  const holder = (w.data?.verdex ?? 0n) > 0n
  const feeBps = caps.data?.feeBps ?? 25
  const pick = (p: Pair, s: Side) => { setPicked(p.long.id.toString()); setSide(s); document.getElementById('lev-composer')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }
  const act = async (p: Pair, s: Side, what: 'close' | 'settle' | 'add') => {
    if (!wallet.walletClient || !account) return
    const id = s === 'long' ? p.long.id : p.short?.id
    if (id === undefined) return
    const key = `${s}-${id.toString()}`
    setBusyId(key); setErr(undefined)
    try {
      const ctx = txCtx(wallet, chain, () => {})
      if (what === 'close') {
        // Floor on the USDG that comes back: today's equity less 3%, so a moved pool reverts instead of filling badly.
        const eq = pos(s === 'long' ? p.long.id : p.short?.id)
        const minOut = eq && eq.side !== 0 ? BigInt(Math.max(0, Math.floor(valueOf(p, eq).equity * 0.97 * 1e6))) : 0n
        if (s === 'long') await closeLong(ctx, p, minOut); else await closeShort(ctx, p, minOut)
      }
      else if (what === 'settle') await settle(ctx, id)
      else {
        const amount = window.prompt(`USDG to add to the ${s} ${p.stock.ticker} position`, '25')
        const v = amount ? parseUnits(Number(amount).toFixed(6), 6) : 0n
        if (v > 0n) await addMargin(ctx, id, v, w.data?.allowance ?? 0n)
      }
      refresh()
    } catch (e) { setErr(describeError(e)) } finally { setBusyId(undefined) }
  }

  return (
    <Page>
      <PageHero
        label="Leverage"
        badges={<Box sx={{ ...Vg, ml: 0, background: 'rgba(194,234,138,.16)', color: t.color.mark }}>{DEPLOYED ? 'Live' : 'Contract not deployed'}</Box>}
        title={<>Two times.<br />Long or short.</>}
        lead={`Leverage on tokenized stocks, onchain, around the clock, built on Verdex Lend. A long buys the stock with your margin plus borrowed USDG and locks it; a short borrows the stock, sells it and locks the USDG next to your margin. One transaction each way. Every position is its own Lend position in an account that is yours: its own health, its own liquidation line, nothing shared with anyone.`}
        action={
          <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
            <Button onClick={() => (account ? document.getElementById('lev-composer')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) : openWalletMenu())} sx={{ ...Bt, gap: 1 }}>
              <TrendIcon size={15} /> {account ? 'Open a position' : 'Connect wallet'}
            </Button>
            <Button component={Link} to="/lend/verdex" sx={{ ...Lt, backdropFilter: 'none', gap: 1 }}>
              <HandCoinIcon size={14} /> The Lend markets behind it
            </Button>
          </Box>
        }
      />

      <Stats items={[{ label: 'Stocks', value: markets.data ? pairs.length : DEPLOYED ? '…' : '0' }, { label: 'Open interest', value: caps.data ? fmtCompact(totalOi) : DEPLOYED ? '…' : '$0' }, { label: 'Your positions', value: account ? (w.data ? myPositions.length : '…') : '-' }, { label: 'Your equity', value: account ? (w.data ? fmtUsd(myEquity, 0) : '…') : '-' }]} />
      <Typography sx={{ fontSize: 12, color: t.color.textLabel, mt: 1.5 }}>
        Read from the Verdex Leverage and Lend contracts on Robinhood Chain{DEPLOYED && <>, <Box component="a" href={explorerAddress(LEVERAGE)} target="_blank" rel="noopener noreferrer" sx={{ color: t.color.textMuted }}>{LEVERAGE.slice(0, 6)}…{LEVERAGE.slice(-4)}</Box></>}. Prices come from each stock's deepest USDG pool on Uniswap v3.
      </Typography>
      {err && <Typography sx={{ fontSize: 12, color: t.color.red, mt: 1 }}>{err}</Typography>}

      {!DEPLOYED && (
        <Panel sx={{ mt: 5, p: { xs: 3, md: 4 } }}>
          <Typography sx={{ fontSize: 16, fontWeight: 500, mb: 1 }}>Contract not deployed</Typography>
          <Typography sx={{ fontSize: 14, color: t.color.textMuted, lineHeight: 1.6 }}>The source is in the repository under contracts/VerdexLeverage.sol. When the deployment lands, this page reads it.</Typography>
        </Panel>
      )}

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1.1fr 0.9fr' }, gap: 3, mt: 5, alignItems: 'start' }}>
        <Box>
          <Typography sx={{ ...t.type.h3, mb: 2 }}>The stocks</Typography>
          <Box sx={{ display: 'grid', gap: 2 }}>
            {pairs.map((p) => <PairCard key={p.long.id.toString()} p={p} openLong={oi(p.long.id)} capLong={cap(p.long.id)} openShort={oi(p.short?.id)} capShort={cap(p.short?.id)} posL={pos(p.long.id)} posS={pos(p.short?.id)} selected={p.long.id === pair?.long.id} onPick={(s) => pick(p, s)} onClose={(s) => void act(p, s, 'close')} onSettle={(s) => void act(p, s, 'settle')} onAdd={(s) => void act(p, s, 'add')} busyId={busyId} />)}
            {DEPLOYED && markets.data && pairs.length === 0 && <Panel sx={{ p: 3 }}><Typography sx={{ fontSize: 14, color: t.color.textMuted }}>No market yet.</Typography></Panel>}
            {DEPLOYED && !markets.data && !markets.isError && <Panel sx={{ p: 3 }}><Typography sx={{ fontSize: 14, color: t.color.textMuted }}>Reading the markets and the pools behind them…</Typography></Panel>}
            {markets.isError && <Panel sx={{ p: 3 }}><Typography sx={{ fontSize: 14, color: t.color.textMuted }}>The chain is rate-limiting reads right now. Reload in a minute.</Typography></Panel>}
          </Box>
        </Box>
        <Box id="lev-composer" sx={{ position: { md: 'sticky' }, top: { md: 96 } }}>
          <Composer pairs={pairs} pair={pair} side={side} setPair={(p) => setPicked(p.long.id.toString())} setSide={setSide} wallet={wallet} chain={chain} usdg={w.data?.usdg ?? 0n} allowance={w.data?.allowance ?? 0n} holder={holder} feeBps={feeBps} capRoom={pair ? (side === 'long' ? cap(pair.long.id) - oi(pair.long.id) : cap(pair.short?.id) - oi(pair.short?.id)) : 0n} onDone={refresh} />
        </Box>
      </Box>

      <Box sx={{ mt: { xs: 8, md: 12 } }}>
        <Typography sx={{ ...t.type.h3, mb: 3 }}>How it works</Typography>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr', lg: 'repeat(4, 1fr)' }, gap: 2 }}>
          <Step n={1} icon={<WalletIcon size={16} />} title="Put up margin" text="USDG from your wallet. Pick a stock, a side and the leverage. The page shows the exposure, the health and the liquidation price before you sign." />
          <Step n={2} icon={<TrendIcon size={16} />} title="One swap" text="A long buys the stock with margin plus borrowed USDG and locks it in Lend, paying the pool inside the callback. A short locks your margin, borrows the stock from Lend and sells it, locking the USDG it fetched." />
          <Step n={3} icon={<LockIcon size={16} />} title="Your own account" text="Each wallet gets an account contract that holds its Lend positions. Nothing is pooled with anyone else; a liquidation touches one position, in one account." />
          <Step n={4} icon={<ShieldIcon size={16} />} title="Close or add margin" text="Close any time in one transaction: the loan is repaid and the rest comes back in USDG. Add margin to move the liquidation line. Under the line, anyone can liquidate in Lend." />
        </Box>
      </Box>

      <Panel sx={{ mt: { xs: 8, md: 12 }, p: { xs: 3, md: 5 }, display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 4, alignItems: 'center' }}>
        <Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5, color: t.color.mark }}><MarkIcon size={18} /><Typography sx={{ ...t.type.overline, color: t.color.textLabel }}>Capped while it is new</Typography></Box>
          <Typography sx={{ ...t.type.h3, mb: 1.5 }}>Open interest, with a ceiling.</Typography>
          <Typography sx={{ fontSize: 14, color: t.color.textMuted, lineHeight: 1.7 }}>Every market opens with a cap on open interest and the Lend caps behind it, raised as they prove themselves. The hub holds nothing; the accounts hold nothing between transactions. The owner keeps the caps, the fee and the treasury address and nothing else: there is no function that moves funds to the owner. Open source, verified, unaudited, tested on a fork of Robinhood Chain. Leverage multiplies a move both ways. Read it before you trust it with more than you would lose.</Typography>
        </Box>
        <Box sx={{ display: 'grid', gap: 1.25 }}>
          {[['Hold a position itself', 'every position is a Lend position in an account that is yours'], ['Pool your margin with anyone', 'one wallet, one account, one liquidation line'], ['Move funds to the owner', 'there is no such function'], ['Open past the cap', 'open interest per market, raised step by step']].map(([a, b]) => (
            <Box key={a} sx={{ display: 'flex', gap: 1.5, alignItems: 'flex-start' }}>
              <Box sx={{ color: t.color.mark, mt: '2px', flexShrink: 0 }}><CheckIcon size={14} /></Box>
              <Box><Typography sx={{ fontSize: 14, fontWeight: 500 }}>{a}</Typography><Typography sx={{ fontSize: 13, color: t.color.textMuted }}>{b}</Typography></Box>
            </Box>
          ))}
          {DEPLOYED && <Box component="a" href={explorerAddress(LEVERAGE)} target="_blank" rel="noopener noreferrer" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75, fontSize: 13, color: t.color.textMuted, mt: 1, textDecoration: 'none' }}>The contract on the explorer <ExternalIcon size={12} /></Box>}
        </Box>
      </Panel>
    </Page>
  )
}
