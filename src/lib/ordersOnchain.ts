// Orders without you: limit and stop orders that live in a contract on Robinhood Chain and fill while the
// owner is away. The contract (contracts/VerdexOrders.sol) keeps the order's price level as the pool's own
// sqrtPriceX96; when the pool is at or past it, an executor fills the order from the owner's allowance,
// sends the proceeds to the owner and takes a small USDG tip. This module converts dollar levels to the
// pool's terms, reads orders and builds the transactions.
import { useQuery } from '@tanstack/react-query'
import { encodeFunctionData, erc20Abi, formatUnits, isAddress, parseAbi, parseUnits, type Address } from 'viem'
import artifact from '../../contracts/VerdexOrders.json'
import { ORDERS_ADDRESS as BUILT_IN, BASE_ORDERS_ADDRESS as BASE_BUILT_IN } from '../../scripts/orders-address.mjs'
import type { Asset } from './api'
import { waitForTx } from './lifi'
import { deepEnough, poolFor } from './autopilot'
import { BASE_INDEX, ROBINHOOD_INDEX, type IndexChain } from './indexChains'
import { MULTICALL3, USDG, clientFor, ensureChainOn, sendTx, stockPriceToRaw, stockTokensOn, type Pool, type StockToken, type TxCtx } from './pools'

export const ORDERS_ADDRESS = (String(import.meta.env.VITE_ORDERS_ADDRESS ?? '').trim() || BUILT_IN).trim()
export const BASE_ORDERS_ADDRESS = (String(import.meta.env.VITE_BASE_ORDERS_ADDRESS ?? '').trim() || BASE_BUILT_IN).trim()
export const DEPLOYED = isAddress(ORDERS_ADDRESS)
export const CONTRACT = (DEPLOYED ? ORDERS_ADDRESS : '0x0000000000000000000000000000000000000000') as Address
export const abi = parseAbi([
  'constructor(address factory_, address usdg_, address executor_)',
  'function place(address tokenIn,address tokenOut,uint24 fee,uint96 amountIn,uint96 tip,uint160 trigger,bool whenAtOrBelow,uint16 maxSlippageBps,uint40 expiresAt) returns (uint256)',
  'function cancel(uint256 id)',
  'function ordersOf(address owner) view returns (uint256[])',
  'function orders(uint256) view returns (address owner,address tokenIn,address tokenOut,uint24 fee,uint160 trigger,bool whenAtOrBelow,uint16 maxSlippageBps,uint40 expiresAt,uint8 status,uint96 amountIn,uint96 tip,uint128 received,uint40 filledAt)',
  'function orderCount() view returns (uint256)',
  'function isTriggered(uint256 id) view returns (bool)',
  'function isDue(uint256 id) view returns (bool)',
  'function poolPrice(uint256 id) view returns (uint160)',
  'function quoteSpot(uint256 id) view returns (uint256)',
  'function floorOut(uint256 id) view returns (uint256)',
  'function execute(uint256 id,uint256 minOut) returns (uint256)',
  'function admin() view returns (address)',
  'function isExecutor(address) view returns (bool)',
  'function setExecutor(address executor,bool allowed)',
  'event Placed(uint256 indexed id,address indexed owner,address tokenIn,address tokenOut,uint24 fee,uint96 amountIn,uint160 trigger,bool whenAtOrBelow,uint40 expiresAt)',
  'event Filled(uint256 indexed id,address indexed executor,uint256 amountIn,uint256 amountOut,uint256 tip)',
])
export const BYTECODE = artifact.bytecode as `0x${string}`
export const EXPLORER = 'https://robin.etherscan.io'
// The Base contract (contracts/VerdexOrdersCL.sol) is the same with Slipstream's tick spacing in place of the fee tier.
export const abiCL = parseAbi([
  'constructor(address factory_, address usdg_, address executor_)',
  'function place(address tokenIn,address tokenOut,int24 tickSpacing,uint96 amountIn,uint96 tip,uint160 trigger,bool whenAtOrBelow,uint16 maxSlippageBps,uint40 expiresAt) returns (uint256)',
  'function cancel(uint256 id)',
  'function ordersOf(address owner) view returns (uint256[])',
  'function orders(uint256) view returns (address owner,address tokenIn,address tokenOut,int24 tickSpacing,uint160 trigger,bool whenAtOrBelow,uint16 maxSlippageBps,uint40 expiresAt,uint8 status,uint96 amountIn,uint96 tip,uint128 received,uint40 filledAt)',
  'function orderCount() view returns (uint256)',
  'function isTriggered(uint256 id) view returns (bool)',
  'function isDue(uint256 id) view returns (bool)',
  'function floorOut(uint256 id) view returns (uint256)',
  'function execute(uint256 id,uint256 minOut) returns (uint256)',
  'function admin() view returns (address)',
  'function isExecutor(address) view returns (bool)',
])
// Where orders can live: the chain, its contract, the stablecoin they pay with and the pool interface.
export type OrdersChain = { key: 'robinhood' | 'base'; ic: IndexChain; contract: Address; deployed: boolean; isCL: boolean; quote: { address: Address; symbol: string; decimals: number }; source: string }
export const ORDERS_CHAINS: OrdersChain[] = [
  { key: 'robinhood', ic: ROBINHOOD_INDEX, contract: CONTRACT, deployed: DEPLOYED, isCL: false, quote: USDG, source: 'VerdexOrders.sol' },
  { key: 'base', ic: BASE_INDEX, contract: (isAddress(BASE_ORDERS_ADDRESS) ? BASE_ORDERS_ADDRESS : '0x0000000000000000000000000000000000000000') as Address, deployed: isAddress(BASE_ORDERS_ADDRESS), isCL: true, quote: BASE_INDEX.quote as { address: Address; symbol: string; decimals: number }, source: 'VerdexOrdersCL.sol' },
]
export const ordersChain = (key: string | null | undefined) => ORDERS_CHAINS.find((c) => c.key === key) ?? ORDERS_CHAINS[0]
const abiOf = (oc: OrdersChain) => (oc.isCL ? abiCL : abi)
const tierOf = (oc: OrdersChain, pool: Pool) => (oc.isCL ? pool.spacing : pool.fee)
export const DEFAULT_TIP = parseUnits('0.05', 6)
export const DEFAULT_SLIPPAGE_BPS = 100
export const Q96 = 2n ** 96n

export type Kind = 'limit-buy' | 'stop-sell' | 'take-profit' | 'breakout-buy'
export const KINDS: { key: Kind; label: string; side: 'buy' | 'sell'; below: boolean; blurb: string }[] = [
  { key: 'limit-buy', label: 'Buy below', side: 'buy', below: true, blurb: 'Buy when the price drops to your level.' },
  { key: 'stop-sell', label: 'Stop, sell below', side: 'sell', below: true, blurb: 'Sell if the price falls to your level.' },
  { key: 'take-profit', label: 'Sell above', side: 'sell', below: false, blurb: 'Sell when the price rises to your level.' },
  { key: 'breakout-buy', label: 'Buy above', side: 'buy', below: false, blurb: 'Buy when the price breaks above your level.' },
]

// Integer square root for the trigger: sqrtPriceX96 = sqrt(raw * 2^192).
function isqrt(n: bigint): bigint {
  if (n < 2n) return n
  let x = BigInt(Math.floor(Math.sqrt(Number(n)))) || 1n
  for (let i = 0; i < 256; i++) { const y = (x + n / x) >> 1n; const d = y > x ? y - x : x - y; x = y; if (d <= 1n) break }
  while (x * x > n) x--
  while ((x + 1n) * (x + 1n) <= n) x++
  return x
}
// A dollar price for the stock, as the pool's sqrtPriceX96, and the comparison direction for "at or below that price".
export function triggerFor(pool: Pool, priceUsd: number, belowPrice: boolean): { trigger: bigint; whenAtOrBelow: boolean } {
  const raw = stockPriceToRaw(pool, priceUsd) // token1 per token0, raw units
  const SCALE = 10n ** 18n
  const rawScaled = BigInt(Math.round(raw * 1e18))
  const trigger = isqrt((rawScaled << 192n) / SCALE)
  // When the stock is token0 the pool price rises with the stock; when it is token1 it falls, so the direction flips.
  return { trigger, whenAtOrBelow: pool.stockIsToken0 ? belowPrice : !belowPrice }
}
// The stock's dollar price implied by a pool sqrtPriceX96.
export function priceFromSqrt(pool: Pool, sqrtP: bigint): number {
  const raw = (Number(sqrtP) / 2 ** 96) ** 2 * 10 ** (pool.token0.decimals - pool.token1.decimals)
  return pool.stockIsToken0 ? raw : 1 / raw
}

export type OnchainOrder = {
  id: bigint
  owner: Address
  tokenIn: Address
  tokenOut: Address
  fee: number
  trigger: bigint
  whenAtOrBelow: boolean
  maxSlippageBps: number
  expiresAt: number
  status: 'open' | 'filled' | 'cancelled' | 'expired'
  amountIn: bigint
  tip: bigint
  received: bigint
  filledAt: number
  triggered: boolean
  side: 'buy' | 'sell'
  stock?: StockToken
  pool?: Pool
  levelUsd: number
  kind: Kind
}
export const STATUS_LABEL: Record<OnchainOrder['status'], string> = { open: 'Open', filled: 'Filled', cancelled: 'Cancelled', expired: 'Expired' }
type Raw = readonly [Address, Address, Address, number, bigint, boolean, number, number, number, bigint, bigint, bigint, number]
const lc = (a: string) => a.toLowerCase()

export async function readOrders(oc: OrdersChain, owner: Address, assets: Asset[], pools: Pool[]): Promise<OnchainOrder[]> {
  if (!oc.deployed) return []
  const c = clientFor(oc.ic)
  const A = abiOf(oc) as typeof abi
  const ids = [...(await c.readContract({ address: oc.contract, abi: A, functionName: 'ordersOf', args: [owner] }))]
  if (!ids.length) return []
  const raw = await c.multicall({ multicallAddress: MULTICALL3, batchSize: 4096, contracts: ids.flatMap((id) => [{ address: oc.contract, abi: A, functionName: 'orders', args: [id] } as const, { address: oc.contract, abi: A, functionName: 'isTriggered', args: [id] } as const]) })
  const stocks = stockTokensOn(assets, oc.ic.id)
  const now = Math.floor(Date.now() / 1000)
  return ids.map((id, i) => {
    const r = raw[i * 2].result as Raw
    const [owner_, tokenIn, tokenOut, fee, trigger, whenAtOrBelow, maxSlippageBps, expiresAt, st, amountIn, tip, received, filledAt] = r
    const side: 'buy' | 'sell' = lc(tokenIn) === lc(oc.quote.address) ? 'buy' : 'sell'
    const stockAddr = side === 'buy' ? tokenOut : tokenIn
    const stock = stocks.find((s) => lc(s.address) === lc(stockAddr))
    const pool = pools.find((p) => (oc.isCL ? p.spacing === fee : p.fee === fee) && lc(p.quote.address) === lc(oc.quote.address) && (lc(p.token0.address) === lc(stockAddr) || lc(p.token1.address) === lc(stockAddr)))
    const levelUsd = pool ? priceFromSqrt(pool, trigger) : 0
    const belowPrice = pool ? (pool.stockIsToken0 ? whenAtOrBelow : !whenAtOrBelow) : whenAtOrBelow
    const kind: Kind = side === 'buy' ? (belowPrice ? 'limit-buy' : 'breakout-buy') : belowPrice ? 'stop-sell' : 'take-profit'
    const status: OnchainOrder['status'] = st === 1 ? 'filled' : st === 2 ? 'cancelled' : expiresAt !== 0 && now > expiresAt ? 'expired' : 'open'
    return { id, owner: owner_, tokenIn, tokenOut, fee, trigger, whenAtOrBelow, maxSlippageBps, expiresAt, status, amountIn, tip, received, filledAt, triggered: raw[i * 2 + 1].status === 'success' && (raw[i * 2 + 1].result as boolean), side, stock, pool, levelUsd, kind }
  }).reverse()
}
export function useOrders(oc: OrdersChain, owner: Address | undefined, assets: Asset[] | undefined, pools: Pool[] | undefined) {
  return useQuery({ queryKey: ['orders-onchain', oc.key, owner?.toLowerCase(), pools?.length ?? 0], queryFn: () => readOrders(oc, owner!, assets!, pools!), enabled: oc.deployed && !!owner && !!assets && !!pools, staleTime: 15_000, refetchInterval: 30_000, retry: 1 })
}

export type Totals = { orders: number; open: number; filled: number }
export async function readTotals(oc: OrdersChain): Promise<Totals> {
  if (!oc.deployed) return { orders: 0, open: 0, filled: 0 }
  const c = clientFor(oc.ic)
  const A = abiOf(oc) as typeof abi
  const n = Number(await c.readContract({ address: oc.contract, abi: A, functionName: 'orderCount' }))
  const ids = Array.from({ length: Math.min(n, 400) }, (_, i) => BigInt(n - i))
  const raw = ids.length ? await c.multicall({ multicallAddress: MULTICALL3, batchSize: 4096, contracts: ids.map((id) => ({ address: oc.contract, abi: A, functionName: 'orders', args: [id] } as const)) }) : []
  let open = 0, filled = 0
  for (const r of raw) { if (r.status !== 'success') continue; const st = (r.result as Raw)[8]; if (st === 0) open++; if (st === 1) filled++ }
  return { orders: n, open, filled }
}
export function useTotals(oc: OrdersChain) {
  return useQuery({ queryKey: ['orders-onchain-totals', oc.key], queryFn: () => readTotals(oc), enabled: oc.deployed, staleTime: 60_000, refetchInterval: 120_000, retry: 1 })
}

// Balances and allowances of what open orders need: USDG for buys, each stock for sells.
export type Wallet = { usdg: bigint; usdgAllowance: bigint; tokens: Record<string, { balance: bigint; allowance: bigint }> }
export async function readWallet(oc: OrdersChain, owner: Address, stocks: StockToken[]): Promise<Wallet> {
  const c = clientFor(oc.ic)
  const list = [oc.quote.address, ...stocks.map((s) => s.address)]
  const res = await c.multicall({ multicallAddress: MULTICALL3, batchSize: 4096, contracts: list.flatMap((a) => [{ address: a, abi: erc20Abi, functionName: 'balanceOf', args: [owner] } as const, { address: a, abi: erc20Abi, functionName: 'allowance', args: [owner, oc.contract] } as const]) })
  const v = (k: number) => (res[k].status === 'success' ? (res[k].result as bigint) : 0n)
  const tokens: Wallet['tokens'] = {}
  list.forEach((a, i) => (tokens[lc(a)] = { balance: v(i * 2), allowance: v(i * 2 + 1) }))
  return { usdg: v(0), usdgAllowance: v(1), tokens }
}
export function useOrdersWallet(oc: OrdersChain, owner: Address | undefined, stocks: StockToken[]) {
  return useQuery({ queryKey: ['orders-onchain-wallet', oc.key, owner?.toLowerCase(), stocks.map((s) => s.address).join(',')], queryFn: () => readWallet(oc, owner!, stocks), enabled: oc.deployed && !!owner, staleTime: 10_000, retry: 1 })
}

export { deepEnough, poolFor }
export type NewOrder = { stock: StockToken; pool: Pool; kind: Kind; levelUsd: number; amountIn: bigint; tip: bigint; slippageBps: number; expiresAt: number }

const onChain = (ctx: TxCtx, ic: IndexChain): TxCtx => ({ ...ctx, chain: ctx.chain && ctx.chain.id === ic.id ? ctx.chain : ({ id: ic.id, key: ic.key, name: ic.name, chainType: 'EVM', logoURI: '', mainnet: true, metamask: { rpcUrls: ic.rpcUrls, blockExplorerUrls: [ic.explorer] } } as TxCtx['chain']) })

async function approveExact(ctx: TxCtx, oc: OrdersChain, token: Address, amount: bigint) {
  ctx.onPhase('approving')
  const hash = await ctx.walletClient.sendTransaction({ account: ctx.account.address, chain: null, to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [oc.contract, amount] }) })
  await waitForTx(onChain(ctx, oc.ic).chain!, hash)
}
// Place: an exact allowance for what the fill may pull (amount plus tip on a buy, the stock amount on a sell), then the order.
export async function placeOrder(ctx0: TxCtx, oc: OrdersChain, o: NewOrder) {
  const ctx = onChain(ctx0, oc.ic)
  await ensureChainOn(ctx, oc.ic)
  const k = KINDS.find((x) => x.key === o.kind)!
  const tokenIn = k.side === 'buy' ? oc.quote.address : o.stock.address
  const tokenOut = k.side === 'buy' ? o.stock.address : oc.quote.address
  const need = k.side === 'buy' ? o.amountIn + o.tip : o.amountIn
  const c = clientFor(oc.ic)
  const allowance = await c.readContract({ address: tokenIn, abi: erc20Abi, functionName: 'allowance', args: [ctx.account.address, oc.contract] })
  await approveExact(ctx, oc, tokenIn, allowance + need)
  const { trigger, whenAtOrBelow } = triggerFor(o.pool, o.levelUsd, k.below)
  const data = oc.isCL
    ? encodeFunctionData({ abi: abiCL, functionName: 'place', args: [tokenIn, tokenOut, tierOf(oc, o.pool), o.amountIn, o.tip, trigger, whenAtOrBelow, o.slippageBps, o.expiresAt] })
    : encodeFunctionData({ abi, functionName: 'place', args: [tokenIn, tokenOut, tierOf(oc, o.pool), o.amountIn, o.tip, trigger, whenAtOrBelow, o.slippageBps, o.expiresAt] })
  return sendTx(ctx, oc.contract, data)
}
export async function cancelOrder(ctx0: TxCtx, oc: OrdersChain, id: bigint) {
  const ctx = onChain(ctx0, oc.ic)
  await ensureChainOn(ctx, oc.ic)
  return sendTx(ctx, oc.contract, encodeFunctionData({ abi, functionName: 'cancel', args: [id] }))
}
// The owner may fill a triggered order themselves, with the same floor the executor gets.
export async function fillNow(ctx0: TxCtx, oc: OrdersChain, id: bigint) {
  const ctx = onChain(ctx0, oc.ic)
  await ensureChainOn(ctx, oc.ic)
  const floor = await clientFor(oc.ic).readContract({ address: oc.contract, abi, functionName: 'floorOut', args: [id] })
  return sendTx(ctx, oc.contract, encodeFunctionData({ abi, functionName: 'execute', args: [id, floor] }))
}
export const fmtUsdg = (v: bigint, d = 2) => `$${Number(formatUnits(v, USDG.decimals)).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`
export const fmtStock = (v: bigint, decimals = 18) => { const n = Number(formatUnits(v, decimals)); return n >= 100 ? n.toFixed(2) : n >= 1 ? n.toFixed(4) : n.toFixed(6) }
export const fmtWhen = (sec: number) => new Date(sec * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
export const explorerAddress = (a: string) => `${EXPLORER}/address/${a}`
