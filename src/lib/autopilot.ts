// Auto-Invest without you: recurring buys that run from a contract on Robinhood Chain while the owner
// is away. The contract (contracts/VerdexAutoInvest.sol) pulls one buy's worth from the owner's USDG
// allowance when a buy is due, swaps it in the Uniswap v3 pool the plan names, sends the stock to the
// owner and a small tip to whoever ran it. It holds nothing between buys. This module reads plans, builds
// the transactions and chooses the pool; the page shows them.
import { useQuery } from '@tanstack/react-query'
import { encodeFunctionData, erc20Abi, formatUnits, isAddress, parseAbi, parseUnits, type Address } from 'viem'
import artifact from '../../contracts/VerdexAutoInvest.json'
import { AUTOINVEST_ADDRESS as BUILT_IN, BASE_AUTOINVEST_ADDRESS as BASE_BUILT_IN } from '../../scripts/autoinvest-address.mjs'
import type { Asset } from './api'
import { waitForTx } from './lifi'
import { DEEP_POOL_USD } from './yield'
import { BASE_INDEX, ROBINHOOD_INDEX, type IndexChain } from './indexChains'
import { MULTICALL3, USDG, clientFor, ensureChainOn, sendTx, stockTokensOn, type Pool, type StockToken, type TxCtx } from './pools'

// The deployed contract: built into the site once it lands, with an env override for previews.
export const AUTOINVEST_ADDRESS = (String(import.meta.env.VITE_AUTOINVEST_ADDRESS ?? '').trim() || BUILT_IN).trim()
export const BASE_AUTOINVEST_ADDRESS = (String(import.meta.env.VITE_BASE_AUTOINVEST_ADDRESS ?? '').trim() || BASE_BUILT_IN).trim()
export const DEPLOYED = isAddress(AUTOINVEST_ADDRESS)
export const CONTRACT = (DEPLOYED ? AUTOINVEST_ADDRESS : '0x0000000000000000000000000000000000000000') as Address
export const abi = parseAbi([
  'constructor(address factory_, address executor_)',
  'function createPlan(address tokenIn,address tokenOut,uint24 fee,uint96 amountIn,uint96 tip,uint32 interval,uint40 firstAt,uint32 buys,uint16 maxSlippageBps) returns (uint256)',
  'function setPaused(uint256 id,bool paused)',
  'function cancel(uint256 id)',
  'function plansOf(address owner) view returns (uint256[])',
  'function isDue(uint256 id) view returns (bool)',
  'function quoteSpot(uint256 id) view returns (uint256)',
  'function floorOut(uint256 id) view returns (uint256)',
  'function execute(uint256 id,uint256 minOut) returns (uint256)',
  'function planCount() view returns (uint256)',
  'function plans(uint256) view returns (address owner,address tokenIn,address tokenOut,uint24 fee,uint32 interval,uint40 nextAt,uint32 buysLeft,uint32 buysDone,uint16 maxSlippageBps,bool paused,uint96 amountIn,uint96 tip,uint128 spent,uint128 received)',
  'function admin() view returns (address)',
  'function isExecutor(address) view returns (bool)',
  'function setExecutor(address executor,bool allowed)',
  'function factory() view returns (address)',
  'event PlanCreated(uint256 indexed id,address indexed owner,address tokenIn,address tokenOut,uint24 fee,uint96 amountIn,uint32 interval,uint40 firstAt,uint32 buys)',
  'event Executed(uint256 indexed id,address indexed executor,uint256 amountIn,uint256 amountOut,uint256 tip,uint40 nextAt)',
])
export const BYTECODE = artifact.bytecode as `0x${string}`
export const EXPLORER = 'https://robin.etherscan.io'
// The Base contract (contracts/VerdexAutoInvestCL.sol): Slipstream's tick spacing in place of the fee tier.
export const abiCL = parseAbi([
  'function createPlan(address tokenIn,address tokenOut,int24 tickSpacing,uint96 amountIn,uint96 tip,uint32 interval,uint40 firstAt,uint32 buys,uint16 maxSlippageBps) returns (uint256)',
  'function plans(uint256) view returns (address owner,address tokenIn,address tokenOut,int24 tickSpacing,uint32 interval,uint40 nextAt,uint32 buysLeft,uint32 buysDone,uint16 maxSlippageBps,bool paused,uint96 amountIn,uint96 tip,uint128 spent,uint128 received)',
])
// Where plans can live: the chain, its contract, the stablecoin they pay with and the pool interface.
export type PlanChain = { key: 'robinhood' | 'base'; ic: IndexChain; contract: Address; deployed: boolean; isCL: boolean; quote: { address: Address; symbol: string; decimals: number }; source: string }
export const PLAN_CHAINS: PlanChain[] = [
  { key: 'robinhood', ic: ROBINHOOD_INDEX, contract: CONTRACT, deployed: DEPLOYED, isCL: false, quote: USDG, source: 'VerdexAutoInvest.sol' },
  { key: 'base', ic: BASE_INDEX, contract: (isAddress(BASE_AUTOINVEST_ADDRESS) ? BASE_AUTOINVEST_ADDRESS : '0x0000000000000000000000000000000000000000') as Address, deployed: isAddress(BASE_AUTOINVEST_ADDRESS), isCL: true, quote: BASE_INDEX.quote as { address: Address; symbol: string; decimals: number }, source: 'VerdexAutoInvestCL.sol' },
]
export const planChain = (key: string | null | undefined) => PLAN_CHAINS.find((c) => c.key === key) ?? PLAN_CHAINS[0]
const plansAbi = (pc: PlanChain) => (pc.isCL ? abiCL : abi) as typeof abi
export const UNLIMITED = 4294967295
export const MIN_INTERVAL = 3600
export const DEFAULT_TIP = parseUnits('0.05', 6)
export const DEFAULT_SLIPPAGE_BPS = 100

export type Cadence = { key: string; label: string; seconds: number; perMonth: number }
export const CADENCES: Cadence[] = [
  { key: 'day', label: 'Every day', seconds: 86_400, perMonth: 30 },
  { key: 'week', label: 'Every week', seconds: 604_800, perMonth: 52 / 12 },
  { key: 'two', label: 'Every two weeks', seconds: 1_209_600, perMonth: 26 / 12 },
  { key: 'month', label: 'Every month', seconds: 2_592_000, perMonth: 1 },
]
export const cadenceFor = (seconds: number) => CADENCES.find((c) => c.seconds === seconds)?.label ?? (seconds % 86_400 === 0 ? `Every ${seconds / 86_400} days` : `Every ${Math.round(seconds / 3600)} hours`)

export type OnchainPlan = {
  id: bigint
  owner: Address
  tokenIn: Address
  tokenOut: Address
  fee: number
  interval: number
  nextAt: number
  buysLeft: number
  buysDone: number
  maxSlippageBps: number
  paused: boolean
  amountIn: bigint
  tip: bigint
  spent: bigint
  received: bigint
  quoteOut: bigint
  stock?: StockToken
  state: 'active' | 'paused' | 'finished' | 'cancelled'
}
export const STATE_LABEL: Record<OnchainPlan['state'], string> = { active: 'Running', paused: 'Paused', finished: 'Finished', cancelled: 'Cancelled' }

type RawPlan = readonly [Address, Address, Address, number, number, number, number, number, number, boolean, bigint, bigint, bigint, bigint]
function fromRaw(id: bigint, r: RawPlan, quoteOut: bigint, stocks: StockToken[]): OnchainPlan {
  const [owner, tokenIn, tokenOut, fee, interval, nextAt, buysLeft, buysDone, maxSlippageBps, paused] = r
  const cancelled = paused && buysLeft === 0
  const state: OnchainPlan['state'] = cancelled ? 'cancelled' : buysLeft === 0 ? 'finished' : paused ? 'paused' : 'active'
  return { id, owner, tokenIn, tokenOut, fee, interval, nextAt, buysLeft, buysDone, maxSlippageBps, paused, amountIn: r[10], tip: r[11], spent: r[12], received: r[13], quoteOut, stock: stocks.find((s) => s.address.toLowerCase() === tokenOut.toLowerCase()), state }
}

export async function readPlans(pc: PlanChain, owner: Address, assets: Asset[]): Promise<OnchainPlan[]> {
  if (!pc.deployed) return []
  const c = clientFor(pc.ic)
  const A = plansAbi(pc)
  const ids = [...(await c.readContract({ address: pc.contract, abi: A, functionName: 'plansOf', args: [owner] }))]
  if (!ids.length) return []
  const raw = await c.multicall({ multicallAddress: MULTICALL3, contracts: ids.flatMap((id) => [{ address: pc.contract, abi: A, functionName: 'plans', args: [id] } as const, { address: pc.contract, abi: A, functionName: 'quoteSpot', args: [id] } as const]) })
  const stocks = stockTokensOn(assets, pc.ic.id)
  return ids.map((id, i) => fromRaw(id, raw[i * 2].result as RawPlan, (raw[i * 2 + 1].status === 'success' ? (raw[i * 2 + 1].result as bigint) : 0n), stocks)).reverse()
}
export function usePlans(pc: PlanChain, owner: Address | undefined, assets: Asset[] | undefined) {
  return useQuery({ queryKey: ['autopilot', pc.key, owner?.toLowerCase()], queryFn: () => readPlans(pc, owner!, assets!), enabled: pc.deployed && !!owner && !!assets, staleTime: 15_000, refetchInterval: 30_000, retry: 1 })
}

export type Totals = { plans: number; buys: number; spent: number; running: number }
export async function readTotals(pc: PlanChain): Promise<Totals> {
  if (!pc.deployed) return { plans: 0, buys: 0, spent: 0, running: 0 }
  const c = clientFor(pc.ic)
  const A = plansAbi(pc)
  const n = Number(await c.readContract({ address: pc.contract, abi: A, functionName: 'planCount' }))
  const ids = Array.from({ length: Math.min(n, 400) }, (_, i) => BigInt(n - i))
  const raw = ids.length ? await c.multicall({ multicallAddress: MULTICALL3, contracts: ids.map((id) => ({ address: pc.contract, abi: A, functionName: 'plans', args: [id] } as const)) }) : []
  let buys = 0, spent = 0, running = 0
  for (const r of raw) {
    if (r.status !== 'success') continue
    const p = r.result as RawPlan
    buys += p[7]
    spent += Number(formatUnits(p[12], pc.quote.decimals))
    if (!p[9] && p[6] !== 0) running++
  }
  return { plans: n, buys, spent, running }
}
export function useTotals(pc: PlanChain) {
  return useQuery({ queryKey: ['autopilot-totals', pc.key], queryFn: () => readTotals(pc), enabled: pc.deployed, staleTime: 60_000, refetchInterval: 120_000, retry: 1 })
}

export async function readAllowance(pc: PlanChain, owner: Address): Promise<{ allowance: bigint; balance: bigint }> {
  const c = clientFor(pc.ic)
  const [allowance, balance] = await Promise.all([
    c.readContract({ address: pc.quote.address, abi: erc20Abi, functionName: 'allowance', args: [owner, pc.contract] }),
    c.readContract({ address: pc.quote.address, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }),
  ])
  return { allowance, balance }
}
export function useAllowance(pc: PlanChain, owner: Address | undefined) {
  return useQuery({ queryKey: ['autopilot-allowance', pc.key, owner?.toLowerCase()], queryFn: () => readAllowance(pc, owner!), enabled: pc.deployed && !!owner, staleTime: 10_000, retry: 1 })
}

// The pool a plan trades in: the deepest USDG pool for the stock, if it is deep enough to buy from.
// On Base the pools are quoted in USDC; the quote is whatever the chain's pools carry, so the same function serves both.
export function poolFor(stock: StockToken, pools: Pool[]): Pool | undefined {
  const mine = pools.filter((p) => (p.quote.address.toLowerCase() === USDG.address.toLowerCase() || p.quote.address.toLowerCase() === BASE_INDEX.quote.address.toLowerCase()) && (p.token0.address.toLowerCase() === stock.address.toLowerCase() || p.token1.address.toLowerCase() === stock.address.toLowerCase()))
  return mine.sort((a, b) => b.liquidityUsd - a.liquidityUsd)[0]
}
export const deepEnough = (pool: Pool | undefined) => !!pool && pool.liquidityUsd >= DEEP_POOL_USD

export type NewPlan = { stock: StockToken; pool: Pool; amount: bigint; tip: bigint; interval: number; firstAt: number; buys: number; slippageBps: number; budget: bigint }

const onChain = (ctx: TxCtx, ic: IndexChain): TxCtx => ({ ...ctx, chain: ctx.chain && ctx.chain.id === ic.id ? ctx.chain : ({ id: ic.id, key: ic.key, name: ic.name, chainType: 'EVM', logoURI: '', mainnet: true, metamask: { rpcUrls: ic.rpcUrls, blockExplorerUrls: [ic.explorer] } } as TxCtx['chain']) })

// The allowance is the plan's budget: exact, never unlimited, so the owner always knows the most the
// contract can ever pull. Revoking it ends every plan at once.
async function approveExact(ctx: TxCtx, pc: PlanChain, amount: bigint) {
  ctx.onPhase('approving')
  const hash = await ctx.walletClient.sendTransaction({ account: ctx.account.address, chain: null, to: pc.quote.address, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [pc.contract, amount] }) })
  await waitForTx(onChain(ctx, pc.ic).chain!, hash)
}
export async function setAllowance(ctx0: TxCtx, pc: PlanChain, amount: bigint) {
  const ctx = onChain(ctx0, pc.ic)
  await ensureChainOn(ctx, pc.ic)
  await approveExact(ctx, pc, amount)
  ctx.onPhase('done')
}
export async function createPlan(ctx0: TxCtx, pc: PlanChain, p: NewPlan) {
  const ctx = onChain(ctx0, pc.ic)
  await ensureChainOn(ctx, pc.ic)
  const { allowance } = await readAllowance(pc, ctx.account.address)
  if (allowance < p.budget) await approveExact(ctx, pc, p.budget)
  const data = pc.isCL
    ? encodeFunctionData({ abi: abiCL, functionName: 'createPlan', args: [pc.quote.address, p.stock.address, p.pool.spacing, p.amount, p.tip, p.interval, p.firstAt, p.buys, p.slippageBps] })
    : encodeFunctionData({ abi, functionName: 'createPlan', args: [pc.quote.address, p.stock.address, p.pool.fee, p.amount, p.tip, p.interval, p.firstAt, p.buys, p.slippageBps] })
  return sendTx(ctx, pc.contract, data)
}
export async function setPaused(ctx0: TxCtx, pc: PlanChain, id: bigint, paused: boolean) {
  const ctx = onChain(ctx0, pc.ic)
  await ensureChainOn(ctx, pc.ic)
  return sendTx(ctx, pc.contract, encodeFunctionData({ abi, functionName: 'setPaused', args: [id, paused] }))
}
export async function cancelPlan(ctx0: TxCtx, pc: PlanChain, id: bigint) {
  const ctx = onChain(ctx0, pc.ic)
  await ensureChainOn(ctx, pc.ic)
  return sendTx(ctx, pc.contract, encodeFunctionData({ abi, functionName: 'cancel', args: [id] }))
}
// The owner may run a due plan themselves, with the same price floor the executor gets.
export async function runNow(ctx0: TxCtx, pc: PlanChain, id: bigint) {
  const ctx = onChain(ctx0, pc.ic)
  await ensureChainOn(ctx, pc.ic)
  const floor = await clientFor(pc.ic).readContract({ address: pc.contract, abi, functionName: 'floorOut', args: [id] })
  return sendTx(ctx, pc.contract, encodeFunctionData({ abi, functionName: 'execute', args: [id, floor] }))
}

export const budgetFor = (amount: bigint, tip: bigint, buys: number, months = 12, interval = 2_592_000) => (buys === UNLIMITED ? (amount + tip) * BigInt(Math.max(1, Math.ceil((months * 2_592_000) / interval))) : (amount + tip) * BigInt(buys))
export const fmtUsdg = (v: bigint, d = 2) => `$${Number(formatUnits(v, USDG.decimals)).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`
export const fmtStock = (v: bigint, decimals = 18) => { const n = Number(formatUnits(v, decimals)); return n >= 100 ? n.toFixed(2) : n >= 1 ? n.toFixed(4) : n.toFixed(6) }
export const fmtWhen = (sec: number) => new Date(sec * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
export const explorerAddress = (a: string) => `${EXPLORER}/address/${a}`
