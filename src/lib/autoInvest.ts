// Auto-Invest: recurring buys of tokenized assets, kept on this device and executed from the user's
// own wallet. A plan holds what to buy, what to pay with, how much and how often. When a buy is due
// the app prices it through LI.FI, approves the pay token once if needed, and asks the wallet to
// confirm the swap. Nothing is custodial: funds leave the wallet only inside that confirmed swap.
import { useSyncExternalStore } from 'react'
import { encodeFunctionData, erc20Abi, maxUint256, parseUnits, type Address, type WalletClient } from 'viem'
import { LIFI, ROBINHOOD, lifiInit, type Chain } from './api'
import { chainMeta, fetchQuoteWithFee, isNative, readAllowance, waitForTx, type ChainX, type Quote } from './lifi'
import { VERDEX_TOKEN, readHolding } from './holding'

export { VERDEX_TOKEN }
// Verdex fee on scheduled buys for wallets that do not hold the token, as a fraction. Holders pay none.
export const VERDEX_FEE = Number(import.meta.env.VITE_VERDEX_FEE ?? 0.0025)

export type Cadence = 'day' | 'week' | 'two' | 'month'
export const CADENCES: { key: Cadence; label: string; days: number; perMonth: number }[] = [
  { key: 'day', label: 'Every day', days: 1, perMonth: 30 },
  { key: 'week', label: 'Every week', days: 7, perMonth: 52 / 12 },
  { key: 'two', label: 'Every two weeks', days: 14, perMonth: 26 / 12 },
  { key: 'month', label: 'Every month', days: 30, perMonth: 1 },
]
export type PlanToken = { chainId: number; address: string; symbol: string; decimals: number; issuer?: string }
export type Run = { at: number; txHash: string; chainId: number; fromAmount: string; fromSymbol: string; toAmount?: string; toSymbol: string; toAmountUsd?: string }
export type Plan = { id: string; owner: Address; ticker: string; name: string; logo?: string; target: PlanToken; pay: PlanToken; amountUsd: number; cadence: Cadence; nextRunAt: number; createdAt: number; status: 'active' | 'paused'; history: Run[] }

export const PAY_TOKENS: (PlanToken & { chain: string })[] = [
  { chainId: 8453, chain: 'Base', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6 },
  { chainId: 42161, chain: 'Arbitrum', address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', symbol: 'USDC', decimals: 6 },
  { chainId: ROBINHOOD, chain: 'Robinhood Chain', address: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', symbol: 'USDG', decimals: 6 },
  { chainId: 1, chain: 'Ethereum', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', decimals: 6 },
]

// Store: plans live in localStorage, keyed by nothing but filtered by owner when shown.
const KEY = 'verdex-auto-invest-plans'
let plans: Plan[] = load()
const listeners = new Set<() => void>()
function load(): Plan[] {
  try {
    const raw = localStorage.getItem(KEY)
    const parsed = raw ? (JSON.parse(raw) as Plan[]) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}
function commit(next: Plan[]) {
  plans = next
  try {
    localStorage.setItem(KEY, JSON.stringify(plans))
  } catch {
    /* storage unavailable */
  }
  listeners.forEach((l) => l())
}
export function getPlans() {
  return plans
}
export function usePlans() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => {
        listeners.delete(l)
      }
    },
    () => plans,
    () => plans,
  )
}
export function addPlan(plan: Omit<Plan, 'id' | 'createdAt' | 'history' | 'status'>) {
  const full: Plan = { ...plan, id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, createdAt: Date.now(), status: 'active', history: [] }
  commit([full, ...plans])
  return full
}
export function updatePlan(id: string, patch: Partial<Plan>) {
  commit(plans.map((p) => (p.id === id ? { ...p, ...patch } : p)))
}
export function removePlan(id: string) {
  commit(plans.filter((p) => p.id !== id))
}

// Buys land at 09:30 local time on their day. After a run, the next one is the first future date on the cadence.
export function nextRunAfter(from: number, cadence: Cadence) {
  const c = CADENCES.find((x) => x.key === cadence) ?? CADENCES[1]
  const d = new Date(from)
  d.setHours(9, 30, 0, 0)
  do {
    if (c.key === 'month') d.setMonth(d.getMonth() + 1)
    else d.setDate(d.getDate() + c.days)
  } while (d.getTime() <= Date.now())
  return d.getTime()
}
export function upcoming(from: number, cadence: Cadence, n: number) {
  const out: number[] = []
  let t = from
  for (let i = 0; i < n; i++) {
    out.push(t)
    t = nextRunAfter(t, cadence)
  }
  return out
}
export const nowMs = () => Date.now()
export const isDue = (p: Plan, now = Date.now()) => p.status === 'active' && p.nextRunAt <= now
// The next n dates a new plan would buy on, starting with the first scheduled one.
export function schedulePreview(cadence: Cadence, n: number) {
  return upcoming(nextRunAfter(Date.now() - 86_400_000, cadence), cadence, n)
}
// When a new plan's first buy happens: right away, or on the first scheduled date.
export function firstRunAt(buyNow: boolean, cadence: Cadence) {
  return buyNow ? Date.now() : nextRunAfter(Date.now(), cadence)
}

// Holding any amount of VERDEX on Robinhood Chain removes the Verdex fee. Cached per address; the
// balance itself comes from readHolding so every surface agrees on who is a holder.
const holderCache = new Map<string, Promise<boolean>>()
export function isHolder(_chains: Chain[] | undefined, owner: Address) {
  const key = owner.toLowerCase()
  if (!holderCache.has(key)) {
    const promise = readHolding(owner)
      .then((h) => h.holder)
      .catch(() => false)
    holderCache.set(key, promise)
    promise.then((v) => !v && holderCache.delete(key)).catch(() => holderCache.delete(key))
  }
  return holderCache.get(key)!
}

const priceCache = new Map<string, { at: number; price: number }>()
export async function tokenPrice(token: PlanToken) {
  const key = `${token.chainId}:${token.address.toLowerCase()}`
  const hit = priceCache.get(key)
  if (hit && Date.now() - hit.at < 60_000) return hit.price
  const r = await fetch(`${LIFI}/token?chain=${token.chainId}&token=${token.address}`, lifiInit())
  if (!r.ok) throw new Error(`Could not price ${token.symbol} right now.`)
  const j = (await r.json()) as { priceUSD?: string }
  const price = Number(j.priceUSD)
  if (!(price > 0)) throw new Error(`No price for ${token.symbol}.`)
  priceCache.set(key, { at: Date.now(), price })
  return price
}

// Quote for one buy of the plan. Non-holders carry the Verdex fee; if the route rejects the fee, the buy still goes through without it.
export async function quotePlan(plan: Plan, fromAddress: Address, holder: boolean, signal?: AbortSignal): Promise<{ quote: Quote; fromAmount: string }> {
  const price = await tokenPrice(plan.pay)
  const units = (plan.amountUsd / price).toFixed(Math.min(plan.pay.decimals, 8))
  const fromAmount = parseUnits(units as `${number}`, plan.pay.decimals).toString()
  const base = { fromChain: plan.pay.chainId, toChain: plan.target.chainId, fromToken: plan.pay.address, toToken: plan.target.address, fromAmount, fromAddress, slippage: 0.01, signal }
  const quote = await fetchQuoteWithFee(base, !holder && VERDEX_FEE > 0 ? VERDEX_FEE : undefined)
  return { quote, fromAmount }
}

export type Phase = 'idle' | 'switching' | 'pricing' | 'approving' | 'confirming' | 'pending' | 'done' | 'failed'
export const PHASE_LABEL: Record<Phase, string> = { idle: '', switching: 'Switch network in your wallet…', pricing: 'Finding the best route…', approving: 'Approve once in your wallet…', confirming: 'Confirm the buy in your wallet…', pending: 'Waiting for the network…', done: 'Bought', failed: 'Failed' }

export async function executePlan(plan: Plan, ctx: { walletClient: WalletClient; account: { address: Address; chainId: number }; chains: Chain[]; switchChain: (chainId: number, meta?: ReturnType<typeof chainMeta>) => Promise<void>; holder: boolean; onPhase: (p: Phase) => void }): Promise<Run> {
  const chain = ctx.chains.find((c) => c.id === plan.pay.chainId) as ChainX | undefined
  if (!chain) throw new Error(`${plan.pay.symbol}'s chain is not available right now.`)
  if (ctx.account.chainId !== plan.pay.chainId) {
    ctx.onPhase('switching')
    await ctx.switchChain(plan.pay.chainId, chainMeta(chain))
  }
  ctx.onPhase('pricing')
  const { quote, fromAmount } = await quotePlan(plan, ctx.account.address, ctx.holder)
  const tx = quote.transactionRequest
  if (!tx) throw new Error('This route cannot be prepared right now. Try again in a moment.')
  if (!isNative(plan.pay.address)) {
    const allowance = await readAllowance(chain, plan.pay.address as Address, ctx.account.address, quote.estimate.approvalAddress as Address)
    if (allowance < BigInt(fromAmount)) {
      ctx.onPhase('approving')
      const approveHash = await ctx.walletClient.sendTransaction({ account: ctx.account.address, chain: null, to: plan.pay.address as Address, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [quote.estimate.approvalAddress as Address, maxUint256] }) })
      await waitForTx(chain, approveHash)
    }
  }
  ctx.onPhase('confirming')
  const hash = await ctx.walletClient.sendTransaction({ account: ctx.account.address, chain: null, to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : undefined, gas: tx.gasLimit ? BigInt(tx.gasLimit) : undefined })
  ctx.onPhase('pending')
  await waitForTx(chain, hash)
  const run: Run = { at: Date.now(), txHash: hash, chainId: plan.pay.chainId, fromAmount, fromSymbol: plan.pay.symbol, toAmount: quote.estimate.toAmount, toSymbol: plan.target.symbol, toAmountUsd: quote.estimate.toAmountUSD }
  updatePlan(plan.id, { nextRunAt: nextRunAfter(Date.now(), plan.cadence), history: [run, ...plan.history].slice(0, 200) })
  ctx.onPhase('done')
  return run
}

export async function askNotifications() {
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'default') return
    await Notification.requestPermission()
  } catch {
    /* not supported */
  }
}
