// Verdex Leverage: two-times long and short on tokenized stocks, built on Verdex Lend. A long borrows USDG
// against the stock it buys; a short borrows the stock against USDG and sells it. One swap each, the pool
// paid inside the callback, every position its own Lend position in a per-wallet account contract.
import { useQuery } from '@tanstack/react-query'
import { encodeDeployData, erc20Abi, formatUnits, isAddress, parseAbi, parseUnits, type Address, type ContractFunctionParameters } from 'viem'
import artifact from '../../contracts/VerdexLeverage.json'
import { LEVERAGE_ADDRESS as BUILT_IN } from '../../scripts/leverage-address.mjs'
import { TREASURY_ADDRESS } from '../../scripts/treasury-address.mjs'
import { VERDEX_TOKEN } from './holding'
import { LEND, type Market } from './lend'
import { MULTICALL3, USDG, client, ensureChain, type StockToken, type TxCtx } from './pools'

export const LEVERAGE_ADDRESS = (String(import.meta.env.VITE_LEVERAGE_ADDRESS ?? '').trim() || BUILT_IN).trim()
export const DEPLOYED = isAddress(LEVERAGE_ADDRESS)
export const LEVERAGE = (DEPLOYED ? LEVERAGE_ADDRESS : '0x0000000000000000000000000000000000000000') as Address
export const BYTECODE = artifact.bytecode as `0x${string}`
export const TREASURY = TREASURY_ADDRESS as Address
export const MAX = 2n ** 256n - 1n
export const DEFAULT_FEE_BPS = 25
export const SLIPPAGE_BPS = 100
export const MAX_LONG = 1.9 // at a 50% loan-to-value, 2x exactly cannot pass the health check after the pool fee
export const MAX_SHORT = 2
export const LAUNCH_CAP_USD = 25_000 // open interest per market at launch

export const abi = parseAbi([
  'constructor(address lend_,address usdg_,address verdex_,address treasury_,uint16 feeBps_)',
  'function lend() view returns (address)',
  'function owner() view returns (address)',
  'function feeBps() view returns (uint16)',
  'function accountOf(address) view returns (address)',
  'function maxExposure(uint256) view returns (uint256)',
  'function openInterest(uint256) view returns (uint256)',
  'function feeFor(address user,uint256 exposure) view returns (uint256)',
  'function status(address user,uint256 id) view returns ((uint8 side,uint256 margin,uint256 exposure,uint64 openedAt) p,uint256 collateral,uint256 debt,uint256 health)',
  'function openLong(uint256 id,uint256 margin,uint256 borrow,uint256 minUnits) returns (uint256)',
  'function closeLong(uint256 id,uint256 minOut) returns (uint256)',
  'function openShort(uint256 id,uint256 margin,uint256 units,uint256 minProceeds) returns (uint256)',
  'function closeShort(uint256 id,uint256 minOut) returns (uint256)',
  'function addMargin(uint256 id,uint256 amount)',
  'function settle(uint256 id)',
  'function setCaps(uint256[] ids,uint256[] maxes)',
  'event Opened(address indexed user,uint256 indexed id,uint8 side,uint256 margin,uint256 exposure,uint256 units,uint256 fee)',
  'event Closed(address indexed user,uint256 indexed id,uint8 side,uint256 returned)',
])

export type Pair = { stock: StockToken; long: Market; short?: Market; price: number }
/// Lend markets paired by stock: the long market (stock collateral, USDG loan) and the short market (USDG collateral, stock loan).
export function pairMarkets(markets: Market[]): Pair[] {
  const out: Pair[] = []
  for (const m of markets) {
    if (m.kind !== 'long' || !m.stock) continue
    const short = markets.find((x) => x.kind === 'short' && x.loan.toLowerCase() === m.collateral.toLowerCase())
    out.push({ stock: m.stock, long: m, short, price: m.priceUsd })
  }
  return out
}

export type Caps = { feeBps: number; cap: Record<string, bigint>; open: Record<string, bigint> }
export async function readCaps(markets: Market[]): Promise<Caps> {
  if (!DEPLOYED) return { feeBps: DEFAULT_FEE_BPS, cap: {}, open: {} }
  const c = client()
  const calls: ContractFunctionParameters[] = [
    { address: LEVERAGE, abi, functionName: 'feeBps' },
    ...markets.flatMap((m) => [
      { address: LEVERAGE, abi, functionName: 'maxExposure', args: [m.id] },
      { address: LEVERAGE, abi, functionName: 'openInterest', args: [m.id] },
    ]),
  ]
  const r = await c.multicall({ multicallAddress: MULTICALL3, contracts: calls, allowFailure: true })
  const v = (i: number) => (r[i].result as bigint | undefined) ?? 0n
  const cap: Record<string, bigint> = {}, open: Record<string, bigint> = {}
  markets.forEach((m, i) => { cap[m.id.toString()] = v(1 + i * 2); open[m.id.toString()] = v(2 + i * 2) })
  return { feeBps: Number(r[0].result ?? DEFAULT_FEE_BPS), cap, open }
}
export function useCaps(markets: Market[] | undefined) {
  return useQuery({ queryKey: ['leverage-caps', LEVERAGE, markets?.length ?? 0], queryFn: () => readCaps(markets ?? []), enabled: DEPLOYED && !!markets, refetchInterval: 30_000 })
}

export type LevPosition = { side: 0 | 1 | 2; margin: bigint; exposure: bigint; openedAt: number; collateral: bigint; debt: bigint; health: bigint }
export type LevWallet = { usdg: bigint; allowance: bigint; verdex: bigint; account: Address; positions: Record<string, LevPosition> }
export async function readLevWallet(owner: Address, markets: Market[]): Promise<LevWallet> {
  const c = client()
  const calls: ContractFunctionParameters[] = [
    { address: USDG.address, abi: erc20Abi, functionName: 'balanceOf', args: [owner] },
    { address: USDG.address, abi: erc20Abi, functionName: 'allowance', args: [owner, LEVERAGE] },
    { address: VERDEX_TOKEN.address, abi: erc20Abi, functionName: 'balanceOf', args: [owner] },
    { address: LEVERAGE, abi, functionName: 'accountOf', args: [owner] },
    ...markets.map((m) => ({ address: LEVERAGE, abi, functionName: 'status', args: [owner, m.id] })),
  ]
  const r = await c.multicall({ multicallAddress: MULTICALL3, contracts: calls, allowFailure: true })
  const v = (i: number) => (r[i].result as bigint | undefined) ?? 0n
  const positions: Record<string, LevPosition> = {}
  markets.forEach((m, i) => {
    const s = r[4 + i].result as [{ side: number; margin: bigint; exposure: bigint; openedAt: bigint }, bigint, bigint, bigint] | undefined
    if (!s) return
    positions[m.id.toString()] = { side: s[0].side as 0 | 1 | 2, margin: s[0].margin, exposure: s[0].exposure, openedAt: Number(s[0].openedAt), collateral: s[1], debt: s[2], health: s[3] }
  })
  return { usdg: v(0), allowance: v(1), verdex: v(2), account: (r[3].result as Address | undefined) ?? '0x0000000000000000000000000000000000000000', positions }
}
export function useLevWallet(owner: Address | undefined, markets: Market[] | undefined) {
  return useQuery({ queryKey: ['leverage-wallet', LEVERAGE, owner?.toLowerCase(), markets?.length ?? 0], queryFn: () => readLevWallet(owner as Address, markets ?? []), enabled: DEPLOYED && !!owner && !!markets, refetchInterval: 20_000 })
}

// ---- plans: what a position looks like before you sign ----

export type Plan = { side: 'long' | 'short'; margin: bigint; exposure: bigint; borrow: bigint; units: bigint; minUnits: bigint; minProceeds: bigint; fee: bigint; health: number; liqPrice: number; leverage: number }
const poolFee = (m: Market) => (m.pool?.fee ?? 3000) / 1_000_000
export function planLong(p: Pair, margin: bigint, leverage: number, feeBps: number, holder: boolean): Plan {
  const lev = Math.min(Math.max(leverage, 1.01), MAX_LONG)
  const borrow = (margin * BigInt(Math.round((lev - 1) * 10_000))) / 10_000n
  const exposure = margin + borrow
  const units = p.price > 0 ? parseUnits(((Number(formatUnits(exposure, 6)) * (1 - poolFee(p.long))) / p.price).toFixed(p.stock.decimals), p.stock.decimals) : 0n
  const minUnits = (units * BigInt(10_000 - SLIPPAGE_BPS)) / 10_000n
  const fee = holder ? 0n : (exposure * BigInt(feeBps)) / 10_000n
  const collUsd = Number(formatUnits(units, p.stock.decimals)) * p.price, debtUsd = Number(formatUnits(borrow, 6))
  const health = debtUsd > 0 ? (collUsd * p.long.liqThresholdBps) / 10_000 / debtUsd : Infinity
  const liqPrice = units > 0n ? debtUsd / (Number(formatUnits(units, p.stock.decimals)) * (p.long.liqThresholdBps / 10_000)) : 0
  return { side: 'long', margin, exposure, borrow, units, minUnits, minProceeds: 0n, fee, health, liqPrice, leverage: lev }
}
export function planShort(p: Pair, margin: bigint, leverage: number, feeBps: number, holder: boolean): Plan {
  const s = p.short
  const spotPrice = s?.pool?.priceUsd && s.pool.priceUsd > 0 ? s.pool.priceUsd : p.price
  const lev = Math.min(Math.max(leverage, 1.01), MAX_SHORT)
  const exposure = (margin * BigInt(Math.round(lev * 10_000))) / 10_000n
  const units = s && spotPrice > 0 ? parseUnits((Number(formatUnits(exposure, 6)) / spotPrice).toFixed(p.stock.decimals), p.stock.decimals) : 0n
  const proceeds = s ? (exposure * BigInt(Math.round((1 - poolFee(s)) * 10_000))) / 10_000n : 0n
  const minProceeds = (proceeds * BigInt(10_000 - SLIPPAGE_BPS)) / 10_000n
  const fee = holder ? 0n : (proceeds * BigInt(feeBps)) / 10_000n
  const collUsd = Number(formatUnits(margin + proceeds, 6)), debtUsd = Number(formatUnits(units, p.stock.decimals)) * p.price
  const health = s && debtUsd > 0 ? (collUsd * s.liqThresholdBps) / 10_000 / debtUsd : Infinity
  const liqPrice = s && units > 0n ? (collUsd * (s.liqThresholdBps / 10_000)) / Number(formatUnits(units, p.stock.decimals)) : 0
  return { side: 'short', margin, exposure: proceeds, borrow: 0n, units, minUnits: 0n, minProceeds, fee, health, liqPrice, leverage: lev }
}

/// Equity and profit of an open position at today's price, in USDG.
export function valueOf(p: Pair, pos: LevPosition): { equity: number; pnl: number; liqPrice: number } {
  const dec = p.stock.decimals
  if (pos.side === 1) {
    const coll = Number(formatUnits(pos.collateral, dec)), debt = Number(formatUnits(pos.debt, 6))
    const equity = coll * p.price - debt
    return { equity, pnl: equity - Number(formatUnits(pos.margin, 6)), liqPrice: coll > 0 ? debt / (coll * (p.long.liqThresholdBps / 10_000)) : 0 }
  }
  if (pos.side === 2 && p.short) {
    const coll = Number(formatUnits(pos.collateral, 6)), debt = Number(formatUnits(pos.debt, dec))
    const equity = coll - debt * p.price
    return { equity, pnl: equity - Number(formatUnits(pos.margin, 6)), liqPrice: debt > 0 ? (coll * (p.short.liqThresholdBps / 10_000)) / debt : 0 }
  }
  return { equity: 0, pnl: 0, liqPrice: 0 }
}

// ---- transactions ----

async function approveExact(ctx: TxCtx, amount: bigint, current: bigint) {
  if (current >= amount) return
  ctx.onPhase('approving')
  const hash = await ctx.walletClient.writeContract({ address: USDG.address, abi: erc20Abi, functionName: 'approve', args: [LEVERAGE, amount], account: ctx.account.address, chain: null })
  const receipt = await client().waitForTransactionReceipt({ hash, timeout: 120_000 })
  if (receipt.status !== 'success') throw new Error('The approval transaction reverted.')
}
async function send(ctx: TxCtx, fn: 'openLong' | 'closeLong' | 'openShort' | 'closeShort' | 'addMargin' | 'settle', args: readonly unknown[]) {
  ctx.onPhase('confirming')
  const hash = await ctx.walletClient.writeContract({ address: LEVERAGE, abi, functionName: fn, args: args as never, account: ctx.account.address, chain: null })
  ctx.onPhase('pending')
  const receipt = await client().waitForTransactionReceipt({ hash, timeout: 120_000 })
  if (receipt.status !== 'success') throw new Error('The transaction reverted.')
  ctx.onPhase('done')
  return hash
}
export async function openLong(ctx: TxCtx, p: Pair, plan: Plan, allowance: bigint) {
  await ensureChain(ctx); await approveExact(ctx, plan.margin + plan.fee, allowance)
  return send(ctx, 'openLong', [p.long.id, plan.margin, plan.borrow, plan.minUnits])
}
export async function closeLong(ctx: TxCtx, p: Pair, minOut: bigint) {
  await ensureChain(ctx)
  return send(ctx, 'closeLong', [p.long.id, minOut])
}
export async function openShort(ctx: TxCtx, p: Pair, plan: Plan, allowance: bigint) {
  if (!p.short) throw new Error('No short market for this stock yet.')
  const feeCover = plan.fee > 0n ? plan.fee + (plan.fee * BigInt(SLIPPAGE_BPS)) / 10_000n + 1n : 0n
  await ensureChain(ctx); await approveExact(ctx, plan.margin + feeCover, allowance)
  return send(ctx, 'openShort', [p.short.id, plan.margin, plan.units, plan.minProceeds])
}
export async function closeShort(ctx: TxCtx, p: Pair, minOut: bigint) {
  if (!p.short) throw new Error('No short market for this stock yet.')
  await ensureChain(ctx)
  return send(ctx, 'closeShort', [p.short.id, minOut])
}
export async function addMargin(ctx: TxCtx, id: bigint, amount: bigint, allowance: bigint) {
  await ensureChain(ctx); await approveExact(ctx, amount, allowance)
  return send(ctx, 'addMargin', [id, amount])
}
export async function settle(ctx: TxCtx, id: bigint) {
  await ensureChain(ctx)
  return send(ctx, 'settle', [id])
}

// ---- deploy ----

export async function deployLeverage(ctx: TxCtx) {
  await ensureChain(ctx)
  ctx.onPhase('confirming')
  const hash = await ctx.walletClient.sendTransaction({ account: ctx.account.address, chain: null, data: encodeDeployData({ abi, bytecode: BYTECODE, args: [LEND, USDG.address, VERDEX_TOKEN.address, TREASURY, DEFAULT_FEE_BPS] }) })
  ctx.onPhase('pending')
  const receipt = await client().waitForTransactionReceipt({ hash, timeout: 120_000 })
  ctx.onPhase('done')
  return { hash, address: receipt.contractAddress as Address }
}
export async function setCaps(ctx: TxCtx, leverage: Address, ids: bigint[], maxes: bigint[]) {
  await ensureChain(ctx)
  ctx.onPhase('confirming')
  const hash = await ctx.walletClient.writeContract({ address: leverage, abi, functionName: 'setCaps', args: [ids, maxes], account: ctx.account.address, chain: null })
  ctx.onPhase('pending')
  await client().waitForTransactionReceipt({ hash, timeout: 120_000 })
  ctx.onPhase('done')
  return hash
}

export const fmtUsdg = (v: bigint, d = 2) => `$${Number(formatUnits(v, 6)).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`
export const fmtHealth = (h: bigint) => (h === MAX ? '∞' : (Number(h) / 10_000).toFixed(2))
