import { useEffect, useMemo, useState } from 'react'
import { Avatar, Box, Button, InputBase, Typography } from '@mui/material'
import { erc20Abi, encodeFunctionData, formatUnits, isAddress, maxUint256, parseUnits, type Address } from 'viem'
import { BRAND, fonts, t, z } from '../theme/tokens'
import { Bt } from '../theme/styles'
import { ArrowsUpDownIcon, ChevronDownIcon, ExternalIcon, SettingsIcon, WalletIcon } from '../components/icons'
import { useSearchParams } from 'react-router-dom'
import { VERDEX_FEE, VERDEX_TOKEN } from '../lib/autoInvest'
import { useHolding, useRefreshHolding } from '../lib/holding'
import { ARC, ROBINHOOD, chainLogo, useBaskets, useTokenLogo, useChains, type Chain, type Token } from '../lib/api'
import { chainMeta, describeError, fetchQuoteWithFee, fmtAmount, fmtDuration, isNative, quoteHasFee, readAllowance, readBalance, routeFeesUsd, useQuote, waitForTx as waitFor, type Quote } from '../lib/lifi'
import { TOKEN_LOGOS, resolveImg } from '../lib/img'
import { useWallet } from '../components/wallet/WalletProvider'
import { actions, useStore } from '../store'
import { TokenPicker } from './TokenPicker'

const USDG_RH: Token = { chainId: ROBINHOOD, address: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', symbol: 'USDG', name: 'Global Dollar', decimals: 6, logoURI: TOKEN_LOGOS.USDG }
const ETH_RH: Token = { chainId: ROBINHOOD, address: '0x0000000000000000000000000000000000000000', symbol: 'ETH', name: 'ETH', decimals: 18, logoURI: TOKEN_LOGOS.ETH }
const USDC_ARC: Token = { chainId: ARC, address: '0x3600000000000000000000000000000000000000', symbol: 'USDC', name: 'USD Coin', decimals: 6, logoURI: TOKEN_LOGOS.USDC }

type Side = { chain?: Chain; token?: Token }
type Phase = 'idle' | 'approving' | 'sending' | 'done' | 'failed'

const card = { background: t.color.raised, borderRadius: '12px', p: 2, display: 'flex', flexDirection: 'column', gap: 1.5 } as const

function TokenButton({ side, onClick, label }: { side: Side; onClick: () => void; label: string }) {
  const logoOf = useTokenLogo()
  return (
    <Button data-testid={`widget-${label}-token-button`} onClick={onClick} sx={{ height: 36, px: 1, gap: 1, borderRadius: '10px', background: t.color.chip, color: t.color.text, flexShrink: 0, '&:hover': { background: '#2A2A2A' } }}>
      <Box sx={{ position: 'relative', display: 'inline-flex' }}>
        <Avatar src={logoOf(side.token)} alt={side.token?.symbol ?? ''} sx={{ width: 24, height: 24, background: z.surface2, fontSize: 11 }}>
          {side.token?.symbol?.[0]}
        </Avatar>
        {side.chain && <Avatar src={chainLogo(side.chain)} alt={side.chain.name} sx={{ width: 12, height: 12, position: 'absolute', right: -3, bottom: -3, background: t.color.menu, border: `1px solid ${t.color.menu}` }} />}
      </Box>
      <Typography sx={{ fontSize: 14, fontWeight: 500, lineHeight: '18px' }}>{side.token?.symbol ?? 'Select'}</Typography>
      <ChevronDownIcon size={12} />
    </Button>
  )
}

export function SwapWidget() {
  const tab = useStore((s) => s.swapTab)
  const { data: chains } = useChains()
  const { account, openWalletMenu, switchChain, walletClient } = useWallet()
  const [from, setFrom] = useState<Side>({})
  const [to, setTo] = useState<Side>({})
  const [amount, setAmount] = useState('')
  const [picker, setPicker] = useState<'from' | 'to' | null>(null)
  const [slippage, setSlippage] = useState(0.5)
  const [showSettings, setShowSettings] = useState(false)
  const [recipient, setRecipient] = useState('')
  const [phase, setPhase] = useState<Phase>('idle')
  const [txHash, setTxHash] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [balance, setBalance] = useState<bigint | null>(null)

  // Defaults: swap on Robinhood Chain, bridge Robinhood → Arc.
  useEffect(() => {
    if (!chains) return
    const rh = chains.find((c) => c.id === ROBINHOOD)
    const arc = chains.find((c) => c.id === ARC)
    if (!from.chain && rh) setFrom({ chain: rh, token: ETH_RH })
    if (!to.chain) {
      if (tab === 'bridge' && arc) setTo({ chain: arc, token: USDC_ARC })
      else if (rh) setTo({ chain: rh, token: USDG_RH })
    }
  }, [chains, from.chain, to.chain, tab])

  useEffect(() => {
    if (!chains) return
    const rh = chains.find((c) => c.id === ROBINHOOD)
    const arc = chains.find((c) => c.id === ARC)
    if (tab === 'bridge' && arc && to.chain?.id === from.chain?.id) setTo({ chain: arc, token: USDC_ARC })
    if (tab !== 'bridge' && rh && from.chain?.id === ROBINHOOD && to.chain?.id !== ROBINHOOD) setTo({ chain: rh, token: USDG_RH })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  // Deep link from a basket card: /?buy=SYMBOL preselects the basket token on its chain.
  const [params] = useSearchParams()
  const buy = params.get('buy')
  const { data: baskets } = useBaskets()
  const buyBasket = useMemo(() => (buy ? baskets?.baskets.find((x) => x.symbol.toLowerCase() === buy.toLowerCase()) : undefined), [buy, baskets])
  useEffect(() => {
    if (!buy || !chains) return
    // /?buy=0xTOKEN&chain=ID&sym=TICKER&dec=18 preselects a tokenized stock, paid with the chain's stablecoin.
    if (isAddress(buy)) {
      const id = Number(params.get('chain') ?? ROBINHOOD)
      const chain = chains.find((c) => c.id === id)
      if (!chain) return
      const quote: Token = id === ROBINHOOD ? USDG_RH : { chainId: 8453, address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', symbol: 'USDC', name: 'USD Coin', decimals: 6, logoURI: TOKEN_LOGOS.USDC }
      setFrom({ chain, token: quote })
      setTo({ chain, token: { chainId: id, address: buy, symbol: params.get('sym') ?? 'Stock', name: params.get('sym') ?? 'Stock', decimals: Number(params.get('dec') ?? 18) } })
      actions.setSwapTab('swap')
      return
    }
    if (buy.toUpperCase() === 'VERDEX') {
      const rh = chains.find((c) => c.id === ROBINHOOD)
      if (!rh) return
      setFrom({ chain: rh, token: ETH_RH })
      setTo({ chain: rh, token: { chainId: rh.id, address: VERDEX_TOKEN.address, symbol: VERDEX_TOKEN.symbol, name: 'Verdex', decimals: VERDEX_TOKEN.decimals } })
      actions.setSwapTab('swap')
      return
    }
    if (!baskets) return
    const b = baskets.baskets.find((x) => x.symbol.toLowerCase() === buy.toLowerCase())
    const chain = b && chains.find((c) => c.id === b.chainId)
    if (!b || !chain) return
    const native = chain.nativeToken
    setFrom({ chain, token: { chainId: chain.id, address: '0x0000000000000000000000000000000000000000', symbol: native?.symbol ?? 'ETH', name: native?.symbol ?? 'ETH', decimals: native?.decimals ?? 18, logoURI: TOKEN_LOGOS[(native?.symbol ?? 'ETH') as keyof typeof TOKEN_LOGOS] ?? chain.logoURI } })
    setTo({ chain, token: { chainId: b.chainId, address: b.address, symbol: b.symbol, name: b.name, decimals: 18, logoURI: b.icon } })
    actions.setSwapTab('swap')
  }, [buy, chains, baskets, params])

  useEffect(() => {
    let alive = true
    setBalance(null)
    if (!account || !from.chain || !from.token) return
    readBalance(from.chain, from.token.address, account.address)
      .then((b) => alive && setBalance(b))
      .catch(() => alive && setBalance(null))
    return () => {
      alive = false
    }
  }, [account, from.chain, from.token, txHash])

  const toAddress = tab === 'private' && isAddress(recipient) ? recipient : undefined
  // Wallets holding VERDEX pay no Verdex fee; everyone else carries it on the quote. Until the balance
  // is known the fee stays on, so a holder only ever sees the fee disappear, never appear.
  const holding = useHolding(account?.address)
  const holder = !!holding.data?.holder
  const fee = holder || !(VERDEX_FEE > 0) ? undefined : VERDEX_FEE
  const refreshHolding = useRefreshHolding()
  const quote = useQuote({ fromChain: from.chain?.id, toChain: to.chain?.id, fromToken: from.token, toToken: to.token, amount, fromAddress: account?.address, toAddress, slippage: slippage / 100, fee })
  const q = quote.data
  const fromUsd = useMemo(() => (q?.estimate.fromAmountUSD ? Number(q.estimate.fromAmountUSD) : from.token?.priceUSD && Number(amount) > 0 ? Number(from.token.priceUSD) * Number(amount) : 0), [q, from.token, amount])
  const toUsd = q?.estimate.toAmountUSD ? Number(q.estimate.toAmountUSD) : 0

  const buyVerdex = () => {
    const rh = chains?.find((c) => c.id === ROBINHOOD)
    if (!rh) return
    setFrom({ chain: rh, token: ETH_RH })
    setTo({ chain: rh, token: { chainId: rh.id, address: VERDEX_TOKEN.address, symbol: VERDEX_TOKEN.symbol, name: 'Verdex', decimals: VERDEX_TOKEN.decimals } })
    actions.setSwapTab('swap')
  }

  const flip = () => {
    setFrom(to)
    setTo(from)
    setAmount('')
  }

  const selectToken = (chain: Chain, token: Token) => {
    if (picker === 'from') setFrom({ chain, token })
    else setTo({ chain, token })
    setPicker(null)
  }

  const needsChainSwitch = !!account && !!from.chain && account.chainId !== from.chain.id
  const insufficient = balance != null && from.token && Number(amount) > 0 && (() => {
    try {
      return balance < parseUnits(amount as `${number}`, from.token!.decimals)
    } catch {
      return false
    }
  })()

  const execute = async () => {
    if (!account || !walletClient || !from.chain || !from.token || !q) return
    setError(null)
    setTxHash(null)
    try {
      const fresh = await fetchQuoteWithFee({ fromChain: from.chain.id, toChain: to.chain!.id, fromToken: from.token.address, toToken: to.token!.address, fromAmount: q.action.fromAmount, fromAddress: account.address, toAddress, slippage: slippage / 100 }, fee)
      const tx = fresh.transactionRequest
      if (!tx) throw new Error('This route cannot be prepared right now. Try another amount or route.')
      if (!isNative(from.token.address)) {
        const allowance = await readAllowance(from.chain, from.token.address as Address, account.address, fresh.estimate.approvalAddress as Address)
        if (allowance < BigInt(fresh.action.fromAmount)) {
          setPhase('approving')
          const approveHash = await walletClient.sendTransaction({ account: account.address, chain: null, to: from.token.address as Address, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [fresh.estimate.approvalAddress as Address, maxUint256] }) })
          await waitFor(from.chain, approveHash)
        }
      }
      setPhase('sending')
      const hash = await walletClient.sendTransaction({ account: account.address, chain: null, to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : undefined, gas: tx.gasLimit ? BigInt(tx.gasLimit) : undefined })
      setTxHash(hash)
      await waitFor(from.chain, hash)
      setPhase('done')
      refreshHolding(account.address)
    } catch (e) {
      setPhase('failed')
      setError(describeError(e))
    }
  }

  const primary = (() => {
    if (!account) return { label: 'Connect', onClick: openWalletMenu, disabled: false }
    if (!from.token || !to.token) return { label: 'Select tokens', onClick: () => setPicker('from'), disabled: true }
    if (!(Number(amount) > 0)) return { label: 'Enter an amount', onClick: () => {}, disabled: true }
    if (tab === 'private' && !toAddress) return { label: 'Enter a receiving address', onClick: () => {}, disabled: true }
    if (needsChainSwitch) return { label: `Switch to ${from.chain!.name}`, onClick: () => switchChain(from.chain!.id, chainMeta(from.chain!)).catch((e) => setError(describeError(e))), disabled: false }
    if (insufficient) return { label: `Insufficient ${from.token.symbol}`, onClick: () => {}, disabled: true }
    if (quote.isFetching && !q) return { label: 'Finding the best route…', onClick: () => {}, disabled: true }
    if (quote.error) return { label: 'No route found', onClick: () => quote.refetch(), disabled: false }
    if (phase === 'approving') return { label: 'Approving…', onClick: () => {}, disabled: true }
    if (phase === 'sending') return { label: 'Confirm in wallet…', onClick: () => {}, disabled: true }
    return { label: tab === 'bridge' || from.chain?.id !== to.chain?.id ? 'Bridge' : 'Swap', onClick: execute, disabled: false }
  })()

  const explorer = from.chain?.id === ROBINHOOD ? 'https://robin.etherscan.io' : from.chain?.id === 8453 ? 'https://basescan.org' : from.chain?.id === 1 ? 'https://etherscan.io' : undefined

  return (
    <Box id="verdex-swap-widget" sx={{ position: 'relative', boxSizing: 'content-box', width: '100%', minWidth: { xs: 0, sm: 416 }, maxWidth: 416, background: t.color.panel, borderRadius: t.radius.card, zIndex: 1, fontFamily: fonts.sans }}>
      <Box sx={{ display: 'flex', alignItems: 'center', px: 3, pt: 2.5, pb: 1 }}>
        <Box role="tablist" aria-label="tabs" sx={{ display: 'flex', gap: 0.5 }}>
          {(['swap', 'bridge', 'private'] as const).map((k) => (
            <Box key={k} role="tab" component="button" aria-selected={tab === k} onClick={() => actions.setSwapTab(k)} sx={{ all: 'unset', cursor: 'pointer', px: 1.5, height: 40, borderRadius: '12px', fontSize: 14, fontWeight: 500, color: tab === k ? t.color.text : t.color.textMuted, background: tab === k ? t.color.active : 'transparent', transition: `background ${t.motion.fast}` }}>
              {k[0].toUpperCase() + k.slice(1)}
            </Box>
          ))}
        </Box>
        <Box component="button" aria-label="Settings" onClick={() => setShowSettings((v) => !v)} sx={{ all: 'unset', cursor: 'pointer', ml: 'auto', mr: -1, width: 40, height: 40, display: 'grid', placeItems: 'center', borderRadius: '50%', color: t.color.text, '&:hover': { background: t.color.hover } }}>
          <SettingsIcon size={20} />
        </Box>
      </Box>
      {showSettings && (
        <Box sx={{ mx: 3, mb: 1.5, p: 1.5, borderRadius: '12px', background: t.color.raised, display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography sx={{ fontSize: 13, color: t.color.textMuted, flex: 1 }}>Max slippage</Typography>
          {[0.1, 0.5, 1].map((s) => (
            <Box key={s} component="button" onClick={() => setSlippage(s)} sx={{ all: 'unset', cursor: 'pointer', px: 1.25, py: 0.5, borderRadius: '8px', fontSize: 12, fontWeight: 500, color: slippage === s ? t.color.onAccent : t.color.text, background: slippage === s ? t.color.accent : 'rgba(255,255,255,.06)' }}>
              {s}%
            </Box>
          ))}
        </Box>
      )}
      <Box sx={{ px: 3, pb: 3, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        <Box sx={{ display: 'flex', flexDirection: 'column', position: 'relative', gap: 0.5 }}>
          <Box sx={card}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', height: 16 }}>
              <Typography sx={{ fontSize: 14, lineHeight: 1, fontWeight: 500 }}>Send</Typography>
              {account && balance != null && from.token && (
                <Box component="button" onClick={() => setAmount(formatUnits(balance, from.token!.decimals))} sx={{ all: 'unset', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 0.5, fontSize: 12, color: t.color.textMuted, '&:hover': { color: t.color.text } }}>
                  <WalletIcon size={12} /> {fmtAmount(balance.toString(), from.token.decimals)} · Max
                </Box>
              )}
            </Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <InputBase name="fromAmount" inputMode="decimal" placeholder="0" inputProps={{ 'aria-label': 'Amount to send' }} value={amount} onChange={(e) => /^\d*\.?\d*$/.test(e.target.value) && setAmount(e.target.value)} sx={{ flex: 1, minWidth: 0, fontSize: 30, fontWeight: 500, lineHeight: 1.4, height: 32, color: t.color.text, '& input': { p: 0, height: 32 }, '& input::placeholder': { color: t.color.text, opacity: 0.5 } }} />
              <TokenButton side={from} label="from" onClick={() => setPicker('from')} />
            </Box>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', height: 16 }}>
              <Typography sx={{ fontSize: 12, fontWeight: 500, lineHeight: 1, color: t.color.textSecondary }}>${fromUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })}</Typography>
              {from.chain && <Typography sx={{ fontSize: 12, color: t.color.textLabel }}>on {from.chain.name}</Typography>}
            </Box>
          </Box>
          <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', my: -1.5, zIndex: 2, position: 'relative' }}>
            <Box component="button" aria-label="Swap" data-testid="widget-swap-tokens-button" onClick={flip} sx={{ all: 'unset', cursor: 'pointer', width: 32, height: 32, display: 'grid', placeItems: 'center', borderRadius: '10px', background: t.color.chip, border: `2px solid ${t.color.panel}`, color: t.color.text, '&:hover': { background: t.color.chip } }}>
              <ArrowsUpDownIcon size={16} />
            </Box>
          </Box>
          <Box sx={card}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', height: 16 }}>
              <Typography sx={{ fontSize: 14, lineHeight: 1, fontWeight: 500 }}>Receive</Typography>
              {q && <Typography sx={{ fontSize: 12, color: t.color.textLabel }}>{fmtDuration(q.estimate.executionDuration)}</Typography>}
            </Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <Typography sx={{ fontSize: 30, fontWeight: 500, lineHeight: 1.4, height: 32, display: 'flex', alignItems: 'center', flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', opacity: q ? 1 : 0.5 }}>{q && to.token ? fmtAmount(q.estimate.toAmount, to.token.decimals) : quote.isFetching ? '…' : '0'}</Typography>
              <TokenButton side={to} label="to" onClick={() => setPicker('to')} />
            </Box>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', height: 16 }}>
              <Typography sx={{ fontSize: 12, fontWeight: 500, lineHeight: 1, color: t.color.textSecondary }}>${toUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })}</Typography>
              {to.chain && <Typography sx={{ fontSize: 12, color: t.color.textLabel }}>on {to.chain.name}</Typography>}
            </Box>
          </Box>
        </Box>
        {tab === 'private' && (
          <Box sx={{ ...card, gap: 1 }}>
            <Typography sx={{ fontSize: 14, lineHeight: 1, fontWeight: 500 }}>Receiving address</Typography>
            <InputBase inputProps={{ 'aria-label': 'Receiving address' }} placeholder="0x… a separate address you control" value={recipient} onChange={(e) => setRecipient(e.target.value.trim())} sx={{ fontSize: 14, fontFamily: fonts.code, color: t.color.text, '& input::placeholder': { color: t.color.textLabel, opacity: 1 } }} />
            <Typography sx={{ fontSize: 12, color: t.color.textLabel, lineHeight: 1.4 }}>Funds are routed through partner liquidity and settle at the receiving address. Allow 15–45 minutes for cross-chain routes.</Typography>
          </Box>
        )}
        {q && <RouteSummary q={q} holder={holder} known={!!account && !!holding.data} onBuyVerdex={buyVerdex} />}
        {quote.error && Number(amount) > 0 && <Typography sx={{ fontSize: 12, color: t.color.red, lineHeight: 1.4 }}>{(quote.error as Error).message}</Typography>}
        {quote.error && buyBasket && to.token?.address === buyBasket.address && (
          <Box sx={{ ...card, gap: 1 }}>
            <Typography sx={{ fontSize: 13, color: t.color.textSoft, lineHeight: 1.4 }}>Index baskets are minted from their underlying stocks, so DEX routes are often too thin. Mint {buyBasket.symbol} directly on Reserve instead.</Typography>
            <Box component="a" href={`https://app.reserve.org/${buyBasket.chainId === 56 ? 'bnb' : buyBasket.chainId === 8453 ? 'base' : 'ethereum'}/index-dtf/${buyBasket.address}/overview`} target="_blank" rel="noopener noreferrer" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, fontSize: 13, fontWeight: 500, color: t.color.text, textDecoration: 'none', '&:hover': { color: t.color.green } }}>
              Mint on Reserve <ExternalIcon size={12} />
            </Box>
          </Box>
        )}
        {error && <Typography sx={{ fontSize: 12, color: t.color.red, lineHeight: 1.4 }}>{error}</Typography>}
        {txHash && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, fontSize: 12, color: phase === 'done' ? t.color.green : t.color.textMuted }}>
            {phase === 'done' ? 'Transfer confirmed.' : 'Transaction submitted, waiting for confirmation…'}
            {explorer && (
              <Box component="a" href={`${explorer}/tx/${txHash}`} target="_blank" rel="noopener noreferrer" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, color: t.color.text, textDecoration: 'none', '&:hover': { color: t.color.accent } }}>
                View <ExternalIcon size={12} />
              </Box>
            )}
          </Box>
        )}
        <Button data-testid="widget-transaction-button" fullWidth disabled={primary.disabled} onClick={primary.onClick} sx={{ ...Bt, height: 48, mt: 0.5 }}>
          {primary.label}
        </Button>
        <Typography sx={{ fontSize: 11, color: t.color.textLabel, textAlign: 'center', lineHeight: 1.4 }}>Routes are priced live across DEXs, bridges and solvers. Non-custodial: every transaction is signed in your own wallet.</Typography>
      </Box>
      <TokenPicker open={!!picker} onClose={() => setPicker(null)} chainId={picker === 'from' ? from.chain?.id : to.chain?.id} onSelect={selectToken} />
    </Box>
  )
}

function RouteSummary({ q, holder, known, onBuyVerdex }: { q: Quote; holder: boolean; known: boolean; onBuyVerdex: () => void }) {
  const gas = q.estimate.gasCosts?.reduce((s, g) => s + Number(g.amountUSD || 0), 0) ?? 0
  const feePct = `${(VERDEX_FEE * 100).toFixed(2)}%`
  const charged = quoteHasFee(q)
  const feeUsd = charged && q.estimate.fromAmountUSD ? Number(q.estimate.fromAmountUSD) * VERDEX_FEE : 0
  const showsVerdex = q.action.toToken.address.toLowerCase() === VERDEX_TOKEN.address.toLowerCase()
  const routeFees = routeFeesUsd(q)
  // LI.FI lists its integrator fee as a step; it is a fee, not a venue, so it is left out of the route.
  const all = q.includedSteps?.length ? q.includedSteps : [{ tool: q.tool, toolDetails: q.toolDetails, type: q.type }]
  const steps = all.filter((s) => s.tool !== 'feeCollection' && !/integrator fee/i.test(s.toolDetails.name))
  return (
    <Box sx={{ borderRadius: '12px', background: t.color.raised, p: 1.5, display: 'grid', gap: 0.75, fontSize: 12 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography sx={{ fontSize: 12, color: t.color.textMuted, flex: 1 }}>Route</Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
          {steps.map((s, i) => (
            <Box key={i} sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, px: 1, py: 0.25, borderRadius: '6px', background: 'rgba(255,255,255,.06)', fontWeight: 500 }}>
              <Avatar src={resolveImg(s.toolDetails.logoURI)} sx={{ width: 14, height: 14, background: z.surface2 }} />
              {s.toolDetails.name}
            </Box>
          ))}
        </Box>
      </Box>
      <Row label="Minimum received" value={`${fmtAmount(q.estimate.toAmountMin, q.action.toToken.decimals)} ${q.action.toToken.symbol}`} />
      {VERDEX_FEE > 0 && known && holder && (
        <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 2 }} data-testid="verdex-fee-holder">
          <Typography sx={{ fontSize: 12, color: t.color.textMuted }}>{BRAND.name} fee</Typography>
          <Typography sx={{ fontSize: 12, fontWeight: 500 }}>
            <Box component="s" sx={{ color: t.color.textLabel, mr: 0.75 }}>{feePct}</Box>0 · VERDEX holder
          </Typography>
        </Box>
      )}
      {VERDEX_FEE > 0 && !holder && charged && <Row label={`${BRAND.name} fee`} value={feeUsd ? `${feePct} · $${feeUsd.toFixed(2)}` : feePct} />}
      {routeFees >= 0.005 && <Row label="Route fees" value={`$${routeFees.toFixed(2)}`} />}
      <Row label="Network fee" value={gas ? `$${gas.toFixed(2)}` : '-'} />
      <Row label="Estimated time" value={fmtDuration(q.estimate.executionDuration)} />
      {VERDEX_FEE > 0 && !holder && !showsVerdex && (
        <Box component="button" type="button" onClick={onBuyVerdex} sx={{ all: 'unset', cursor: 'pointer', mt: 0.5, pt: 1, borderTop: `1px solid ${t.color.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1.5, fontSize: 12, color: t.color.textMuted, '&:hover': { color: t.color.text } }}>
          <span>Hold any VERDEX and the {BRAND.name} fee is 0 on every trade.</span>
          <Box component="span" sx={{ color: t.color.mark, fontWeight: 500, whiteSpace: 'nowrap' }}>Get VERDEX</Box>
        </Box>
      )}
    </Box>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 2 }}>
      <Typography sx={{ fontSize: 12, color: t.color.textMuted }}>{label}</Typography>
      <Typography sx={{ fontSize: 12, fontWeight: 500 }}>{value}</Typography>
    </Box>
  )
}
