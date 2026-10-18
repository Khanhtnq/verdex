// Term loans: post an offer to lend or a request to borrow, take one, repay or claim. Any stock, and VERDEX, as collateral.
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
import { VERDEX_TOKEN, useFeatureOpen } from '../lib/holding'
import { useMarket } from '../lib/token'
import { DAY, LONG_TERMS, SHORT_TERMS, TERM, closeOffer, claimLoan, collFor, collPerLoan, maxPrincipal, post, repay, take, useLoans, useOffers, type Loan, type Offer } from '../lib/term'
import { resolveImg } from '../lib/img'
import { useWallet } from '../components/wallet/WalletProvider'
import { EarlyGate } from '../components/EarlyGate'
import { ExternalIcon } from '../components/icons'
import { Page, PageHero, Panel } from './common'

type Tx = { phase: Phase; error?: string }
type Coll = { address: Address; ticker: string; decimals: number; logo?: string; priceUsd: number }
const Label = ({ children }: { children: React.ReactNode }) => <Typography sx={{ ...t.type.overline, color: t.color.textLabel, mb: 1.25 }}>{children}</Typography>
const Chip = ({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) => <Box component="button" type="button" onClick={onClick} aria-pressed={on} sx={{ all: 'unset', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 0.75, height: 32, px: 1.25, borderRadius: t.radius.input, fontSize: 13, fontWeight: 500, background: on ? t.color.text : t.color.chip, color: on ? t.color.page : t.color.text }}>{children}</Box>
const Field = ({ value, set, label }: { value: string; set: (v: string) => void; label: string }) => <InputBase value={value} onChange={(e) => set(e.target.value.replace(/[^0-9.]/g, ''))} inputProps={{ 'aria-label': label, inputMode: 'decimal' }} sx={{ width: '100%', height: 48, px: 1.5, borderRadius: t.radius.input, background: t.color.hover, fontSize: 20 }} />
const when = (s: number) => new Date(s * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const num = (v: bigint, d: number, max = 4) => Number(formatUnits(v, d)).toLocaleString('en-US', { maximumFractionDigits: max })
const usdg = (v: bigint) => `${num(v, 6, 2)} USDG`
const apr = (bps: number, days: number) => ((bps / 100) * 365) / days
const RATIOS = [1.25, 1.5, 2, 3]

export default function TermPage() {
  const wallet = useWallet()
  const me = wallet.account?.address
  const { data: chains } = useChains()
  const chain = chains?.find((c) => c.id === 4663) as ChainX | undefined
  const longOpen = useFeatureOpen('/lend/term/long', me)
  const verdexOpen = useFeatureOpen('/lend/term/verdex', me)
  const assets = useAssets()
  const pools = usePools(assets.data?.assets)
  const market = useMarket()
  const colls: Coll[] = useMemo(() => {
    const out: Coll[] = []
    if (verdexOpen && market.data?.price) out.push({ address: VERDEX_TOKEN.address, ticker: 'VERDEX', decimals: 18, logo: '/favicon-verdex.svg', priceUsd: market.data.price })
    if (assets.data && pools.data) for (const s of stockTokens(assets.data.assets)) { const p = poolFor(s, pools.data); if (p && p.priceUsd > 0) out.push({ address: s.address, ticker: s.ticker, decimals: s.decimals, logo: s.logo, priceUsd: p.priceUsd }) }
    return out
  }, [assets.data, pools.data, market.data, verdexOpen])
  const collOf = (a: Address) => colls.find((c) => c.address.toLowerCase() === a.toLowerCase())
  const offers = useOffers()
  const loans = useLoans(me)
  const qc = useQueryClient()
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['term-offers'] }); void qc.invalidateQueries({ queryKey: ['term-loans'] }) }
  const ctx = (set: (p: Phase) => void) => ({ walletClient: wallet.walletClient!, account: wallet.account!, chain, switchChain: wallet.switchChain, onPhase: set })

  // ---- post
  const [side, setSide] = useState<'lend' | 'borrow'>('lend')
  const [tk, setTk] = useState('NVDA')
  const coll = colls.find((c) => c.ticker === tk) ?? colls[0]
  const [amount, setAmount] = useState('100')
  const [ratio, setRatio] = useState(1.5)
  const [interest, setInterest] = useState('2')
  const terms = longOpen ? [...SHORT_TERMS, ...LONG_TERMS] : SHORT_TERMS
  const [days, setDays] = useState(30)
  const [tx, setTx] = useState<Tx>({ phase: 'idle' })
  const busy = tx.phase !== 'idle' && tx.phase !== 'done' && tx.phase !== 'failed'
  const per = coll ? collPerLoan(ratio, coll.priceUsd, coll.decimals) : 0n
  const isReq = side === 'borrow'
  const raw = coll && Number(amount) > 0 ? parseUnits(Number(amount).toFixed(isReq ? Math.min(coll.decimals, 8) : 6), isReq ? coll.decimals : 6) : 0n
  const backs = isReq && per > 0n ? maxPrincipal(raw, per) : 0n
  const bps = Math.round(Number(interest) * 100)
  const go = async () => {
    if (!wallet.walletClient || !me || !coll || raw === 0n) return
    setTx({ phase: 'switching' })
    try { await post(ctx((p) => setTx({ phase: p })), { isRequest: isReq, collateral: coll.address, amount: raw, collPerLoan: per, minLoan: 0n, interestBps: bps, termDays: days, openDays: 14 }); setTx({ phase: 'done' }); refresh() } catch (e) { setTx({ phase: 'failed', error: describeError(e) }) }
  }

  // ---- take
  const [takeAmt, setTakeAmt] = useState<Record<string, string>>({})
  const [takeTx, setTakeTx] = useState<Record<string, Tx>>({})
  const now = Date.now() / 1000
  const open = (offers.data ?? []).filter((o) => !o.closed && o.left > 0n && o.expiresAt > now && collOf(o.collateral))
  const capOf = (o: Offer) => (o.isRequest ? maxPrincipal(o.left, o.collPerLoan) : o.left)
  const doTake = async (o: Offer) => {
    const k = o.id.toString()
    const cap = capOf(o)
    const p = takeAmt[k] ? parseUnits(Number(takeAmt[k]).toFixed(6), 6) : cap
    const set = (ph: Phase, error?: string) => setTakeTx((m) => ({ ...m, [k]: { phase: ph, error } }))
    try { await take(ctx((ph) => set(ph)), o, p > cap ? cap : p); set('done'); refresh() } catch (e) { set('failed', describeError(e)) }
  }
  const act = async (f: () => Promise<unknown>) => { try { await f(); refresh() } catch { /* the wallet shows it */ } }

  const row = { display: 'flex', alignItems: 'center', gap: 1.5, p: 1.25, borderRadius: t.radius.input, background: t.color.raised, flexWrap: 'wrap' } as const
  const Coin = ({ c }: { c?: Coll }) => <Avatar src={resolveImg(c?.logo)} sx={{ width: 20, height: 20, background: z.surface2, fontSize: 9 }}>{c?.ticker[0]}</Avatar>
  const loanLine = (l: Loan) => { const c = collOf(l.collateral); const lender = l.lender.toLowerCase() === me?.toLowerCase(); return (
    <Box key={l.id.toString()} sx={row}>
      <Coin c={c} />
      <Typography sx={{ fontSize: 13, fontWeight: 500, minWidth: 140 }}>{lender ? 'You lent' : 'You borrowed'} {usdg(l.principal)}</Typography>
      <Typography sx={{ fontSize: 12, color: t.color.textMuted, flex: 1 }}>{num(l.collAmount, c?.decimals ?? 18)} {c?.ticker} locked · {usdg(l.owed)} due by {when(l.endAt)} · {['Live', 'Repaid', 'Collateral to the lender'][l.state]}</Typography>
      {l.state === 0 && !lender && now <= l.endAt && <Button onClick={() => void act(() => repay(ctx(() => {}), l))} sx={{ ...Bt, height: 30, px: 1.5 }}>Repay {usdg(l.owed)}</Button>}
      {l.state === 0 && lender && now > l.endAt && <Button onClick={() => void act(() => claimLoan(ctx(() => {}), l))} sx={{ ...Lt, backdropFilter: 'none', height: 30, px: 1.5 }}>Take the collateral</Button>}
    </Box>) }
  const mine = (offers.data ?? []).filter((o) => o.maker.toLowerCase() === me?.toLowerCase() && !o.closed)

  return (
    <EarlyGate path="/lend/term">
      <Page>
        <PageHero label="Term loans" badges={<Box sx={{ ...Vg, ml: 0, background: 'rgba(194,234,138,.16)', color: t.color.mark }}>New</Box>}
          title={<>Any stock.<br />Fixed terms.</>}
          lead={`Borrow USDG against any tokenized stock${verdexOpen ? ', or against VERDEX,' : ''} from another holder, at a fixed interest for a fixed term${longOpen ? ' of up to a year' : ''}. Lenders post offers, borrowers post requests, either side takes the other's. No price oracle and no liquidation before the end: repay any time until then and your collateral comes back. Not repaid by the end, the lender takes the collateral.`} />
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0,1fr)', md: 'minmax(0,1fr) minmax(0,1.2fr)' }, gap: 2.5, mt: 4, alignItems: 'start' }}>
          <Panel sx={{ p: { xs: 2.5, md: 3 } }}>
            <Box sx={{ display: 'flex', gap: 1 }}>
              <Chip on={side === 'lend'} onClick={() => { setSide('lend'); setAmount('100') }}>Lend USDG</Chip>
              <Chip on={side === 'borrow'} onClick={() => { setSide('borrow'); setAmount(coll ? (150 / coll.priceUsd).toPrecision(2) : '1') }}>Ask to borrow</Chip>
            </Box>
            <Box sx={{ mt: 2.5 }}><Label>Collateral</Label></Box>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, maxHeight: 148, overflowY: 'auto' }}>
              {colls.map((c) => <Chip key={c.address} on={c.ticker === coll?.ticker} onClick={() => { setTk(c.ticker); if (isReq) setAmount((150 / c.priceUsd).toPrecision(2)) }}><Avatar src={resolveImg(c.logo)} sx={{ width: 16, height: 16, background: z.surface2, fontSize: 8 }}>{c.ticker[0]}</Avatar>{c.ticker}</Chip>)}
            </Box>
            <Box sx={{ mt: 2.5 }}><Label>{isReq ? `${coll?.ticker ?? ''} you lock` : 'USDG you lend, at most'}</Label></Box>
            <Field value={amount} set={setAmount} label="Amount" />
            <Box sx={{ mt: 2.5 }}><Label>Collateral worth, at today's price</Label></Box>
            <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap' }}>{RATIOS.map((r) => <Chip key={r} on={r === ratio} onClick={() => setRatio(r)}>{Math.round(r * 100)}% of the loan</Chip>)}</Box>
            <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1.5, mt: 2.5 }}>
              <Box><Label>Interest, whole term %</Label><Field value={interest} set={setInterest} label="Interest" /></Box>
              <Box><Label>Term</Label><Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>{terms.map((d) => <Chip key={d} on={d === days} onClick={() => setDays(d)}>{d}d</Chip>)}</Box></Box>
            </Box>
            <Typography sx={{ fontSize: 12, color: t.color.textLabel, mt: 1.5 }}>
              {coll && `${num(per / 10n ** 12n, coll.decimals, 6)} ${coll.ticker} per USDG lent. ${Number(interest) > 0 ? `${interest}% over ${days} days is about ${apr(bps, days).toFixed(1)}% a year.` : ''}${isReq && backs > 0n ? ` Your ${amount} ${coll.ticker} backs up to ${usdg(backs)}.` : ''} Open for 14 days, close it any time.`}
            </Typography>
            <Button fullWidth disabled={!!me && (busy || raw === 0n || !coll || bps > 5000)} onClick={() => (me ? void go() : wallet.openWalletMenu())} sx={{ ...Bt, height: 48, mt: 2.5 }}>{!me ? 'Connect wallet' : busy ? PHASE_LABEL[tx.phase] : isReq ? `Post a request against ${amount} ${coll?.ticker ?? ''}` : `Post an offer of ${amount} USDG`}</Button>
            {tx.phase === 'failed' && <Typography sx={{ fontSize: 12, color: t.color.red, mt: 1 }}>{tx.error}</Typography>}
            {tx.phase === 'done' && <Typography sx={{ fontSize: 12, color: t.color.mark, mt: 1 }}>Posted. It is in the list on the right.</Typography>}
          </Panel>
          <Box sx={{ display: 'grid', gap: 2.5 }}>
            <Panel sx={{ p: { xs: 2.5, md: 3 } }}>
              <Typography sx={{ fontSize: 16, fontWeight: 500 }}>Open offers and requests</Typography>
              <Box sx={{ display: 'grid', gap: 0.75, mt: 2 }}>
                {open.map((o) => { const c = collOf(o.collateral)!; const k = o.id.toString(); const cap = capOf(o); const ttx = takeTx[k]; const tb = ttx && ttx.phase !== 'done' && ttx.phase !== 'failed'
                  const p = Number(takeAmt[k] || formatUnits(cap, 6)); const need = collFor(parseUnits(p.toFixed(6), 6), o.collPerLoan); const own = o.maker.toLowerCase() === me?.toLowerCase()
                  return (
                    <Box key={k} sx={{ ...row, alignItems: 'flex-start' }}>
                      <Coin c={c} />
                      <Box sx={{ flex: 1, minWidth: 180 }}>
                        <Typography sx={{ fontSize: 13, fontWeight: 500 }}>{o.isRequest ? `Wants up to ${usdg(cap)} against ${c.ticker}` : `Lends up to ${usdg(cap)} against ${c.ticker}`}</Typography>
                        <Typography sx={{ fontSize: 12, color: t.color.textMuted }}>{o.interestBps / 100}% for {o.term / DAY} days (about {apr(o.interestBps, o.term / DAY).toFixed(1)}% a year) · {num(o.collPerLoan / 10n ** 12n, c.decimals, 6)} {c.ticker} per USDG, worth {((Number(formatUnits(o.collPerLoan / 10n ** 12n, c.decimals)) * c.priceUsd) * 100).toFixed(0)}% now</Typography>
                        {!own && <Box sx={{ display: 'flex', gap: 1, mt: 1, alignItems: 'center', flexWrap: 'wrap' }}>
                          <InputBase value={takeAmt[k] ?? ''} placeholder={num(cap, 6, 2)} onChange={(e) => setTakeAmt((m) => ({ ...m, [k]: e.target.value.replace(/[^0-9.]/g, '') }))} inputProps={{ 'aria-label': 'USDG', inputMode: 'decimal' }} sx={{ width: 110, height: 32, px: 1, borderRadius: t.radius.input, background: t.color.hover, fontSize: 13 }} />
                          <Button disabled={!!me && !!tb} onClick={() => (me ? void doTake(o) : wallet.openWalletMenu())} sx={{ ...Bt, height: 32, px: 1.5 }}>{tb ? PHASE_LABEL[ttx.phase] : o.isRequest ? 'Lend' : `Borrow, lock ${num(need, c.decimals)} ${c.ticker}`}</Button>
                          {ttx?.phase === 'failed' && <Typography sx={{ fontSize: 12, color: t.color.red }}>{ttx.error}</Typography>}
                        </Box>}
                      </Box>
                    </Box>) })}
                {offers.data && open.length === 0 && <Typography sx={{ fontSize: 13, color: t.color.textMuted }}>Nothing open right now. Post the first one.</Typography>}
                {!offers.data && <Typography sx={{ fontSize: 13, color: t.color.textMuted }}>Reading the contract…</Typography>}
              </Box>
            </Panel>
            <Panel sx={{ p: { xs: 2.5, md: 3 } }}>
              <Typography sx={{ fontSize: 16, fontWeight: 500 }}>Yours</Typography>
              <Box sx={{ display: 'grid', gap: 0.75, mt: 2 }}>
                {mine.map((o) => { const c = collOf(o.collateral); return (
                  <Box key={`o${o.id}`} sx={row}><Coin c={c} /><Typography sx={{ fontSize: 13, flex: 1 }}>{o.isRequest ? `Your request: ${num(o.left, c?.decimals ?? 18)} ${c?.ticker} still locked` : `Your offer: ${usdg(o.left)} still to lend`}</Typography>
                    <Button onClick={() => void act(() => closeOffer(ctx(() => {}), o.id))} sx={{ ...Lt, backdropFilter: 'none', height: 30, px: 1.5 }}>Close, take back</Button></Box>) })}
                {(loans.data ?? []).map(loanLine)}
                {me && loans.data && loans.data.length === 0 && mine.length === 0 && <Typography sx={{ fontSize: 13, color: t.color.textMuted }}>No loans yet.</Typography>}
                {!me && <Typography sx={{ fontSize: 13, color: t.color.textMuted }}>Connect to see your loans.</Typography>}
              </Box>
              <Typography sx={{ fontSize: 12, color: t.color.textLabel, mt: 2.5 }}>The term loan contract holds open offers, requests and live loans and nothing else: no owner, no admin, no fee. A fixed term means no liquidation if the price drops, and no recall if it rises: price the collateral with that in mind. Verified, unaudited. <Box component="a" href={`https://robin.etherscan.io/address/${TERM}`} target="_blank" rel="noopener noreferrer" sx={{ color: t.color.text, display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>Contract <ExternalIcon size={11} /></Box></Typography>
            </Panel>
          </Box>
        </Box>
      </Page>
    </EarlyGate>
  )
}
