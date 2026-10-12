// Gift a stock: choose a tokenized stock or USDG, an amount and an expiry, get a link. Plus the gifts you have sent.
import { useMemo, useState } from 'react'
import { Avatar, Box, Button, InputBase, Typography } from '@mui/material'
import { useQueryClient } from '@tanstack/react-query'
import { formatUnits, parseUnits, type Address } from 'viem'
import { t, z } from '../theme/tokens'
import { Bt, Lt, Vg } from '../theme/styles'
import { useAssets, useChains } from '../lib/api'
import { describeError, type ChainX } from '../lib/lifi'
import { PHASE_LABEL, USDG, stockTokens, usePools, type Phase } from '../lib/pools'
import { poolFor } from '../lib/autopilot'
import { EXPIRIES, GIFT_ADDRESS, createGift, takeBack, useSent, type Gift } from '../lib/gift'
import { resolveImg, TOKEN_LOGOS } from '../lib/img'
import { useWallet } from '../components/wallet/WalletProvider'
import { EarlyGate } from '../components/EarlyGate'
import { ExternalIcon } from '../components/icons'
import { Page, PageHero, Panel } from './common'

type Tx = { phase: Phase; error?: string }
type Opt = { address: Address; ticker: string; decimals: number; logo?: string; priceUsd: number }
const Label = ({ children }: { children: React.ReactNode }) => <Typography sx={{ ...t.type.overline, color: t.color.textLabel, mb: 1.25 }}>{children}</Typography>
const when = (s: number) => new Date(s * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const STATE = ['Waiting for its link', 'Claimed', 'Taken back']

export default function GiftPage() {
  const wallet = useWallet()
  const { data: chains } = useChains()
  const chain = chains?.find((c) => c.id === 4663) as ChainX | undefined
  const assets = useAssets()
  const pools = usePools(assets.data?.assets)
  const options: Opt[] = useMemo(() => {
    const out: Opt[] = [{ address: USDG.address, ticker: 'USDG', decimals: 6, logo: TOKEN_LOGOS.USDG, priceUsd: 1 }]
    if (assets.data && pools.data) for (const s of stockTokens(assets.data.assets)) { const p = poolFor(s, pools.data); if (p && p.liquidityUsd > 20_000) out.push({ address: s.address, ticker: s.ticker, decimals: s.decimals, logo: s.logo, priceUsd: p.priceUsd }) }
    return out
  }, [assets.data, pools.data])
  const [tk, setTk] = useState('NVDA')
  const opt = options.find((o) => o.ticker === tk) ?? options[0]
  const [amount, setAmount] = useState('0.1')
  const [life, setLife] = useState(EXPIRIES[1])
  const [tx, setTx] = useState<Tx>({ phase: 'idle' })
  const [link, setLink] = useState<string>()
  const [copied, setCopied] = useState(false)
  const busy = tx.phase !== 'idle' && tx.phase !== 'done' && tx.phase !== 'failed'
  const raw = Number(amount) > 0 ? parseUnits(Number(amount).toFixed(opt.decimals > 8 ? 8 : opt.decimals), opt.decimals) : 0n
  const usd = Number(amount) * opt.priceUsd
  const sent = useSent(wallet.account?.address)
  const qc = useQueryClient()
  const ctx = (set: (p: Phase) => void) => ({ walletClient: wallet.walletClient!, account: wallet.account!, chain, switchChain: wallet.switchChain, onPhase: set })
  const go = async () => {
    if (!wallet.walletClient || !wallet.account || raw === 0n) return
    setTx({ phase: 'switching' }); setLink(undefined)
    try { const r = await createGift(ctx((p) => setTx({ phase: p })), opt.address, raw, life.s); setLink(r.link); setTx({ phase: 'done' }); void qc.invalidateQueries({ queryKey: ['gifts-sent'] }) } catch (e) { setTx({ phase: 'failed', error: describeError(e) }) }
  }
  const back = async (g: Gift) => { try { await takeBack(ctx(() => {}), g.id); void qc.invalidateQueries({ queryKey: ['gifts-sent'] }) } catch { /* shown by the wallet */ } }
  const tickerOf = (a: Address) => options.find((o) => o.address.toLowerCase() === a.toLowerCase())
  const now = Date.now() / 1000
  return (
    <EarlyGate path="/gift">
      <Page>
        <PageHero label="Gift a stock" badges={<Box sx={{ ...Vg, ml: 0, background: 'rgba(194,234,138,.16)', color: t.color.mark }}>New</Box>}
          title={<>A stock<br />in a link.</>}
          lead="Put a tokenized stock or USDG into a link and send it to anyone. They open it, connect a wallet and it lands there; Verdex pays the gas of the claim. The link carries a one-time key that never reaches a server, and the claim is signed for the receiver's own address, so nobody can grab it on the way. Not claimed before the expiry? Take it back." />
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0,1fr)', md: 'minmax(0,1fr) minmax(0,1fr)' }, gap: 2.5, mt: 4, alignItems: 'start' }}>
          <Panel sx={{ p: { xs: 2.5, md: 3 } }}>
            <Label>What to give</Label>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
              {options.slice(0, 30).map((o) => (
                <Box key={o.address} component="button" type="button" onClick={() => { setTk(o.ticker); setAmount(o.ticker === 'USDG' ? '25' : (25 / o.priceUsd).toPrecision(2)) }} aria-pressed={o.ticker === opt.ticker} sx={{ all: 'unset', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 0.75, height: 32, px: 1.25, borderRadius: t.radius.input, fontSize: 13, fontWeight: 500, background: o.ticker === opt.ticker ? t.color.text : t.color.chip, color: o.ticker === opt.ticker ? t.color.page : t.color.text }}>
                  <Avatar src={resolveImg(o.logo)} sx={{ width: 16, height: 16, background: z.surface2, fontSize: 8 }}>{o.ticker[0]}</Avatar>{o.ticker}
                </Box>
              ))}
            </Box>
            <Box sx={{ mt: 2.5 }}><Label>How much {opt.ticker}</Label></Box>
            <InputBase value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} inputProps={{ 'aria-label': 'Amount', inputMode: 'decimal' }} sx={{ width: '100%', height: 48, px: 1.5, borderRadius: t.radius.input, background: t.color.hover, fontSize: 20 }} />
            <Typography sx={{ fontSize: 12, color: t.color.textLabel, mt: 1 }}>{usd > 0 ? `About $${usd.toFixed(2)} at the pool's price now.` : ' '}</Typography>
            <Box sx={{ mt: 2.5 }}><Label>If nobody claims it, back to you after</Label></Box>
            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>{EXPIRIES.map((e) => <Box key={e.s} component="button" type="button" onClick={() => setLife(e)} aria-pressed={e.s === life.s} sx={{ all: 'unset', cursor: 'pointer', ...Vg, ml: 0, ...(e.s === life.s && { background: t.color.text, color: t.color.page }) }}>{e.label}</Box>)}</Box>
            <Button fullWidth disabled={!!wallet.account && (busy || raw === 0n)} onClick={() => (wallet.account ? void go() : wallet.openWalletMenu())} sx={{ ...Bt, height: 48, mt: 3 }}>{!wallet.account ? 'Connect wallet' : busy ? PHASE_LABEL[tx.phase] : `Make a gift of ${amount || '0'} ${opt.ticker}`}</Button>
            {tx.phase === 'failed' && <Typography sx={{ fontSize: 12, color: t.color.red, mt: 1 }}>{tx.error}</Typography>}
            {link && (
              <Box sx={{ mt: 2.5, p: 2, borderRadius: t.radius.input, background: 'rgba(194,234,138,.10)' }}>
                <Typography sx={{ fontSize: 14, fontWeight: 500 }}>Your gift link</Typography>
                <Typography sx={{ fontSize: 12, color: t.color.textMuted, mt: 0.5, wordBreak: 'break-all' }}>{link}</Typography>
                <Box sx={{ display: 'flex', gap: 1, mt: 1.5, flexWrap: 'wrap' }}>
                  <Button onClick={() => { void navigator.clipboard.writeText(link); setCopied(true) }} sx={{ ...Bt, height: 36, px: 2 }}>{copied ? 'Copied' : 'Copy link'}</Button>
                </Box>
                <Typography sx={{ fontSize: 12, color: t.color.textLabel, mt: 1.5 }}>Whoever has this link can claim the gift. Send it privately, not in a public post. It is shown once: copy it now.</Typography>
              </Box>
            )}
          </Panel>
          <Panel sx={{ p: { xs: 2.5, md: 3 } }}>
            <Typography sx={{ fontSize: 16, fontWeight: 500 }}>Gifts you sent</Typography>
            <Box sx={{ display: 'grid', gap: 0.75, mt: 2 }}>
              {(sent.data ?? []).map((g) => { const o = tickerOf(g.token); return (
                <Box key={g.id.toString()} sx={{ display: 'flex', alignItems: 'center', gap: 1.5, p: 1.25, borderRadius: t.radius.input, background: t.color.raised, flexWrap: 'wrap' }}>
                  <Typography sx={{ fontSize: 13, fontWeight: 500, minWidth: 120 }}>{o ? `${Number(formatUnits(g.amount, o.decimals)).toLocaleString('en-US', { maximumFractionDigits: 6 })} ${o.ticker}` : `#${g.id}`}</Typography>
                  <Typography sx={{ fontSize: 12, color: t.color.textMuted, flex: 1 }}>{STATE[g.state]}{g.state === 0 ? ` · back to you from ${when(g.expiresAt)}` : ''}</Typography>
                  {g.state === 0 && now >= g.expiresAt && <Button onClick={() => void back(g)} sx={{ ...Lt, backdropFilter: 'none', height: 30, px: 1.5 }}>Take it back</Button>}
                </Box>) })}
              {wallet.account && sent.data && sent.data.length === 0 && <Typography sx={{ fontSize: 13, color: t.color.textMuted }}>None yet.</Typography>}
              {!wallet.account && <Typography sx={{ fontSize: 13, color: t.color.textMuted }}>Connect to see the gifts you sent.</Typography>}
            </Box>
            <Typography sx={{ fontSize: 12, color: t.color.textLabel, mt: 2.5 }}>The gift contract holds the gifts and nothing else: no owner, no admin, no fee. Verified, unaudited. <Box component="a" href={`https://robin.etherscan.io/address/${GIFT_ADDRESS}`} target="_blank" rel="noopener noreferrer" sx={{ color: t.color.text, display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>Contract <ExternalIcon size={11} /></Box></Typography>
          </Panel>
        </Box>
      </Page>
    </EarlyGate>
  )
}
