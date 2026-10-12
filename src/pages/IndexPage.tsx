// Verdex Index: baskets of tokenized stocks as one token each. The page lists the indexes the factory
// holds, prices them from the pools, and buys or sells shares through the router in one transaction.
import { useEffect, useMemo, useState } from 'react'
import { Avatar, Box, Button, InputBase, Typography } from '@mui/material'
import { Link } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { parseUnits } from 'viem'
import { BRAND, t, z } from '../theme/tokens'
import { Bt, Lt, Vg } from '../theme/styles'
import { CHAIN_NAME_LOGOS, fmtCompact, fmtUsd, useAssets, useChains } from '../lib/api'
import { describeError, explorerTx, type ChainX } from '../lib/lifi'
import { PHASE_LABEL, usePoolsOn, type Phase } from '../lib/pools'
import { INDEX_CHAINS, indexChain, type IndexChain } from '../lib/indexChains'
import { DEFAULT_SLIPPAGE_BPS, buyIndex, fmtShares, fmtUsdg, redeemIndex, sellIndex, sharesFor, useIndexWallet, useIndexes, useQuote, type IndexInfo } from '../lib/indexes'
import { resolveImg } from '../lib/img'
import { useWallet } from '../components/wallet/WalletProvider'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { CheckIcon, ExternalIcon, LayersIcon, LockIcon, PieIcon, ShieldIcon, WalletIcon } from '../components/icons'
import { MarkIcon } from '../components/Logo'
import { BacktestPanel } from '../components/BacktestPanel'
import { isOfficial } from '../lib/indexes'
import { useFeatureOpen } from '../lib/holding'
import { Page, PageHero, Panel, Stats } from './common'

const AMOUNTS = [25, 100, 250, 1000]
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
function Row({ k, v, strong }: { k: string; v: React.ReactNode; strong?: boolean }) {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 2, fontSize: 13 }}>
      <Typography sx={{ fontSize: 13, color: t.color.textMuted }}>{k}</Typography>
      <Typography sx={{ fontSize: 13, fontWeight: strong ? 500 : 400, textAlign: 'right' }}>{v}</Typography>
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

function IndexCard({ x, shares, selected, onPick, wallet, chain, onChanged }: { x: IndexInfo; shares: bigint; selected: boolean; onPick: (side: 'buy' | 'sell') => void; wallet: Ctx; chain: ChainX | undefined; onChanged: () => void }) {
  const [tx, setTx] = useState<Tx>({ phase: 'idle' })
  const [bt, setBt] = useState(false)
  const btOpen = useFeatureOpen('/backtest', wallet.account?.address)
  const busy = tx.phase !== 'idle' && tx.phase !== 'done' && tx.phase !== 'failed'
  const pct = x.maxSupply > 0n ? Number((x.totalSupply * 10_000n) / x.maxSupply) / 100 : 0
  const held = Number(shares) / 1e18
  const redeem = async () => {
    if (!wallet.walletClient || !wallet.account || shares === 0n) return
    setTx({ phase: 'switching' })
    try { const hash = await redeemIndex(txCtx(wallet, chain, (p) => setTx((s) => ({ ...s, phase: p }))), x, shares); setTx({ phase: 'done', hash }); onChanged() } catch (e) { setTx({ phase: 'failed', error: describeError(e) }) }
  }
  return (
    <Panel sx={{ p: 2.5, borderColor: selected ? 'rgba(194,234,138,.45)' : undefined }}>
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.5, flexWrap: 'wrap' }}>
        <Box sx={{ width: 44, height: 44, borderRadius: '12px', background: t.color.hover, display: 'grid', placeItems: 'center', color: t.color.mark, flexShrink: 0 }}><PieIcon size={20} /></Box>
        <Box sx={{ flex: 1, minWidth: 200 }}>
          <Typography sx={{ fontSize: 16, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 1 }}>
            {x.name}
            <Box component="span" sx={{ fontSize: 12, color: t.color.textMuted, fontWeight: 400 }}>{x.symbol}</Box>
          </Typography>
          <Typography sx={{ fontSize: 12, color: t.color.textMuted }}>
            {fmtUsd(x.navUsd, 4)} per share · {fmtCompact(x.tvlUsd)} held · {fmtShares(x.totalSupply, 0)} of {fmtShares(x.maxSupply, 0)} shares issued
          </Typography>
        </Box>
        <Box sx={{ textAlign: 'right' }}>
          <Typography sx={{ fontSize: 15, fontWeight: 500 }}>{held > 0 ? `${fmtShares(shares)} ${x.symbol}` : '0'}</Typography>
          <Typography sx={{ fontSize: 12, color: t.color.textMuted }}>{held > 0 ? `≈ ${fmtUsd(held * x.navUsd)}` : 'in your wallet'}</Typography>
        </Box>
      </Box>
      <Box sx={{ mt: 2, height: 6, borderRadius: 3, background: t.color.hover, overflow: 'hidden' }}>
        <Box sx={{ width: `${Math.min(100, pct)}%`, height: '100%', background: t.color.mark, borderRadius: 3 }} />
      </Box>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, mt: 2 }}>
        {x.components.map((c) => (
          <Box key={c.token} sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75, height: 28, px: 1.25, borderRadius: t.radius.input, background: t.color.hover, fontSize: 12, fontWeight: 500 }}>
            <Avatar src={resolveImg(c.stock?.logo)} sx={{ width: 16, height: 16, background: z.surface2, fontSize: 8 }}>{(c.stock?.ticker ?? '?')[0]}</Avatar>
            {c.stock?.ticker ?? `${c.token.slice(0, 6)}…`}
            <Box component="span" sx={{ color: t.color.textMuted, fontWeight: 400 }}>{(c.weight * 100).toFixed(1)}%</Box>
          </Box>
        ))}
      </Box>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 2, alignItems: 'center' }}>
        <Button disabled={!x.tradable} onClick={() => onPick('buy')} sx={{ ...Bt, height: 34, px: 1.75 }}>Buy</Button>
        <Button disabled={!x.tradable || shares === 0n} onClick={() => onPick('sell')} sx={{ ...Lt, backdropFilter: 'none', height: 34, px: 1.75 }}>Sell</Button>
        <Button disabled={shares === 0n || busy} onClick={() => void redeem()} sx={{ ...Lt, backdropFilter: 'none', height: 34, px: 1.75 }}>Redeem for the stocks</Button>
        {btOpen && <Button onClick={() => setBt((v) => !v)} aria-pressed={bt} sx={{ ...Lt, backdropFilter: 'none', height: 34, px: 1.75 }}>{bt ? 'Hide backtest' : 'Backtest'}</Button>}
        {busy && <Typography sx={{ fontSize: 12, color: t.color.textMuted }}>{PHASE_LABEL[tx.phase]}</Typography>}
        <Box component="a" href={`${x.chain.explorer}/address/${x.address}`} target="_blank" rel="noopener noreferrer" sx={{ ml: 'auto', display: 'inline-flex', alignItems: 'center', gap: 0.5, fontSize: 12, color: t.color.textMuted, textDecoration: 'none' }}>{x.address.slice(0, 6)}…{x.address.slice(-4)} <ExternalIcon size={11} /></Box>
      </Box>
      {bt && btOpen && <Box sx={{ mt: 2.5 }}><BacktestPanel ic={x.chain} legs={x.components.map((c) => ({ ticker: c.stock?.ticker ?? c.token, weight: c.weight }))} compact /></Box>}
      {!x.tradable && <Typography sx={{ fontSize: 12, color: t.color.red, mt: 1 }}>One of the pools behind this index is too thin to trade through right now. Redeeming in kind still works.</Typography>}
      {tx.phase === 'failed' && <Typography sx={{ fontSize: 12, color: t.color.red, mt: 1 }}>{tx.error}</Typography>}
      {tx.phase === 'done' && tx.hash && chain && <Typography sx={{ fontSize: 12, color: t.color.mark, mt: 1 }}>Redeemed. The stocks are in your wallet. <Box component="a" href={explorerTx(chain, x.chain.id, tx.hash)} target="_blank" rel="noopener noreferrer" sx={{ color: t.color.text }}>Transaction</Box></Typography>}
    </Panel>
  )
}

function Composer({ indexes, index, side, setIndex, setSide, wallet, chain, feeBps, holder, usdg, held, onDone }: { indexes: IndexInfo[]; index: IndexInfo | undefined; side: 'buy' | 'sell'; setIndex: (a: IndexInfo) => void; setSide: (s: 'buy' | 'sell') => void; wallet: Ctx; chain: ChainX | undefined; feeBps: number; holder: boolean; usdg: bigint; held: bigint; onDone: () => void }) {
  const [amount, setAmount] = useState('100')
  const [tx, setTx] = useState<Tx>({ phase: 'idle' })
  const q = index?.chain.quote ?? indexes[0].chain.quote
  const amt = Number(amount) > 0 ? parseUnits(Number(amount).toFixed(6), q.decimals) : 0n
  const shares = useMemo(() => {
    if (!index) return 0n
    if (side === 'buy') return sharesFor(index, amt)
    const want = Number(amount) > 0 ? parseUnits(Number(amount).toFixed(6), 18) : 0n
    return want > held ? held : want
  }, [index, side, amt, amount, held])
  const quote = useQuote(index, shares, side)
  const fee = holder ? 0 : feeBps
  const busy = tx.phase !== 'idle' && tx.phase !== 'done' && tx.phase !== 'failed'
  const maxIn = quote.data ? (quote.data.total * BigInt(10_000 + DEFAULT_SLIPPAGE_BPS + fee)) / 10_000n + 1n : 0n
  const minOut = quote.data ? (quote.data.total * BigInt(10_000 - DEFAULT_SLIPPAGE_BPS - fee)) / 10_000n : 0n
  const short = !!wallet.account && side === 'buy' && !!quote.data && usdg < maxIn
  const ready = !!wallet.account && !!index && index.tradable && shares > 0n && !!quote.data && !busy && !short
  const go = async () => {
    if (!wallet.walletClient || !wallet.account || !index || !quote.data) return
    setTx({ phase: 'switching' })
    try {
      const ctx = txCtx(wallet, chain, (p) => setTx((x) => ({ ...x, phase: p })))
      const hash = side === 'buy' ? await buyIndex(ctx, index, shares, quote.data, DEFAULT_SLIPPAGE_BPS, fee) : await sellIndex(ctx, index, shares, quote.data, DEFAULT_SLIPPAGE_BPS, fee)
      setTx({ phase: 'done', hash })
      onDone()
    } catch (e) {
      setTx({ phase: 'failed', error: describeError(e) })
    }
  }
  return (
    <Panel sx={{ p: { xs: 2.5, md: 3 } }}>
      <Box sx={{ display: 'flex', gap: 1, mb: 2.5 }}>
        <Choice on={side === 'buy'} onClick={() => { setSide('buy'); setTx({ phase: 'idle' }) }}>Buy</Choice>
        <Choice on={side === 'sell'} onClick={() => { setSide('sell'); setTx({ phase: 'idle' }) }}>Sell</Choice>
      </Box>
      <Label>Index</Label>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
        {indexes.map((x) => <Choice key={x.address} on={x.address === index?.address} onClick={() => { setIndex(x); setTx({ phase: 'idle' }) }} disabled={!x.tradable}>{x.symbol}</Choice>)}
      </Box>
      <Box sx={{ mt: 2.5 }}>
        <Label>{side === 'buy' ? `Amount, in ${q.symbol}` : `Shares of ${index?.symbol ?? 'the index'}`}</Label>
        {side === 'buy' && <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mb: 1 }}>{AMOUNTS.map((a) => <Choice key={a} on={Number(amount) === a} onClick={() => setAmount(String(a))}>${a}</Choice>)}</Box>}
        {side === 'sell' && held > 0n && <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mb: 1 }}>{[25, 50, 100].map((p) => <Choice key={p} on={false} onClick={() => setAmount((Number(held) / 1e18 * p / 100).toFixed(6).replace(/\.?0+$/, ''))}>{p}%</Choice>)}</Box>}
        <InputBase value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="Amount" inputProps={{ 'aria-label': side === 'buy' ? `${q.symbol} to spend` : 'Shares to sell', inputMode: 'decimal' }} sx={{ width: '100%', height: 40, px: 1.5, borderRadius: t.radius.input, background: t.color.hover, fontSize: 14, fontWeight: 500 }} />
      </Box>
      <Box sx={{ mt: 3, p: 2, borderRadius: t.radius.panel, background: t.color.raised, display: 'grid', gap: 1 }}>
        {side === 'buy' ? (
          <>
            <Row k="You get" v={index && shares > 0n ? `${fmtShares(shares, 4)} ${index.symbol}` : '…'} strong />
            <Row k="At the pools' spot price" v={quote.data ? fmtUsdg(quote.data.total) : quote.isFetching ? 'reading the pools…' : '…'} />
            <Row k="Most it can take" v={quote.data ? `${fmtUsdg(maxIn)}, the rest is refunded` : '…'} />
          </>
        ) : (
          <>
            <Row k="You sell" v={index && shares > 0n ? `${fmtShares(shares, 4)} ${index.symbol}` : '…'} strong />
            <Row k="At the pools' spot price" v={quote.data ? fmtUsdg(quote.data.total) : quote.isFetching ? 'reading the pools…' : '…'} />
            <Row k="Least you receive" v={quote.data ? fmtUsdg(minOut) : '…'} />
          </>
        )}
        <Row k="Price floor" v={`${DEFAULT_SLIPPAGE_BPS / 100}% from spot, on every leg`} />
        <Row k={`${BRAND.name} fee`} v={holder ? 'None, you hold VERDEX' : `${(feeBps / 100).toFixed(2)}% in ${q.symbol}`} />
      </Box>
      {short && <Typography sx={{ fontSize: 12, color: t.color.red, mt: 1.5 }}>Your wallet holds {fmtUsdg(usdg)} {q.symbol} on {index?.chain.name}; this buy needs up to {fmtUsdg(maxIn)}.</Typography>}
      {quote.isError && <Typography sx={{ fontSize: 12, color: t.color.red, mt: 1.5 }}>Could not read the pools. Try again in a moment.</Typography>}
      <Button onClick={() => (wallet.account ? void go() : wallet.openWalletMenu())} disabled={!!wallet.account && !ready} sx={{ ...Bt, width: '100%', mt: 2.5, height: 44 }}>
        {!wallet.account ? 'Connect wallet' : busy ? PHASE_LABEL[tx.phase] : side === 'buy' ? `Approve ${q.symbol} and buy ${index?.symbol ?? ''}` : `Approve and sell ${index?.symbol ?? ''}`}
      </Button>
      {tx.phase === 'failed' && <Typography sx={{ fontSize: 12, color: t.color.red, mt: 1.5 }}>{tx.error}</Typography>}
      {tx.phase === 'done' && tx.hash && chain && (
        <Box sx={{ mt: 2, p: 2, borderRadius: t.radius.panel, background: 'rgba(194,234,138,.10)', border: '1px solid rgba(194,234,138,.3)' }}>
          <Typography sx={{ fontSize: 14, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 1 }}><CheckIcon size={16} /> {side === 'buy' ? 'The shares are in your wallet.' : `Sold. The ${q.symbol} is in your wallet.`}</Typography>
          <Typography sx={{ fontSize: 13, color: t.color.textMuted, mt: 0.5 }}>{side === 'buy' ? `One transaction bought every stock behind them and issued the shares. Unspent ${q.symbol} came back.` : 'One transaction redeemed the stocks and sold each one in its pool.'}</Typography>
          <Box component="a" href={explorerTx(chain, index?.chain.id ?? 0, tx.hash)} target="_blank" rel="noopener noreferrer" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, mt: 1, fontSize: 13, color: t.color.text, textDecoration: 'none' }}>Transaction <ExternalIcon size={12} /></Box>
        </Box>
      )}
    </Panel>
  )
}

export default function IndexPage() {
  const wallet = useWallet()
  const { account, openWalletMenu } = wallet
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const ic: IndexChain = indexChain(params.get('chain') ?? undefined)
  const setChain = (c: IndexChain) => { setParams(c.key === 'robinhood' ? {} : { chain: c.key }, { replace: true }); setPicked(undefined) }
  const DEPLOYED = ic.deployed
  const createOpen = useFeatureOpen('/index/create', account?.address)
  const communityOpen = useFeatureOpen('/index/community', account?.address)
  const { data: chains } = useChains()
  const chain = chains?.find((c) => c.id === ic.id) as ChainX | undefined
  const assets = useAssets()
  const pools = usePoolsOn(ic, assets.data?.assets)
  const indexes = useIndexes(ic, assets.data?.assets, pools.data)
  const addresses = useMemo(() => indexes.data?.map((x) => x.address), [indexes.data])
  const w = useIndexWallet(ic, account?.address, addresses)
  const qc = useQueryClient()
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['indexes'] }); void qc.invalidateQueries({ queryKey: ['index-wallet'] }) }
  const [side, setSide] = useState<'buy' | 'sell'>('buy')
  const [picked, setPicked] = useState<string | undefined>(() => params.get('index') ?? undefined)
  const index = indexes.data?.find((x) => x.address.toLowerCase() === picked?.toLowerCase()) ?? indexes.data?.find((x) => x.tradable) ?? indexes.data?.[0]
  useEffect(() => { if (!picked && index) setPicked(index.address) }, [picked, index])
  const list = (indexes.data ?? []).filter((x) => isOfficial(x.address))
  const composerList = (indexes.data ?? []).filter((x) => isOfficial(x.address) || x.address.toLowerCase() === picked?.toLowerCase())
  const tvl = list.reduce((s, x) => s + x.tvlUsd, 0)
  const mine = list.reduce((s, x) => s + (Number(w.data?.shares[x.address.toLowerCase()] ?? 0n) / 1e18) * x.navUsd, 0)
  const holder = (w.data?.verdex ?? 0n) > 0n
  const feeBps = w.data?.feeBps ?? 25
  const q = ic.quote.symbol
  const pick = (x: IndexInfo, s: 'buy' | 'sell') => { setPicked(x.address); setSide(s); document.getElementById('index-composer')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }

  return (
    <Page>
      <PageHero
        label="Verdex Index"
        badges={<Box sx={{ ...Vg, ml: 0, background: 'rgba(194,234,138,.16)', color: t.color.mark }}>{DEPLOYED ? 'Live' : 'Contracts not deployed'}</Box>}
        title={<>A basket<br />becomes a token.</>}
        lead={`An index is one ERC-20 backed by a fixed number of units of each stock behind it, held by a contract on ${ic.name}. Buy it with ${q} and one transaction buys every stock and issues your shares; sell it and the same happens in reverse. Or redeem it for the stocks themselves, any time. The contract holds the stocks and nothing else. No issuer, no manager${ic.key === 'robinhood' ? ', no Verdex fee for VERDEX holders' : ''}.`}
        action={
          <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
            <Button onClick={() => (account ? document.getElementById('index-composer')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) : openWalletMenu())} sx={{ ...Bt, gap: 1 }}>
              <PieIcon size={15} /> {account ? 'Buy an index' : 'Connect wallet'}
            </Button>
            {createOpen && <Button component={Link} to={`/index/create${ic.key === 'base' ? '?chain=base' : ''}`} sx={{ ...Lt, backdropFilter: 'none', gap: 1 }}>Make your own</Button>}
            {communityOpen && <Button component={Link} to="/index/community" sx={{ ...Lt, backdropFilter: 'none', gap: 1 }}>Community indexes</Button>}
            <Button component={Link} to="/rwa-baskets" sx={{ ...Lt, backdropFilter: 'none', gap: 1 }}>
              <LayersIcon size={14} /> Baskets, stock by stock
            </Button>
          </Box>
        }
      />

      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mt: 4 }}>
        {INDEX_CHAINS.map((c) => (
          <Choice key={c.key} on={c.key === ic.key} onClick={() => setChain(c)}>
            <Avatar src={CHAIN_NAME_LOGOS[c.name]} sx={{ width: 16, height: 16, background: 'transparent' }} />
            {c.name}
            {!c.deployed && <Box component="span" sx={{ color: c.key === ic.key ? t.color.page : t.color.textMuted, fontWeight: 400, opacity: 0.8 }}>soon</Box>}
          </Choice>
        ))}
        <Choice on={false} onClick={() => navigate('/solana')}>
          <Avatar src={CHAIN_NAME_LOGOS.Solana} sx={{ width: 16, height: 16, background: 'transparent' }} />
          Solana
        </Choice>
      </Box>
      <Stats items={[{ label: 'Indexes', value: indexes.data ? list.length : DEPLOYED ? '…' : '0' }, { label: 'Held in them', value: indexes.data ? fmtCompact(tvl) : DEPLOYED ? '…' : '$0' }, { label: 'Yours', value: account ? (w.data ? fmtUsd(mine, 0) : '…') : '-' }, { label: `${BRAND.name} fee`, value: holder ? '0%' : `${(feeBps / 100).toFixed(2)}%` }]} />
      <Typography sx={{ fontSize: 13, color: t.color.textLabel, mt: 1.5 }}>
        Read from the {BRAND.name} Index contracts on {ic.name}{DEPLOYED ? <>, factory <Box component="a" href={`${ic.explorer}/address/${ic.factory}`} target="_blank" rel="noopener noreferrer" sx={{ color: t.color.text }}>{ic.factory.slice(0, 6)}…{ic.factory.slice(-4)}</Box> and router <Box component="a" href={`${ic.explorer}/address/${ic.router}`} target="_blank" rel="noopener noreferrer" sx={{ color: t.color.text }}>{ic.router.slice(0, 6)}…{ic.router.slice(-4)}</Box></> : ''}. Prices come from each stock's deepest {q} pool on {ic.dexName}, as you look.{ic.key === 'base' ? ' The stocks on Base are Coinbase\'s tokenized shares.' : ''}
      </Typography>

      {!DEPLOYED && (
        <Panel sx={{ mt: 5, p: { xs: 3, md: 4 } }}>
          <Typography sx={{ fontSize: 16, fontWeight: 500 }}>The contracts are not on {ic.name} yet.</Typography>
          <Typography sx={{ fontSize: 14, color: t.color.textMuted, mt: 0.75 }}>The code is in the repository and tested against {ic.name}'s live state. The indexes open here the moment it is deployed.</Typography>
        </Panel>
      )}

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0,1fr)', md: 'minmax(0,1fr) 440px' }, gap: 2.5, mt: { xs: 5, md: 7 }, alignItems: 'start' }}>
        <Box sx={{ minWidth: 0 }}>
          <Box sx={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 2, mb: 2, flexWrap: 'wrap' }}>
            <Typography component="h2" sx={{ ...t.type.h3, color: t.color.text }}>The indexes</Typography>
            {account && w.data && <Typography sx={{ fontSize: 13, color: t.color.textMuted }}>wallet {fmtUsdg(w.data.usdg)} {q}</Typography>}
          </Box>
          <Box sx={{ display: 'grid', gap: 1.5 }}>
            {list.map((x) => <IndexCard key={x.address} x={x} shares={w.data?.shares[x.address.toLowerCase()] ?? 0n} selected={x.address === index?.address} onPick={(s) => pick(x, s)} wallet={wallet} chain={chain} onChanged={refresh} />)}
            {DEPLOYED && indexes.data && list.length === 0 && <Panel sx={{ p: 3 }}><Typography sx={{ fontSize: 14, color: t.color.textMuted }}>No index yet.</Typography></Panel>}
            {DEPLOYED && !indexes.data && !indexes.isError && <Panel sx={{ p: 3 }}><Typography sx={{ fontSize: 14, color: t.color.textMuted }}>Reading the indexes and the pools behind them…</Typography></Panel>}
            {indexes.isError && <Panel sx={{ p: 3 }}><Typography sx={{ fontSize: 14, color: t.color.textMuted }}>The chain is rate-limiting reads right now. Reload in a minute.</Typography></Panel>}
          </Box>
        </Box>
        <Box id="index-composer" sx={{ minWidth: 0, scrollMarginTop: 96 }}>
          {DEPLOYED && list.length > 0 ? <Composer indexes={composerList} index={index} side={side} setIndex={(x) => setPicked(x.address)} setSide={setSide} wallet={wallet} chain={chain} feeBps={feeBps} holder={holder} usdg={w.data?.usdg ?? 0n} held={index ? (w.data?.shares[index.address.toLowerCase()] ?? 0n) : 0n} onDone={refresh} /> : null}
        </Box>
      </Box>

      <Box sx={{ mt: { xs: 8, md: 12 } }}>
        <Typography component="h2" sx={{ ...t.type.h3, color: t.color.text }}>How it works</Typography>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(3, minmax(0,1fr))' }, gap: 2.5, mt: 4 }}>
          <Step n={1} icon={<PieIcon size={20} />} title="Units, not weights" text="Each share is a fixed number of units of every stock, set at creation. The weights you see are those units at today's prices. Nothing rebalances, nothing is managed; the basket is what it says, forever." />
          <Step n={2} icon={<LayersIcon size={20} />} title="One transaction in, one out" text={`Buying sends ${q} to the router, which buys exactly the units in each stock's ${ic.dexName} pool, issues the shares and refunds what it did not need. Selling redeems the stocks and sells each one. Every leg has a price floor; a thin pool makes the trade revert, not fill badly.`} />
          <Step n={3} icon={<LockIcon size={20} />} title="Redeem in kind, always" text="Your shares are a claim on the stocks in the contract, and you can take them out whenever you want with no pool, no router and no fee. The index contract holds the stocks behind the shares and nothing else." />
        </Box>
      </Box>

      <Panel sx={{ mt: { xs: 8, md: 12 }, p: { xs: 3, md: 5 }, display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 4, alignItems: 'center' }}>
        <Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <Box sx={{ width: 40, height: 40, borderRadius: '10px', background: '#000', border: `1px solid ${t.color.borderStrong}`, display: 'grid', placeItems: 'center' }}><MarkIcon size={22} /></Box>
            <Box sx={{ ...Vg, ml: 0 }}>Phase 2, box 1</Box>
          </Box>
          <Typography component="h2" sx={{ ...t.type.h3, color: t.color.text, mt: 2.5 }}>Capped while it is new.</Typography>
          <Typography sx={{ ...t.type.body, color: t.color.textMuted, mt: 2 }}>
            Every index starts with a cap on its share supply, so the amount of stock any one contract holds stays small while the code is young. The contracts are open source, verified on the explorer and tested against each chain's live state, and they are unaudited. The index contract has no function that moves your stocks anywhere but back to a redeemer; its only lever is the cap. Read it before you trust it with more than you would lose.
          </Typography>
        </Box>
        <Box sx={{ display: 'grid', gap: 1.5 }}>
          {[[<ShieldIcon key="a" size={16} />, 'The index holds only the stocks behind the shares. There is no function to send them elsewhere.'], [<WalletIcon key="b" size={16} />, `The router keeps no balance. ${q} in, shares out, in one transaction; what is left over is refunded.`], [<CheckIcon key="c" size={16} />, ic.key === 'robinhood' ? 'VERDEX holders pay no Verdex fee on buys and sells. Redeeming in kind is free for everyone.' : 'The fee on Base is 0.25% and goes to the treasury wallet, which buys VERDEX. Redeeming in kind is free for everyone.']].map(([icon, text], i) => (
            <Box key={i} sx={{ display: 'flex', gap: 1.5, alignItems: 'flex-start', p: 2, borderRadius: t.radius.panel, background: t.color.raised }}>
              <Box sx={{ color: t.color.mark, mt: 0.25 }}>{icon}</Box>
              <Typography sx={{ fontSize: 14, color: t.color.textSoft }}>{text}</Typography>
            </Box>
          ))}
        </Box>
      </Panel>
    </Page>
  )
}
