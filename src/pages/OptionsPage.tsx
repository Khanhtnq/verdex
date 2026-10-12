// Stock options: write a covered call or a cash-secured put, buy one, exercise it, or take the collateral back.
import { useMemo, useState } from 'react'
import { Avatar, Box, Button, InputBase, Typography } from '@mui/material'
import { useQueryClient } from '@tanstack/react-query'
import { formatUnits, parseUnits, type Address } from 'viem'
import { t, z } from '../theme/tokens'
import { Bt, Lt, Vg } from '../theme/styles'
import { useAssets, useChains } from '../lib/api'
import { describeError, type ChainX } from '../lib/lifi'
import { PHASE_LABEL, stockTokens, usePools, type Phase } from '../lib/pools'
import { poolFor } from '../lib/autopilot'
import { useFeatureOpen } from '../lib/holding'
import { EXPIRIES, OPTIONS, ZERO, buyOption, exercise, reclaim, useOptions, writeOption, type Option } from '../lib/options'
import { resolveImg } from '../lib/img'
import { useWallet } from '../components/wallet/WalletProvider'
import { EarlyGate } from '../components/EarlyGate'
import { ExternalIcon } from '../components/icons'
import { Page, PageHero, Panel } from './common'

type Tx = { phase: Phase; error?: string }
type Stock = { address: Address; ticker: string; decimals: number; logo?: string; priceUsd: number }
const Label = ({ children }: { children: React.ReactNode }) => <Typography sx={{ ...t.type.overline, color: t.color.textLabel, mb: 1.25 }}>{children}</Typography>
const Chip = ({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) => <Box component="button" type="button" onClick={onClick} aria-pressed={on} sx={{ all: 'unset', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 0.75, height: 32, px: 1.25, borderRadius: t.radius.input, fontSize: 13, fontWeight: 500, background: on ? t.color.text : t.color.chip, color: on ? t.color.page : t.color.text }}>{children}</Box>
const Field = ({ value, set, label }: { value: string; set: (v: string) => void; label: string }) => <InputBase value={value} onChange={(e) => set(e.target.value.replace(/[^0-9.]/g, ''))} inputProps={{ 'aria-label': label, inputMode: 'decimal' }} sx={{ width: '100%', height: 48, px: 1.5, borderRadius: t.radius.input, background: t.color.hover, fontSize: 20 }} />
const when = (s: number) => new Date(s * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const num = (v: bigint, d: number, max = 4) => Number(formatUnits(v, d)).toLocaleString('en-US', { maximumFractionDigits: max })
const lc = (a?: string) => a?.toLowerCase()

export default function OptionsPage() {
  const wallet = useWallet()
  const me = wallet.account?.address
  const { data: chains } = useChains()
  const chain = chains?.find((c) => c.id === 4663) as ChainX | undefined
  const putsOpen = useFeatureOpen('/options/puts', me)
  const assets = useAssets()
  const pools = usePools(assets.data?.assets)
  const stocks: Stock[] = useMemo(() => {
    const out: Stock[] = []
    if (assets.data && pools.data) for (const s of stockTokens(assets.data.assets)) { const p = poolFor(s, pools.data); if (p && p.priceUsd > 0) out.push({ address: s.address, ticker: s.ticker, decimals: s.decimals, logo: s.logo, priceUsd: p.priceUsd }) }
    return out
  }, [assets.data, pools.data])
  const stockOf = (a: Address) => stocks.find((s) => lc(s.address) === lc(a))
  const list = useOptions()
  const qc = useQueryClient()
  const refresh = () => void qc.invalidateQueries({ queryKey: ['options'] })
  const ctx = (set: (p: Phase) => void) => ({ walletClient: wallet.walletClient!, account: wallet.account!, chain, switchChain: wallet.switchChain, onPhase: set })

  const [isPut, setPut] = useState(false)
  const [tk, setTk] = useState('NVDA')
  const s = stocks.find((x) => x.ticker === tk) ?? stocks[0]
  const [amount, setAmount] = useState('0.1')
  const [strikePct, setStrikePct] = useState('110')
  const [premium, setPremium] = useState('1')
  const [exp, setExp] = useState(EXPIRIES[1])
  const [tx, setTx] = useState<Tx>({ phase: 'idle' })
  const busy = tx.phase !== 'idle' && tx.phase !== 'done' && tx.phase !== 'failed'
  const put = isPut && putsOpen
  const amt = Number(amount), strikePer = s ? (s.priceUsd * Number(strikePct)) / 100 : 0, strikeTotal = amt * strikePer
  const rawAmt = s && amt > 0 ? parseUnits(amt.toFixed(Math.min(8, s.decimals)), s.decimals) : 0n
  const rawStrike = strikeTotal > 0 ? parseUnits(strikeTotal.toFixed(6), 6) : 0n
  const rawPrem = Number(premium) > 0 ? parseUnits(Number(premium).toFixed(6), 6) : 0n
  const go = async () => {
    if (!wallet.walletClient || !me || !s || rawAmt === 0n || rawStrike === 0n) return
    setTx({ phase: 'switching' })
    try { await writeOption(ctx((p) => setTx({ phase: p })), { underlying: s.address, isPut: put, amount: rawAmt, strike: rawStrike, premium: rawPrem, days: exp.d }); setTx({ phase: 'done' }); refresh() } catch (e) { setTx({ phase: 'failed', error: describeError(e) }) }
  }
  const [rowTx, setRowTx] = useState<Record<string, Tx>>({})
  const run = async (o: Option, f: (c: ReturnType<typeof ctx>, o: Option) => Promise<unknown>) => {
    const k = o.id.toString(); const set = (p: Phase, error?: string) => setRowTx((m) => ({ ...m, [k]: { phase: p, error } }))
    try { await f(ctx((p) => set(p)), o); set('done'); refresh() } catch (e) { set('failed', describeError(e)) }
  }
  const now = Date.now() / 1000
  const shown = (list.data ?? []).filter((o) => stockOf(o.underlying) && (putsOpen || !o.isPut))
  const forSale = shown.filter((o) => o.state === 0 && o.holder === ZERO && o.expiresAt > now)
  const mine = shown.filter((o) => (lc(o.writer) === lc(me) || lc(o.holder) === lc(me)) && o.state === 0)
  const row = { display: 'flex', alignItems: 'center', gap: 1.5, p: 1.25, borderRadius: t.radius.input, background: t.color.raised, flexWrap: 'wrap' } as const
  const describe = (o: Option) => { const st = stockOf(o.underlying)!; const per = Number(formatUnits(o.strike, 6)) / Number(formatUnits(o.amount, st.decimals)); return `${o.isPut ? 'Put' : 'Call'} · ${num(o.amount, st.decimals)} ${st.ticker} at $${per.toFixed(2)} (now $${st.priceUsd.toFixed(2)}) · until ${when(o.expiresAt)}` }
  const Line = ({ o, children }: { o: Option; children: React.ReactNode }) => { const st = stockOf(o.underlying); const r = rowTx[o.id.toString()]; const b = r && r.phase !== 'done' && r.phase !== 'failed'; return (
    <Box sx={row}>
      <Avatar src={resolveImg(st?.logo)} sx={{ width: 20, height: 20, background: z.surface2, fontSize: 9 }}>{st?.ticker[0]}</Avatar>
      <Typography sx={{ fontSize: 13, flex: 1, minWidth: 200 }}>{describe(o)}</Typography>
      {b ? <Typography sx={{ fontSize: 12, color: t.color.textMuted }}>{PHASE_LABEL[r.phase]}</Typography> : children}
      {r?.phase === 'failed' && <Typography sx={{ fontSize: 12, color: t.color.red, width: '100%' }}>{r.error}</Typography>}
    </Box>) }

  return (
    <EarlyGate path="/options">
      <Page>
        <PageHero label="Stock options" badges={<Box sx={{ ...Vg, ml: 0, background: 'rgba(194,234,138,.16)', color: t.color.mark }}>New</Box>}
          title={<>Calls{putsOpen ? ' and puts' : ''}.<br />Onchain.</>}
          lead={`Options on tokenized stocks, written and settled onchain. A writer locks ${putsOpen ? 'the stock for a call, or the strike in USDG for a put,' : 'the stock'} and names a premium; a buyer pays it and holds the option. Until expiry the holder can exercise at the strike: ${putsOpen ? 'a call pays the strike and gets the stock, a put hands over the stock and gets the strike' : 'pay the strike, get the stock'}. Everything an option could need is locked from the start, so it always settles. No oracle.`} />
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0,1fr)', md: 'minmax(0,1fr) minmax(0,1.2fr)' }, gap: 2.5, mt: 4, alignItems: 'start' }}>
          <Panel sx={{ p: { xs: 2.5, md: 3 } }}>
            <Typography sx={{ fontSize: 16, fontWeight: 500, mb: 2 }}>Write an option</Typography>
            {putsOpen && <Box sx={{ display: 'flex', gap: 1, mb: 2.5 }}><Chip on={!isPut} onClick={() => { setPut(false); setStrikePct('110') }}>Covered call</Chip><Chip on={isPut} onClick={() => { setPut(true); setStrikePct('90') }}>Cash-secured put</Chip></Box>}
            <Label>Stock</Label>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, maxHeight: 148, overflowY: 'auto' }}>
              {stocks.map((x) => <Chip key={x.address} on={x.ticker === s?.ticker} onClick={() => { setTk(x.ticker); setAmount((100 / x.priceUsd).toPrecision(2)) }}><Avatar src={resolveImg(x.logo)} sx={{ width: 16, height: 16, background: z.surface2, fontSize: 8 }}>{x.ticker[0]}</Avatar>{x.ticker}</Chip>)}
            </Box>
            <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1.5, mt: 2.5 }}>
              <Box><Label>{s?.ticker} covered</Label><Field value={amount} set={setAmount} label="Amount" /></Box>
              <Box><Label>Strike, % of today</Label><Field value={strikePct} set={setStrikePct} label="Strike" /></Box>
            </Box>
            <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1.5, mt: 2.5 }}>
              <Box><Label>Premium, USDG</Label><Field value={premium} set={setPremium} label="Premium" /></Box>
              <Box><Label>Expires in</Label><Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>{EXPIRIES.map((e) => <Chip key={e.d} on={e.d === exp.d} onClick={() => setExp(e)}>{e.label}</Chip>)}</Box></Box>
            </Box>
            <Typography sx={{ fontSize: 12, color: t.color.textLabel, mt: 1.5 }}>{s && `Strike $${strikePer.toFixed(2)} per ${s.ticker}, $${strikeTotal.toFixed(2)} in all. You lock ${put ? `$${strikeTotal.toFixed(2)} USDG` : `${amount} ${s.ticker}`} until expiry, and keep the ${premium || 0} USDG premium whatever happens. ${put ? `If the holder exercises, you buy the ${s.ticker} at the strike.` : `If the holder exercises, you sell the ${s.ticker} at the strike.`} Nobody buys it? Take it back any time.`}</Typography>
            <Button fullWidth disabled={!!me && (busy || rawAmt === 0n || rawStrike === 0n)} onClick={() => (me ? void go() : wallet.openWalletMenu())} sx={{ ...Bt, height: 48, mt: 2.5 }}>{!me ? 'Connect wallet' : busy ? PHASE_LABEL[tx.phase] : `Write a ${put ? 'put' : 'call'} for ${premium || 0} USDG`}</Button>
            {tx.phase === 'failed' && <Typography sx={{ fontSize: 12, color: t.color.red, mt: 1 }}>{tx.error}</Typography>}
            {tx.phase === 'done' && <Typography sx={{ fontSize: 12, color: t.color.mark, mt: 1 }}>Written. It is for sale in the list on the right.</Typography>}
          </Panel>
          <Box sx={{ display: 'grid', gap: 2.5 }}>
            <Panel sx={{ p: { xs: 2.5, md: 3 } }}>
              <Typography sx={{ fontSize: 16, fontWeight: 500 }}>For sale</Typography>
              <Box sx={{ display: 'grid', gap: 0.75, mt: 2 }}>
                {forSale.map((o) => <Line key={o.id.toString()} o={o}>{lc(o.writer) !== lc(me) && <Button onClick={() => (me ? void run(o, buyOption) : wallet.openWalletMenu())} sx={{ ...Bt, height: 30, px: 1.5 }}>Buy for {num(o.premium, 6, 2)} USDG</Button>}</Line>)}
                {list.data && forSale.length === 0 && <Typography sx={{ fontSize: 13, color: t.color.textMuted }}>Nothing for sale right now. Write the first one.</Typography>}
                {!list.data && <Typography sx={{ fontSize: 13, color: t.color.textMuted }}>Reading the contract…</Typography>}
              </Box>
            </Panel>
            <Panel sx={{ p: { xs: 2.5, md: 3 } }}>
              <Typography sx={{ fontSize: 16, fontWeight: 500 }}>Yours</Typography>
              <Box sx={{ display: 'grid', gap: 0.75, mt: 2 }}>
                {mine.map((o) => { const holder = lc(o.holder) === lc(me); const st = stockOf(o.underlying)!; return (
                  <Line key={o.id.toString()} o={o}>
                    {holder && o.expiresAt > now && <Button onClick={() => void run(o, exercise)} sx={{ ...Bt, height: 30, px: 1.5 }}>{o.isPut ? `Exercise: sell ${num(o.amount, st.decimals)} ${st.ticker}` : `Exercise: pay ${num(o.strike, 6, 2)} USDG`}</Button>}
                    {!holder && (o.holder === ZERO || o.expiresAt <= now) && <Button onClick={() => void run(o, reclaim)} sx={{ ...Lt, backdropFilter: 'none', height: 30, px: 1.5 }}>Take it back</Button>}
                    {!holder && o.holder !== ZERO && o.expiresAt > now && <Typography sx={{ fontSize: 12, color: t.color.textMuted }}>Sold, live</Typography>}
                  </Line>) })}
                {me && list.data && mine.length === 0 && <Typography sx={{ fontSize: 13, color: t.color.textMuted }}>No options yet.</Typography>}
                {!me && <Typography sx={{ fontSize: 13, color: t.color.textMuted }}>Connect to see your options.</Typography>}
              </Box>
              <Typography sx={{ fontSize: 12, color: t.color.textLabel, mt: 2.5 }}>The options contract holds the writers' collateral and nothing else: no owner, no admin, no fee. Options can lose all of their premium. Verified, unaudited. <Box component="a" href={`https://robin.etherscan.io/address/${OPTIONS}`} target="_blank" rel="noopener noreferrer" sx={{ color: t.color.text, display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>Contract <ExternalIcon size={11} /></Box></Typography>
            </Panel>
          </Box>
        </Box>
      </Page>
    </EarlyGate>
  )
}
