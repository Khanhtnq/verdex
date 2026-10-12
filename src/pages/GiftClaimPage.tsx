// Claim a gift from its link. The key in the link's fragment signs the receiver's address in this browser; the Verdex
// relay submits the claim and pays its gas, or the receiver sends it from their own wallet.
import { useMemo, useState } from 'react'
import { Avatar, Box, Button, Typography } from '@mui/material'
import { Link } from 'react-router-dom'
import { formatUnits } from 'viem'
import { t, z } from '../theme/tokens'
import { Bt, Lt } from '../theme/styles'
import { useAssets, useChains } from '../lib/api'
import { describeError, type ChainX } from '../lib/lifi'
import { USDG, stockTokens } from '../lib/pools'
import { claimByRelay, claimFromWallet, parseLink, useGift } from '../lib/gift'
import { resolveImg, TOKEN_LOGOS } from '../lib/img'
import { useWallet } from '../components/wallet/WalletProvider'
import { Page, Panel } from './common'

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
export default function GiftClaimPage() {
  const wallet = useWallet()
  const { data: chains } = useChains()
  const chain = chains?.find((c) => c.id === 4663) as ChainX | undefined
  const link = useMemo(() => parseLink(location.hash), [])
  const gift = useGift(link?.id)
  const assets = useAssets()
  const tok = useMemo(() => {
    const g = gift.data
    if (!g) return undefined
    if (g.token.toLowerCase() === USDG.address.toLowerCase()) return { ticker: 'USDG', name: 'Global Dollar', decimals: 6, logo: TOKEN_LOGOS.USDG }
    const s = assets.data ? stockTokens(assets.data.assets).find((x) => x.address.toLowerCase() === g.token.toLowerCase()) : undefined
    return s ? { ticker: s.ticker, name: s.name, decimals: s.decimals, logo: s.logo } : { ticker: short(g.token), name: 'Token', decimals: 18, logo: undefined }
  }, [gift.data, assets.data])
  const [state, setState] = useState<{ phase: 'idle' | 'busy' | 'done' | 'failed'; error?: string; relayFailed?: boolean }>({ phase: 'idle' })
  const g = gift.data
  const keyMatches = g && link ? g.key !== '0x0000000000000000000000000000000000000000' : false
  const claim = async (own: boolean) => {
    if (!link || !wallet.account) return
    setState({ phase: 'busy' })
    try {
      if (own) await claimFromWallet({ walletClient: wallet.walletClient!, account: wallet.account, chain, switchChain: wallet.switchChain, onPhase: () => {} }, link.id, link.key)
      else await claimByRelay(link.id, link.key, wallet.account.address)
      setState({ phase: 'done' }); void gift.refetch()
    } catch (e) { setState({ phase: 'failed', error: own ? describeError(e) : String((e as Error).message), relayFailed: !own }) }
  }
  return (
    <Page maxWidth={720}>
      <Panel sx={{ mt: { xs: 5, md: 9 }, p: { xs: 3, md: 5 }, textAlign: 'center' }}>
        <Typography sx={{ ...t.type.overline, color: t.color.mark }}>A gift for you</Typography>
        {!link ? <Typography sx={{ fontSize: 18, mt: 2 }}>This link is not complete. Ask the sender for the whole link.</Typography> : !g || !tok ? <Typography sx={{ fontSize: 15, color: t.color.textMuted, mt: 2 }}>{gift.isError ? 'This gift does not exist.' : 'Reading the gift…'}</Typography> : (
          <>
            <Avatar src={resolveImg(tok.logo)} sx={{ width: 72, height: 72, mx: 'auto', mt: 3, background: z.surface2 }}>{tok.ticker[0]}</Avatar>
            <Typography sx={{ fontSize: { xs: 32, md: 44 }, fontWeight: 500, mt: 2 }}>{Number(formatUnits(g.amount, tok.decimals)).toLocaleString('en-US', { maximumFractionDigits: 6 })} {tok.ticker}</Typography>
            <Typography sx={{ fontSize: 14, color: t.color.textMuted, mt: 1 }}>{tok.name} on Robinhood Chain, from {short(g.sender)}</Typography>
            {g.state === 1 && <Typography sx={{ fontSize: 16, mt: 3, color: t.color.mark }}>Claimed by {wallet.account && g.claimedBy.toLowerCase() === wallet.account.address.toLowerCase() ? 'you' : short(g.claimedBy)}. It is in that wallet now.</Typography>}
            {g.state === 2 && <Typography sx={{ fontSize: 16, mt: 3, color: t.color.textMuted }}>The sender took this gift back after it expired.</Typography>}
            {g.state === 0 && keyMatches && (
              <Box sx={{ mt: 3.5 }}>
                {!wallet.account ? <Button onClick={wallet.openWalletMenu} sx={{ ...Bt, height: 50, px: 4 }}>Connect a wallet to claim</Button> : (
                  <Box sx={{ display: 'grid', gap: 1.25, justifyItems: 'center' }}>
                    <Button disabled={state.phase === 'busy'} onClick={() => void claim(false)} sx={{ ...Bt, height: 50, px: 4 }}>{state.phase === 'busy' ? 'Claiming…' : `Claim to ${short(wallet.account.address)}`}</Button>
                    <Typography sx={{ fontSize: 12, color: t.color.textLabel }}>Verdex pays the gas. The claim is signed for this address only.</Typography>
                    {state.relayFailed && <Button onClick={() => void claim(true)} sx={{ ...Lt, height: 40, px: 2.5 }}>Claim with my own gas instead</Button>}
                  </Box>
                )}
                <Typography sx={{ fontSize: 12, color: t.color.textLabel, mt: 2 }}>Claimable until the sender takes it back, possible from {new Date(g.expiresAt * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}.</Typography>
              </Box>
            )}
            {state.phase === 'failed' && <Typography sx={{ fontSize: 12, color: t.color.red, mt: 1.5 }}>{state.error}</Typography>}
            {state.phase === 'done' && <Box sx={{ mt: 2.5, display: 'flex', gap: 1, justifyContent: 'center', flexWrap: 'wrap' }}><Button component={Link} to={`/assets/${tok.ticker}`} sx={{ ...Lt, height: 40, px: 2 }}>See {tok.ticker}</Button><Button component={Link} to="/gift" sx={{ ...Lt, height: 40, px: 2 }}>Send one yourself</Button></Box>}
          </>
        )}
      </Panel>
    </Page>
  )
}
