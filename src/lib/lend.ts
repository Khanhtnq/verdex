// Verdex Lend: isolated money markets for tokenized stocks on Robinhood Chain. One contract, one market per
// stock against USDG. Everything here is read from the chain in the browser; writes go through the wallet.
import { useQuery } from '@tanstack/react-query'
import { encodeDeployData, erc20Abi, formatUnits, isAddress, parseAbi, type Address, type ContractFunctionParameters } from 'viem'
import artifact from '../../contracts/VerdexLend.json'
import { LEND_ADDRESS as BUILT_IN } from '../../scripts/lend-address.mjs'
import { TREASURY_ADDRESS } from '../../scripts/treasury-address.mjs'
import { deepEnough, poolFor } from './autopilot'
import { MULTICALL3, USDG, client, ensureChain, stockTokens, type Pool, type StockToken, type TxCtx } from './pools'
import type { Asset } from './api'

export const LEND_ADDRESS = (String(import.meta.env.VITE_LEND_ADDRESS ?? '').trim() || BUILT_IN).trim()
export const DEPLOYED = isAddress(LEND_ADDRESS)
export const LEND = (DEPLOYED ? LEND_ADDRESS : '0x0000000000000000000000000000000000000000') as Address
export const BYTECODE = artifact.bytecode as `0x${string}`
export const TREASURY = TREASURY_ADDRESS as Address
export const MAX = 2n ** 256n - 1n

export const abi = parseAbi([
  'constructor(address treasury_)',
  'function marketCount() view returns (uint256)',
  'function market(uint256 id) view returns ((address collateral,address loan,address pool,bool collateralIsToken0,bool enabled,uint16 ltvBps,uint16 liqThresholdBps,uint16 liqBonusBps,uint32 twapWindow,uint64 rateBaseBps,uint64 rateSlopeBps,uint64 lastAccrual,uint256 supplyCap,uint256 borrowCap,uint256 collateralCap,uint256 totalSupplyAssets,uint256 totalSupplyShares,uint256 totalBorrowAssets,uint256 totalBorrowShares,uint256 totalCollateral,uint256 reserves))',
  'function collateralValue(uint256 id,uint256 amount,bool forBorrow) view returns (uint256)',
  'function debtOf(uint256 id,address who) view returns (uint256)',
  'function suppliedOf(uint256 id,address who) view returns (uint256)',
  'function rates(uint256 id) view returns (uint256 borrowAprBps,uint256 supplyAprBps,uint256 utilisationBps)',
  'function borrowable(uint256 id,address who) view returns (uint256)',
  'function health(uint256 id,address who) view returns (uint256)',
  'function supplyShares(uint256,address) view returns (uint256)',
  'function borrowShares(uint256,address) view returns (uint256)',
  'function collateralOf(uint256,address) view returns (uint256)',
  'function owner() view returns (address)',
  'function treasury() view returns (address)',
  'function reserveBps() view returns (uint16)',
  'function supply(uint256 id,uint256 assets,address to) returns (uint256)',
  'function withdraw(uint256 id,uint256 shares,address to) returns (uint256)',
  'function addCollateral(uint256 id,uint256 amount,address to)',
  'function removeCollateral(uint256 id,uint256 amount,address to)',
  'function borrow(uint256 id,uint256 assets,address to) returns (uint256)',
  'function repay(uint256 id,uint256 assets,address onBehalf) returns (uint256,uint256)',
  'function liquidate(uint256 id,address borrower,uint256 assets) returns (uint256,uint256)',
  'function skim(uint256 id) returns (uint256)',
  'function createMarket(address collateral,address loan,address pool,uint16 ltvBps,uint16 liqThresholdBps,uint16 liqBonusBps,uint32 twapWindow,uint64 rateBaseBps,uint64 rateSlopeBps,uint256 supplyCap,uint256 borrowCap,uint256 collateralCap) returns (uint256)',
  'function setCaps(uint256 id,uint256 supplyCap,uint256 borrowCap,uint256 collateralCap)',
  'event MarketCreated(uint256 indexed id,address indexed collateral,address indexed loan,address pool)',
])

// Launch parameters: conservative, capped, raised as the market proves itself. Long markets lend USDG against a
// stock; short markets lend the stock itself against USDG (what a short borrows), so their caps are in stock units.
export const LAUNCH = { ltvBps: 5000, liqThresholdBps: 6500, liqBonusBps: 500, twapWindow: 1800, rateBaseBps: 200n, rateSlopeBps: 2000n, supplyCap: 25_000n * 10n ** 6n, borrowCap: 20_000n * 10n ** 6n, collateralUsd: 50_000 }
export const LAUNCH_SHORT = { ltvBps: 7000, liqThresholdBps: 8000, liqBonusBps: 300, twapWindow: 1800, rateBaseBps: 200n, rateSlopeBps: 2000n, supplyUsd: 25_000, borrowUsd: 20_000, collateralCap: 100_000n * 10n ** 6n }
export const LAUNCH_TICKERS = ['NVDA', 'TSLA', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META']

export type Market = {
  id: bigint
  kind: 'long' | 'short' // long: borrow USDG against the stock. short: borrow the stock against USDG.
  stock?: StockToken
  pool?: Pool
  collateral: Address
  loan: Address
  collateralDecimals: number
  loanDecimals: number
  collateralSymbol: string
  loanSymbol: string
  poolAddress: Address
  enabled: boolean
  ltvBps: number
  liqThresholdBps: number
  liqBonusBps: number
  twapWindow: number
  supplyCap: bigint
  borrowCap: bigint
  collateralCap: bigint
  totalSupplyAssets: bigint
  totalSupplyShares: bigint
  totalBorrowAssets: bigint
  totalBorrowShares: bigint
  totalCollateral: bigint
  reserves: bigint
  borrowApr: number // percent
  supplyApr: number
  utilisation: number
  priceUsd: number // the stock in USDG, at the borrow price
  available: bigint // loan asset that can still be borrowed or withdrawn
}

export async function readMarkets(assets: Asset[], pools: Pool[]): Promise<Market[]> {
  if (!DEPLOYED) return []
  const c = client()
  const n = await c.readContract({ address: LEND, abi, functionName: 'marketCount' })
  if (n === 0n) return []
  const ids = Array.from({ length: Number(n) }, (_, i) => BigInt(i))
  const heads = await c.multicall({ multicallAddress: MULTICALL3, contracts: ids.map((id) => ({ address: LEND, abi, functionName: 'market' as const, args: [id] })), allowFailure: false })
  const stocks = stockTokens(assets)
  const usdg = USDG.address.toLowerCase()
  const tokenOf = (a: Address) => (a.toLowerCase() === usdg ? { symbol: 'USDG', decimals: 6 } : stocks.find((s) => s.address.toLowerCase() === a.toLowerCase()) ?? { symbol: a.slice(0, 6), decimals: 18 })
  const calls: ContractFunctionParameters[] = ids.flatMap((id, i) => [
    { address: LEND, abi, functionName: 'rates', args: [id] },
    { address: LEND, abi, functionName: 'collateralValue', args: [id, 10n ** BigInt(tokenOf(heads[i].collateral).decimals), true] },
  ])
  const r = await c.multicall({ multicallAddress: MULTICALL3, contracts: calls, allowFailure: true })
  return ids.map((id, i) => {
    const m = heads[i]
    const rates = (r[i * 2].result as [bigint, bigint, bigint] | undefined) ?? [0n, 0n, 0n]
    const unit = (r[i * 2 + 1].result as bigint | undefined) ?? 0n
    const kind: Market['kind'] = m.loan.toLowerCase() === usdg ? 'long' : 'short'
    const stockAddr = kind === 'long' ? m.collateral : m.loan
    const stock = stocks.find((s) => s.address.toLowerCase() === stockAddr.toLowerCase())
    const pool = pools.find((p) => p.address.toLowerCase() === m.pool.toLowerCase()) ?? (stock ? poolFor(stock, pools) : undefined)
    const ct = tokenOf(m.collateral), lt = tokenOf(m.loan)
    // unit = value of one collateral unit in the loan asset. Long: USDG per stock. Short: stock per USDG, so invert.
    const unitValue = Number(formatUnits(unit, lt.decimals))
    const priceUsd = kind === 'long' ? unitValue : unitValue > 0 ? 1 / unitValue : 0
    const available = m.totalSupplyAssets > m.totalBorrowAssets ? m.totalSupplyAssets - m.totalBorrowAssets : 0n
    return { id, kind, stock, pool, collateral: m.collateral, loan: m.loan, collateralDecimals: ct.decimals, loanDecimals: lt.decimals, collateralSymbol: ct.symbol, loanSymbol: lt.symbol, poolAddress: m.pool, enabled: m.enabled, ltvBps: m.ltvBps, liqThresholdBps: m.liqThresholdBps, liqBonusBps: m.liqBonusBps, twapWindow: m.twapWindow, supplyCap: m.supplyCap, borrowCap: m.borrowCap, collateralCap: m.collateralCap, totalSupplyAssets: m.totalSupplyAssets, totalSupplyShares: m.totalSupplyShares, totalBorrowAssets: m.totalBorrowAssets, totalBorrowShares: m.totalBorrowShares, totalCollateral: m.totalCollateral, reserves: m.reserves, borrowApr: Number(rates[0]) / 100, supplyApr: Number(rates[1]) / 100, utilisation: Number(rates[2]) / 100, priceUsd, available }
  })
}

export function useMarkets(assets: Asset[] | undefined, pools: Pool[] | undefined) {
  return useQuery({ queryKey: ['lend-markets', LEND, assets?.length ?? 0, pools?.length ?? 0], queryFn: () => readMarkets(assets ?? [], pools ?? []), enabled: DEPLOYED && !!assets && !!pools, refetchInterval: 30_000, staleTime: 15_000 })
}

export type Position = { supplied: bigint; supplyShares: bigint; collateral: bigint; debt: bigint; borrowable: bigint; health: bigint }
export type TokenState = { balance: bigint; allowance: bigint }
export type Wallet = { positions: Record<string, Position>; tokens: Record<string, TokenState> }
const EMPTY_TOKEN: TokenState = { balance: 0n, allowance: 0n }
export const tokenState = (w: Wallet | undefined, token: Address) => w?.tokens[token.toLowerCase()] ?? EMPTY_TOKEN

export async function readWallet(owner: Address, markets: Market[]): Promise<Wallet> {
  const c = client()
  const tokens = [...new Set([USDG.address.toLowerCase(), ...markets.flatMap((m) => [m.collateral.toLowerCase(), m.loan.toLowerCase()])])] as Address[]
  const calls: ContractFunctionParameters[] = [
    ...tokens.flatMap((t) => [
      { address: t, abi: erc20Abi, functionName: 'balanceOf', args: [owner] },
      { address: t, abi: erc20Abi, functionName: 'allowance', args: [owner, LEND] },
    ]),
    ...markets.flatMap((m) => [
      { address: LEND, abi, functionName: 'suppliedOf', args: [m.id, owner] },
      { address: LEND, abi, functionName: 'supplyShares', args: [m.id, owner] },
      { address: LEND, abi, functionName: 'collateralOf', args: [m.id, owner] },
      { address: LEND, abi, functionName: 'debtOf', args: [m.id, owner] },
      { address: LEND, abi, functionName: 'borrowable', args: [m.id, owner] },
      { address: LEND, abi, functionName: 'health', args: [m.id, owner] },
    ]),
  ]
  const r = await c.multicall({ multicallAddress: MULTICALL3, contracts: calls, allowFailure: true })
  const v = (i: number) => (r[i].result as bigint | undefined) ?? 0n
  const tk: Record<string, TokenState> = {}
  tokens.forEach((t, i) => { tk[t] = { balance: v(i * 2), allowance: v(i * 2 + 1) } })
  const positions: Record<string, Position> = {}
  const base = tokens.length * 2
  markets.forEach((m, i) => { const b = base + i * 6; positions[m.id.toString()] = { supplied: v(b), supplyShares: v(b + 1), collateral: v(b + 2), debt: v(b + 3), borrowable: v(b + 4), health: v(b + 5) } })
  return { positions, tokens: tk }
}

export function useLendWallet(owner: Address | undefined, markets: Market[] | undefined) {
  return useQuery({ queryKey: ['lend-wallet', LEND, owner?.toLowerCase(), markets?.length ?? 0], queryFn: () => readWallet(owner as Address, markets ?? []), enabled: DEPLOYED && !!owner && !!markets, refetchInterval: 20_000 })
}

async function approveExact(ctx: TxCtx, token: Address, amount: bigint, current: bigint) {
  if (current >= amount) return
  ctx.onPhase('approving')
  const hash = await ctx.walletClient.writeContract({ address: token, abi: erc20Abi, functionName: 'approve', args: [LEND, amount], account: ctx.account.address, chain: null })
  const receipt = await client().waitForTransactionReceipt({ hash, timeout: 120_000 })
  if (receipt.status !== 'success') throw new Error('The approval transaction reverted.')
}

async function send(ctx: TxCtx, fn: 'supply' | 'withdraw' | 'addCollateral' | 'removeCollateral' | 'borrow' | 'repay' | 'skim', args: readonly unknown[]) {
  ctx.onPhase('confirming')
  const hash = await ctx.walletClient.writeContract({ address: LEND, abi, functionName: fn, args: args as never, account: ctx.account.address, chain: null })
  ctx.onPhase('pending')
  const receipt = await client().waitForTransactionReceipt({ hash, timeout: 120_000 })
  if (receipt.status !== 'success') throw new Error('The transaction reverted.')
  ctx.onPhase('done')
  return hash
}

export async function supplyLoan(ctx: TxCtx, m: Market, assets: bigint, allowance: bigint) {
  await ensureChain(ctx); await approveExact(ctx, m.loan, assets, allowance)
  return send(ctx, 'supply', [m.id, assets, ctx.account.address])
}
export async function withdrawLoan(ctx: TxCtx, m: Market, shares: bigint) {
  await ensureChain(ctx)
  return send(ctx, 'withdraw', [m.id, shares, ctx.account.address])
}
export async function addCollateral(ctx: TxCtx, m: Market, amount: bigint, allowance: bigint) {
  await ensureChain(ctx); await approveExact(ctx, m.collateral, amount, allowance)
  return send(ctx, 'addCollateral', [m.id, amount, ctx.account.address])
}
export async function removeCollateral(ctx: TxCtx, m: Market, amount: bigint) {
  await ensureChain(ctx)
  return send(ctx, 'removeCollateral', [m.id, amount, ctx.account.address])
}
export async function borrowLoan(ctx: TxCtx, m: Market, assets: bigint) {
  await ensureChain(ctx)
  return send(ctx, 'borrow', [m.id, assets, ctx.account.address])
}
// Repay: approve a hair more than the debt so interest accrued between the quote and the block is covered; the contract pulls only what is owed.
export async function repayLoan(ctx: TxCtx, m: Market, assets: bigint, all: boolean, allowance: bigint) {
  await ensureChain(ctx)
  const cover = all ? assets + assets / 1000n + 1n : assets
  await approveExact(ctx, m.loan, cover, allowance)
  return send(ctx, 'repay', [m.id, all ? MAX : assets, ctx.account.address])
}

// Deploy: one transaction, then one createMarket per launch market from the deploy page.
export async function deployLend(ctx: TxCtx) {
  await ensureChain(ctx)
  ctx.onPhase('confirming')
  const hash = await ctx.walletClient.sendTransaction({ account: ctx.account.address, chain: null, data: encodeDeployData({ abi, bytecode: BYTECODE, args: [TREASURY] }) })
  ctx.onPhase('pending')
  const receipt = await client().waitForTransactionReceipt({ hash, timeout: 120_000 })
  if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error('The deploy transaction reverted.')
  ctx.onPhase('done')
  return { hash, address: receipt.contractAddress as Address }
}

export type MarketPlan = { kind: 'long' | 'short'; stock: StockToken; pool: Pool; collateral: Address; loan: Address; params: typeof LAUNCH | typeof LAUNCH_SHORT; supplyCap: bigint; borrowCap: bigint; collateralCap: bigint }
const stockUnits = (usd: number, price: number, decimals: number) => BigInt(Math.floor((usd / price) * 1e6)) * 10n ** BigInt(decimals - 6)
export function planMarkets(assets: Asset[], pools: Pool[]): { plans: MarketPlan[]; missing: string[] } {
  const stocks = stockTokens(assets)
  const plans: MarketPlan[] = [], missing: string[] = []
  for (const ticker of LAUNCH_TICKERS) {
    const stock = stocks.find((s) => s.ticker === ticker)
    const pool = stock ? poolFor(stock, pools) : undefined
    if (!stock || !pool || !deepEnough(pool) || pool.quote.address.toLowerCase() !== USDG.address.toLowerCase() || pool.priceUsd <= 0) { missing.push(ticker); continue }
    plans.push({ kind: 'long', stock, pool, collateral: stock.address, loan: USDG.address, params: LAUNCH, supplyCap: LAUNCH.supplyCap, borrowCap: LAUNCH.borrowCap, collateralCap: stockUnits(LAUNCH.collateralUsd, pool.priceUsd, stock.decimals) })
  }
  for (const p of [...plans]) plans.push({ kind: 'short', stock: p.stock, pool: p.pool, collateral: USDG.address, loan: p.stock.address, params: LAUNCH_SHORT, supplyCap: stockUnits(LAUNCH_SHORT.supplyUsd, p.pool.priceUsd, p.stock.decimals), borrowCap: stockUnits(LAUNCH_SHORT.borrowUsd, p.pool.priceUsd, p.stock.decimals), collateralCap: LAUNCH_SHORT.collateralCap })
  return { plans, missing }
}

export async function createMarket(ctx: TxCtx, lend: Address, p: MarketPlan) {
  await ensureChain(ctx)
  ctx.onPhase('confirming')
  const hash = await ctx.walletClient.writeContract({ address: lend, abi, functionName: 'createMarket', args: [p.collateral, p.loan, p.pool.address, p.params.ltvBps, p.params.liqThresholdBps, p.params.liqBonusBps, p.params.twapWindow, p.params.rateBaseBps, p.params.rateSlopeBps, p.supplyCap, p.borrowCap, p.collateralCap], account: ctx.account.address, chain: null })
  ctx.onPhase('pending')
  await client().waitForTransactionReceipt({ hash, timeout: 120_000 })
  ctx.onPhase('done')
  return hash
}

export const fmtUsdg = (v: bigint, d = 2) => `$${Number(formatUnits(v, 6)).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`
/// An amount of a market's token, with its symbol: USDG as dollars, a stock as units.
export const fmtAmt = (v: bigint, decimals: number, symbol: string, d?: number) => (symbol === 'USDG' ? fmtUsdg(v, d ?? 2) : `${Number(formatUnits(v, decimals)).toLocaleString('en-US', { maximumFractionDigits: d ?? 4 })} ${symbol}`)
export const fmtUnits = (v: bigint, decimals: number, d = 4) => Number(formatUnits(v, decimals)).toLocaleString('en-US', { maximumFractionDigits: d })
export const fmtHealth = (h: bigint) => (h === MAX ? '∞' : (Number(h) / 10_000).toFixed(2))
