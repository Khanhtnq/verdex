// Orders: limit and stop orders on tokenized assets, kept on this device and filled from the user's own
// wallet. An order names an asset, a side, a trigger price and a size. While Verdex is open the price is
// watched; when it crosses the trigger the order is marked triggered, the user is reminded, and one tap
// prices the swap through LI.FI and asks the wallet to confirm it. Nothing is custodial and nothing
// moves before that confirmation.
import { useSyncExternalStore } from 'react'
import { encodeFunctionData, erc20Abi, formatUnits, maxUint256, parseUnits, type Address, type WalletClient } from 'viem'
import type { Chain } from './api'
import { chainMeta, fetchQuoteWithFee, isNative, readAllowance, readBalance, waitForTx, type ChainX } from './lifi'
import { PAY_TOKENS, VERDEX_FEE, tokenPrice, type PlanToken, type Run } from './autoInvest'

export type Side = 'buy' | 'sell'
export type Trigger = 'below' | 'above'
export type Status = 'open' | 'triggered' | 'filled' | 'cancelled' | 'expired'
export type Order = { id: string; owner: Address; ticker: string; name: string; logo?: string; asset: PlanToken; quote: PlanToken; side: Side; trigger: Trigger; price: number; amountUsd?: number; units?: number; expiresAt: number; createdAt: number; status: Status; triggeredAt?: number; lastPrice?: number; fill?: Run }

export const EXPIRIES: { key: string; label: string; ms: number }[] = [
  { key: 'gtc', label: 'Until cancelled', ms: 0 },
  { key: 'day', label: '24 hours', ms: 86_400_000 },
  { key: 'week', label: '7 days', ms: 7 * 86_400_000 },
  { key: 'month', label: '30 days', ms: 30 * 86_400_000 },
]
export const QUOTE_TOKENS = PAY_TOKENS

// What a side and trigger mean, in words.
export const describe = (side: Side, trigger: Trigger) => (side === 'buy' ? (trigger === 'below' ? 'Limit buy' : 'Stop buy') : trigger === 'above' ? 'Limit sell' : 'Stop sell')
export const explain = (side: Side, trigger: Trigger) =>
  side === 'buy' ? (trigger === 'below' ? 'Buys when the price falls to your level or lower.' : 'Buys when the price breaks above your level.') : trigger === 'above' ? 'Sells when the price rises to your level or higher.' : 'Sells when the price falls to your level or lower: a stop-loss.'

// Store, like plans and vaults.
const KEY = 'verdex-orders'
let orders: Order[] = load()
const listeners = new Set<() => void>()
function load(): Order[] {
  try {
    const raw = localStorage.getItem(KEY)
    const parsed = raw ? (JSON.parse(raw) as Order[]) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}
function commit(next: Order[]) {
  orders = next
  try {
    localStorage.setItem(KEY, JSON.stringify(orders))
  } catch {
    /* storage unavailable */
  }
  listeners.forEach((l) => l())
}
export function getOrders() {
  return orders
}
export function useOrders() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => {
        listeners.delete(l)
      }
    },
    () => orders,
    () => orders,
  )
}
export function addOrder(o: Omit<Order, 'id' | 'createdAt' | 'status'>) {
  const full: Order = { ...o, id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, createdAt: Date.now(), status: 'open' }
  commit([full, ...orders])
  return full
}
export function updateOrder(id: string, patch: Partial<Order>) {
  commit(orders.map((o) => (o.id === id ? { ...o, ...patch } : o)))
}
export function removeOrder(id: string) {
  commit(orders.filter((o) => o.id !== id))
}
export const nowMs = () => Date.now()
export const isLive = (o: Order) => o.status === 'open' || o.status === 'triggered'
export const crossed = (o: Order, price: number) => (o.trigger === 'below' ? price <= o.price : price >= o.price)
// Distance from the current price to the trigger, as a signed percentage of the current price.
export const distance = (o: Order, price: number) => ((o.price - price) / price) * 100

// One pass over the live orders: expire the stale ones, mark the crossed ones triggered. Prices are read
// through LI.FI with the snapshot as fallback. Returns the orders that became triggered on this pass.
export async function watch(list: Order[], fallback: Map<string, number>, now = Date.now()): Promise<Order[]> {
  const live = list.filter(isLive)
  const fired: Order[] = []
  const keys = new Map<string, Order[]>()
  for (const o of live) {
    if (o.expiresAt && o.expiresAt <= now && o.status === 'open') {
      updateOrder(o.id, { status: 'expired' })
      continue
    }
    const k = `${o.asset.chainId}:${o.asset.address.toLowerCase()}`
    keys.set(k, [...(keys.get(k) ?? []), o])
  }
  for (const [, group] of keys) {
    let price: number | undefined
    try {
      price = await tokenPrice(group[0].asset)
    } catch {
      price = fallback.get(group[0].ticker)
    }
    if (!(price && price > 0)) continue
    for (const o of group) {
      const patch: Partial<Order> = { lastPrice: price }
      if (o.status === 'open' && crossed(o, price)) {
        patch.status = 'triggered'
        patch.triggeredAt = now
        fired.push({ ...o, ...patch })
      }
      updateOrder(o.id, patch)
    }
  }
  return fired
}

export type Phase = 'idle' | 'switching' | 'pricing' | 'approving' | 'confirming' | 'pending' | 'done' | 'failed'
export const PHASE_LABEL: Record<Phase, string> = { idle: '', switching: 'Switch network in your wallet…', pricing: 'Finding the best route…', approving: 'Approve once in your wallet…', confirming: 'Confirm the fill in your wallet…', pending: 'Waiting for the network…', done: 'Filled', failed: 'Failed' }

// Fill an order: buys spend the quote token for the asset, sells spend the asset for the quote token.
// Non-holders carry the Verdex fee; when the route rejects the fee, the fill still goes through without it.
export async function fillOrder(o: Order, ctx: { walletClient: WalletClient; account: { address: Address; chainId: number }; chains: Chain[]; switchChain: (chainId: number, meta?: ReturnType<typeof chainMeta>) => Promise<void>; holder: boolean; onPhase: (p: Phase) => void }): Promise<Run> {
  const from = o.side === 'buy' ? o.quote : o.asset
  const to = o.side === 'buy' ? o.asset : o.quote
  const chain = ctx.chains.find((c) => c.id === from.chainId) as ChainX | undefined
  if (!chain) throw new Error(`${from.symbol}'s chain is not available right now.`)
  if (ctx.account.chainId !== from.chainId) {
    ctx.onPhase('switching')
    await ctx.switchChain(from.chainId, chainMeta(chain))
  }
  ctx.onPhase('pricing')
  let fromAmount: bigint
  if (o.side === 'buy') {
    const p = await tokenPrice(o.quote).catch(() => 1)
    fromAmount = parseUnits(((o.amountUsd ?? 0) / p).toFixed(Math.min(o.quote.decimals, 8)) as `${number}`, o.quote.decimals)
  } else {
    fromAmount = parseUnits((o.units ?? 0).toFixed(Math.min(o.asset.decimals, 8)) as `${number}`, o.asset.decimals)
    const bal = await readBalance(chain, from.address, ctx.account.address)
    if (fromAmount > bal) fromAmount = bal
  }
  if (fromAmount <= 0n) throw new Error(o.side === 'buy' ? 'The order has no amount.' : `This wallet holds no ${o.asset.symbol} to sell.`)
  const base = { fromChain: from.chainId, toChain: to.chainId, fromToken: from.address, toToken: to.address, fromAmount: fromAmount.toString(), fromAddress: ctx.account.address, slippage: 0.01 }
  const quote = await fetchQuoteWithFee(base, !ctx.holder && VERDEX_FEE > 0 ? VERDEX_FEE : undefined)
  const tx = quote.transactionRequest
  if (!tx) throw new Error('This route cannot be prepared right now. Try again in a moment.')
  if (!isNative(from.address)) {
    const allowance = await readAllowance(chain, from.address as Address, ctx.account.address, quote.estimate.approvalAddress as Address)
    if (allowance < fromAmount) {
      ctx.onPhase('approving')
      const approveHash = await ctx.walletClient.sendTransaction({ account: ctx.account.address, chain: null, to: from.address as Address, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [quote.estimate.approvalAddress as Address, maxUint256] }) })
      await waitForTx(chain, approveHash)
    }
  }
  ctx.onPhase('confirming')
  const hash = await ctx.walletClient.sendTransaction({ account: ctx.account.address, chain: null, to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : undefined, gas: tx.gasLimit ? BigInt(tx.gasLimit) : undefined })
  ctx.onPhase('pending')
  await waitForTx(chain, hash)
  const run: Run = { at: Date.now(), txHash: hash, chainId: from.chainId, fromAmount: fromAmount.toString(), fromSymbol: from.symbol, toAmount: quote.estimate.toAmount, toSymbol: to.symbol, toAmountUsd: quote.estimate.toAmountUSD }
  updateOrder(o.id, { status: 'filled', fill: run })
  ctx.onPhase('done')
  return run
}

// Units of the asset a wallet holds, for sell orders.
export async function heldUnits(chain: ChainX, token: PlanToken, owner: Address) {
  const raw = await readBalance(chain, token.address, owner).catch(() => 0n)
  return Number(formatUnits(raw, token.decimals))
}
