// Verdex on Solana: baskets of xStocks (Backed's tokenized shares) bought and sold through Jupiter, leg by leg,
// signed in one prompt. No Verdex program and no index token on Solana yet: the stocks themselves land in the
// wallet, one per leg, and the page tracks the basket from those balances. The fee, when a Solana fee wallet is
// configured, is 0.25% of the USDC side, moved in the first leg's transaction.
import { useQuery } from '@tanstack/react-query'
import { Connection, PublicKey } from '@solana/web3.js'
import type { Asset } from './api'
import { USDC_MINT, buildLegTxs, jupPrices, quoteBuyLegs, quoteSellLegs, readTokenBalances, sendAll, type Leg } from './sol/tx'
import { signAll } from './sol/wallet'

export const SOLANA_CHAIN_ID = 1151111081099710 // LI.FI's id for Solana in the asset list
const env = (k: string) => String((import.meta.env as Record<string, string | undefined>)[k] ?? '').trim()
export const SOL_RPCS = (env('VITE_SOLANA_RPC') ? [env('VITE_SOLANA_RPC')] : []).concat(['https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com'])
export const FEE_WALLET = env('VITE_SOLANA_FEE_WALLET')
export const FEE_BPS = 25
export const SLIPPAGE_BPS = 100
export const MAX_IMPACT_PCT = 1 // a leg whose quote moves the pool more than this is refused
export const MIN_LIQUIDITY_USD = 100_000
const conns = new Map<string, Connection>()
export const connectionFor = (url: string) => { let c = conns.get(url); if (!c) { c = new Connection(url, { commitment: 'confirmed' }); conns.set(url, c) } return c }
export const connection = () => connectionFor(SOL_RPCS[0])
// Reads try every RPC in turn; the public ones block or rate-limit different methods.
export async function withRpcs<T>(fn: (c: Connection) => Promise<T>): Promise<T> {
  let last: unknown
  for (const url of SOL_RPCS) { try { return await fn(connectionFor(url)) } catch (e) { last = e } }
  throw last
}
export const feeWallet = (): PublicKey | undefined => { try { return FEE_WALLET ? new PublicKey(FEE_WALLET) : undefined } catch { return undefined } }

export type SolStock = { mint: string; symbol: string; ticker: string; name: string; decimals: number; logo?: string }
export type Basket = { symbol: string; name: string; blurb: string; tickers: string[] }
// Only stocks with a deep enough market on Solana today (the chips beyond NVDA and RDDT are thin or unpriced there).
export const BASKETS: Basket[] = [
  { name: 'Verdex Magnificent Seven', symbol: 'VX7', tickers: ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA'], blurb: 'The seven, equal weight.' },
  { name: 'Verdex AI Infrastructure', symbol: 'VXAI', tickers: ['NVDA', 'MSFT', 'GOOGL', 'AMZN', 'META'], blurb: 'The chip and the clouds that rent it.' },
  { name: 'Verdex Frontier', symbol: 'VXFRONT', tickers: ['SPCX', 'CRCL', 'MSTR', 'PLTR'], blurb: 'SpaceX, Circle, Strategy, Palantir.' },
  { name: 'Verdex Index Funds', symbol: 'VXETF', tickers: ['SPY', 'QQQ'], blurb: 'The S&P 500 and the Nasdaq 100, half each.' },
]
// The xStocks on Solana, from the asset list the site already has.
export function solStocks(assets: Asset[]): SolStock[] {
  const out: SolStock[] = []
  const seen = new Set<string>()
  for (const a of assets) for (const tk of a.tokens) {
    if (tk.chainId !== SOLANA_CHAIN_ID || tk.issuer !== 'xStocks' || seen.has(tk.address)) continue
    seen.add(tk.address)
    out.push({ mint: tk.address, symbol: tk.symbol, ticker: a.ticker, name: a.name, decimals: tk.decimals, logo: a.logo })
  }
  return out
}
export type BasketLeg = { stock: SolStock; priceUsd: number; liquidityUsd: number; held: bigint; heldUsd: number; weight: number }
export type BasketInfo = Basket & { legs: BasketLeg[]; missing: string[]; tradable: boolean; heldUsd: number; perShareUsd: number }
export async function readPrices(stocks: SolStock[]) { return jupPrices(stocks.map((s) => s.mint)) }
export function usePrices(stocks: SolStock[]) {
  return useQuery({ queryKey: ['sol-prices', stocks.length], queryFn: () => readPrices(stocks), enabled: stocks.length > 0, staleTime: 30_000, refetchInterval: 60_000, retry: 1 })
}
export type SolWalletState = { usdc: bigint; balances: Record<string, bigint> }
export async function readSolWallet(owner: PublicKey, stocks: SolStock[]): Promise<SolWalletState> {
  const b = await withRpcs((c) => readTokenBalances(c, owner, [{ mint: USDC_MINT, program2022: false }, ...stocks.map((s) => ({ mint: s.mint, program2022: true }))]))
  return { usdc: b[USDC_MINT] ?? 0n, balances: b }
}
export function useSolWalletState(owner: PublicKey | undefined, stocks: SolStock[]) {
  return useQuery({ queryKey: ['sol-wallet', owner?.toBase58(), stocks.length], queryFn: () => readSolWallet(owner!, stocks), enabled: !!owner && stocks.length > 0, staleTime: 10_000, retry: 1 })
}
// The baskets at today's prices, with what the wallet holds of each leg.
export function baskets(stocks: SolStock[], prices: Record<string, { usdPrice: number; liquidity: number }> | undefined, wallet: SolWalletState | undefined): BasketInfo[] {
  return BASKETS.map((b) => {
    const legs: BasketLeg[] = []
    const missing: string[] = []
    for (const ticker of b.tickers) {
      const stock = stocks.find((s) => s.ticker === ticker)
      const p = stock ? prices?.[stock.mint] : undefined
      if (!stock || !p || p.usdPrice <= 0) { missing.push(ticker); continue }
      const held = wallet?.balances[stock.mint] ?? 0n
      legs.push({ stock, priceUsd: p.usdPrice, liquidityUsd: p.liquidity, held, heldUsd: (Number(held) / 10 ** stock.decimals) * p.usdPrice, weight: 1 / b.tickers.length })
    }
    const heldUsd = legs.reduce((s, l) => s + l.heldUsd, 0)
    return { ...b, legs, missing, tradable: missing.length === 0 && legs.every((l) => l.liquidityUsd >= MIN_LIQUIDITY_USD), heldUsd, perShareUsd: 1 }
  })
}
export const feeFor = (usdc: bigint) => (feeWallet() ? (usdc * BigInt(FEE_BPS)) / 10_000n : 0n)

export type TradePhase = 'idle' | 'quoting' | 'building' | 'signing' | 'sending' | 'done' | 'failed'
export const TRADE_LABEL: Record<TradePhase, string> = { idle: '', quoting: 'Asking Jupiter for every leg…', building: 'Building the transactions…', signing: 'Sign once in your wallet…', sending: 'Sending leg by leg…', done: 'Done', failed: 'Failed' }
export type Progress = { phase: TradePhase; sent: number; total: number; sigs: string[] }
const impactOk = (legs: Leg[]) => { const bad = legs.find((l) => Number(l.quote.priceImpactPct) * 100 > MAX_IMPACT_PCT); if (bad) throw new Error(`${bad.symbol}: this size would move its pool ${(Number(bad.quote.priceImpactPct) * 100).toFixed(2)}%. Try a smaller amount.`) }

// Buy a basket: an equal slice of USDC per stock, quoted, built, signed once, sent in order. If a later leg fails,
// the earlier ones have already landed; the page shows which did.
export async function buyBasket(owner: PublicKey, b: BasketInfo, usdc: bigint, onProgress: (p: Progress) => void) {
  const c = connection()
  const prog: Progress = { phase: 'quoting', sent: 0, total: b.legs.length, sigs: [] }
  onProgress({ ...prog })
  const fee = feeFor(usdc)
  const legs = await quoteBuyLegs(b.legs.map((l) => l.stock), usdc - fee, SLIPPAGE_BPS)
  impactOk(legs)
  const step = (phase: TradePhase) => { prog.phase = phase; onProgress({ ...prog }) }
  step('building')
  const fw = feeWallet()
  const perLegFees = legs.map((_, i) => (fee * BigInt(i + 1)) / BigInt(legs.length) - (fee * BigInt(i)) / BigInt(legs.length))
  const { txs, lastValidBlockHeight } = await buildLegTxs(c, owner, legs, fw && fee > 0n ? { wallet: fw, amounts: perLegFees } : undefined, 'each-first')
  step('signing')
  const signed = await signAll(txs)
  step('sending')
  await sendAll(c, signed, lastValidBlockHeight, (_i, sig) => { prog.sigs.push(sig); prog.sent++; onProgress({ ...prog }) })
  step('done')
  return prog.sigs
}
// Sell a share of what the wallet holds of every leg, into USDC.
export async function sellBasket(owner: PublicKey, b: BasketInfo, pct: number, onProgress: (p: Progress) => void) {
  const c = connection()
  const held = b.legs.map((l) => ({ ...l.stock, amount: (l.held * BigInt(Math.round(pct * 100))) / 10_000n })).filter((h) => h.amount > 0n)
  const prog: Progress = { phase: 'quoting', sent: 0, total: held.length, sigs: [] }
  onProgress({ ...prog })
  if (!held.length) throw new Error('Nothing of this basket in the wallet.')
  const legs = await quoteSellLegs(held, SLIPPAGE_BPS)
  impactOk(legs)
  const step = (phase: TradePhase) => { prog.phase = phase; onProgress({ ...prog }) }
  step('building')
  const fw = feeWallet()
  const perLegFees = legs.map((l) => feeFor(BigInt(l.quote.otherAmountThreshold || l.quote.outAmount)))
  const totalFee = perLegFees.reduce((s, f) => s + f, 0n)
  const { txs, lastValidBlockHeight } = await buildLegTxs(c, owner, legs, fw && totalFee > 0n ? { wallet: fw, amounts: perLegFees } : undefined, 'each-last')
  step('signing')
  const signed = await signAll(txs)
  step('sending')
  await sendAll(c, signed, lastValidBlockHeight, (_i, sig) => { prog.sigs.push(sig); prog.sent++; onProgress({ ...prog }) })
  step('done')
  return prog.sigs
}
export const fmtUsdc = (v: bigint, d = 2) => `$${(Number(v) / 1e6).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`
export const fmtQty8 = (v: bigint, decimals: number) => (Number(v) / 10 ** decimals).toLocaleString('en-US', { maximumFractionDigits: 6 })
export const solscanTx = (sig: string) => `https://solscan.io/tx/${sig}`
export const solscanToken = (mint: string) => `https://solscan.io/token/${mint}`
