// Yield on idle USDG: the USDG sitting in a wallet, supplied in one tap to the Verdex Lend market paying the most,
// withdrawable any time the market has it available. Rates float with each market's use; nothing is promised.
import { useMemo, useState } from 'react'
import { Avatar, Box, Button, InputBase, Typography } from '@mui/material'
import { useQueryClient } from '@tanstack/react-query'
import { parseUnits } from 'viem'
import { t, z } from '../theme/tokens'
import { Bt, Lt, Vg } from '../theme/styles'
import { useAssets, useChains } from '../lib/api'
import { describeError, type ChainX } from '../lib/lifi'
import { PHASE_LABEL, USDG, usePools, type Phase } from '../lib/pools'
import { LEND, fmtUsdg, supplyLoan, tokenState, useLendWallet, useMarkets, withdrawLoan, type Market } from '../lib/lend'
import { resolveImg } from '../lib/img'
import { useWallet } from '../components/wallet/WalletProvider'
import { EarlyGate } from '../components/EarlyGate'
import { ExternalIcon } from '../components/icons'
import { Page, PageHero, Panel } from './common'

type Tx = { phase: Phase; error?: string }
const room = (m: Market) => (m.supplyCap > m.totalSupplyAssets ? m.supplyCap - m.totalSupplyAssets : 0n)

export default function IdlePage() {
  const wallet = useWallet()
  const me = wallet.account?.address
  const { data: chains } = useChains()
  const chain = chains?.find((c) => c.id === 4663) as ChainX | undefined
  const assets = useAssets()
  const pools = usePools(assets.data?.assets)
  const markets = useMarkets(assets.data?.assets, pools.data)
  const usdgMarkets = useMemo(() => (markets.data ?? []).filter((m) => m.enabled && m.loan.toLowerCase() === USDG.address.toLowerCase()).sort((a, b) => b.supplyApr - a.supplyApr), [markets.data])
  const best = usdgMarkets.find((m) => room(m) > 0n)
  const lw = useLendWallet(me, markets.data)
  const bal = tokenState(lw.data, USDG.address)
  const [keep, setKeep] = useState('0')
  const keepRaw = Number(keep) > 0 ? parseUnits(Number(keep).toFixed(6), 6) : 0n
  let put = bal.balance > keepRaw ? bal.balance - keepRaw : 0n
  if (best && put > room(best)) put = room(best)
  const [tx, setTx] = useState<Tx>({ phase: 'idle' })
  const busy = tx.phase !== 'idle' && tx.phase !== 'done' && tx.phase !== 'failed'
  const qc = useQueryClient()
  const ctx = (set: (p: Phase) => void) => ({ walletClient: wallet.walletClient!, account: wallet.account!, chain, switchChain: wallet.switchChain, onPhase: set })
  const go = async () => {
    if (!best || put === 0n) return
    setTx({ phase: 'switching' })
    try { await supplyLoan(ctx((p) => setTx({ phase: p })), best, put, bal.allowance); setTx({ phase: 'done' }); void qc.invalidateQueries({ queryKey: ['lend-wallet'] }) } catch (e) { setTx({ phase: 'failed', error: describeError(e) }) }
  }
  const out = async (m: Market) => { try { await withdrawLoan(ctx(() => {}), m, lw.data!.positions[m.id.toString()].supplyShares); void qc.invalidateQueries({ queryKey: ['lend-wallet'] }) } catch { /* the wallet shows it */ } }
  const working = usdgMarkets.filter((m) => (lw.data?.positions[m.id.toString()]?.supplied ?? 0n) > 0n)
  const row = { display: 'flex', alignItems: 'center', gap: 1.5, p: 1.25, borderRadius: t.radius.input, background: t.color.raised, flexWrap: 'wrap' } as const
  return (
    <EarlyGate path="/earn/idle">
      <Page>
        <PageHero label="Yield on idle USDG" badges={<Box sx={{ ...Vg, ml: 0, background: 'rgba(194,234,138,.16)', color: t.color.mark }}>New</Box>}
          title={<>Idle USDG,<br />put to work.</>}
          lead="The USDG waiting in your wallet between trades can earn while it waits. One tap supplies it to the Verdex Lend market paying lenders the most right now, where borrowers pay interest against their stocks. Take it back whenever the market has it available. The rate moves with how much is borrowed; it is never fixed and never promised." />
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0,1fr)', md: 'minmax(0,1fr) minmax(0,1fr)' }, gap: 2.5, mt: 4, alignItems: 'start' }}>
          <Panel sx={{ p: { xs: 2.5, md: 3 } }}>
            <Typography sx={{ ...t.type.overline, color: t.color.textLabel }}>Idle in your wallet</Typography>
            <Typography sx={{ fontSize: 36, mt: 0.5 }}>{me ? fmtUsdg(bal.balance) : '–'}</Typography>
            <Typography sx={{ ...t.type.overline, color: t.color.textLabel, mt: 2.5, mb: 1 }}>Keep this much in the wallet</Typography>
            <InputBase value={keep} onChange={(e) => setKeep(e.target.value.replace(/[^0-9.]/g, ''))} inputProps={{ 'aria-label': 'Keep', inputMode: 'decimal' }} sx={{ width: '100%', height: 48, px: 1.5, borderRadius: t.radius.input, background: t.color.hover, fontSize: 20 }} />
            <Typography sx={{ fontSize: 12, color: t.color.textLabel, mt: 1.5 }}>{best ? `Best now: the ${best.stock?.ticker ?? best.collateralSymbol} market, ${best.supplyApr.toFixed(2)}% a year to lenders at today's use, room for ${fmtUsdg(room(best))}.` : markets.data ? 'Every USDG market is full right now.' : 'Reading the markets…'}</Typography>
            <Button fullWidth disabled={!!me && (busy || put === 0n || !best)} onClick={() => (me ? void go() : wallet.openWalletMenu())} sx={{ ...Bt, height: 48, mt: 2.5 }}>{!me ? 'Connect wallet' : busy ? PHASE_LABEL[tx.phase] : `Put ${fmtUsdg(put)} to work`}</Button>
            {tx.phase === 'failed' && <Typography sx={{ fontSize: 12, color: t.color.red, mt: 1 }}>{tx.error}</Typography>}
            {tx.phase === 'done' && <Typography sx={{ fontSize: 12, color: t.color.mark, mt: 1 }}>Supplied. It earns from the next block.</Typography>}
            {working.length > 0 && <Box sx={{ display: 'grid', gap: 0.75, mt: 2.5 }}>
              {working.map((m) => <Box key={m.id.toString()} sx={row}><Typography sx={{ fontSize: 13, flex: 1 }}>{fmtUsdg(lw.data!.positions[m.id.toString()].supplied)} in {m.stock?.ticker ?? m.collateralSymbol} · {m.supplyApr.toFixed(2)}%</Typography><Button onClick={() => void out(m)} sx={{ ...Lt, backdropFilter: 'none', height: 30, px: 1.5 }}>Take it back</Button></Box>)}
            </Box>}
          </Panel>
          <Panel sx={{ p: { xs: 2.5, md: 3 } }}>
            <Typography sx={{ fontSize: 16, fontWeight: 500 }}>USDG markets, best first</Typography>
            <Box sx={{ display: 'grid', gap: 0.75, mt: 2 }}>
              {usdgMarkets.map((m) => <Box key={m.id.toString()} sx={row}>
                <Avatar src={resolveImg(m.stock?.logo)} sx={{ width: 20, height: 20, background: z.surface2, fontSize: 9 }}>{(m.stock?.ticker ?? '?')[0]}</Avatar>
                <Typography sx={{ fontSize: 13, fontWeight: 500, minWidth: 70 }}>{m.stock?.ticker ?? m.collateralSymbol}</Typography>
                <Typography sx={{ fontSize: 12, color: t.color.textMuted, flex: 1 }}>{m.supplyApr.toFixed(2)}% to lenders · {m.utilisation.toFixed(0)}% borrowed · {fmtUsdg(m.totalSupplyAssets, 0)} supplied of {fmtUsdg(m.supplyCap, 0)}</Typography>
              </Box>)}
            </Box>
            <Typography sx={{ fontSize: 12, color: t.color.textLabel, mt: 2.5 }}>Supplied USDG is lent to borrowers who lock stocks worth more than they borrow, and liquidated if that cushion runs out. If many lenders leave at once, some USDG may only come back as loans are repaid. Verified, unaudited. <Box component="a" href={`https://robin.etherscan.io/address/${LEND}`} target="_blank" rel="noopener noreferrer" sx={{ color: t.color.text, display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>Contract <ExternalIcon size={11} /></Box></Typography>
          </Panel>
        </Box>
      </Page>
    </EarlyGate>
  )
}
