// Verdex Vaults: a target allocation across tokenized assets, held in the user's own wallet and kept on
// target by rebalances the wallet confirms. A vault is a list of assets with weights, a chain, a quote
// token to fund it with, and a rebalance rule (a schedule, a drift threshold, or both). Balances and
// prices are read live; when the vault drifts past its threshold or its date comes, the app plans the
// trades (sell overweight, buy underweight), prices each through LI.FI, and asks the wallet to confirm
// them one by one. Nothing is custodial: tokens sit in the wallet the whole time.
import { useSyncExternalStore } from 'react'
import { encodeFunctionData, erc20Abi, formatUnits, maxUint256, parseUnits, type Address, type WalletClient } from 'viem'
import { ROBINHOOD, type Asset, type Chain } from './api'
import { chainMeta, fetchQuoteWithFee, isNative, readAllowance, readBalance, waitForTx, type ChainX } from './lifi'
import { PAY_TOKENS, VERDEX_FEE, tokenPrice, type PlanToken } from './autoInvest'

export type VaultAsset = { ticker: string; name: string; logo?: string; token: PlanToken; weight: number }
export type Rule = 'week' | 'month' | 'quarter' | 'drift'
export const RULES: { key: Rule; label: string; days: number; note: string }[] = [
  { key: 'week', label: 'Every week', days: 7, note: 'Rebalance on a fixed weekly date.' },
  { key: 'month', label: 'Every month', days: 30, note: 'Rebalance on a fixed monthly date.' },
  { key: 'quarter', label: 'Every quarter', days: 91, note: 'Rebalance four times a year.' },
  { key: 'drift', label: 'When it drifts', days: 0, note: 'Rebalance only when an asset is off target by more than the threshold.' },
]
export const THRESHOLDS = [2, 5, 10]
export type Trade = { at: number; txHash: string; chainId: number; side: 'buy' | 'sell'; ticker: string; usd: number; fromSymbol: string; toSymbol: string; fromAmount: string; toAmount?: string }
export type Rebalance = { at: number; trades: Trade[]; driftBefore: number }
// A vault that follows a published strategy remembers which version of it the weights came from.
export type Follow = { id: string; version: number; manager: string; name: string }
export type Vault = { id: string; owner: Address; name: string; template?: string; chainId: number; quote: PlanToken; assets: VaultAsset[]; rule: Rule; threshold: number; nextRunAt: number; createdAt: number; status: 'active' | 'paused'; funded: number; history: Rebalance[]; follow?: Follow; sharedBy?: string }

// Curated allocations. Each is built from the assets available on the chosen chain at creation time; a
// ticker the chain does not carry is dropped and the remaining weights are renormalised.
export type Template = { id: string; name: string; tagline: string; about: string; weights: [string, number][]; rule: Rule; threshold: number }
export const TEMPLATES: Template[] = [
  { id: 'mag7', name: 'Magnificent 7', tagline: 'The seven megacaps, equal weight.', about: 'Apple, Microsoft, Alphabet, Amazon, NVIDIA, Meta and Tesla at one seventh each. Equal weight means the winners get trimmed into the laggards on every rebalance.', weights: [['AAPL', 1], ['MSFT', 1], ['GOOGL', 1], ['AMZN', 1], ['NVDA', 1], ['META', 1], ['TSLA', 1]], rule: 'month', threshold: 5 },
  { id: 'ai', name: 'AI Leaders', tagline: 'Chips, cloud and the labs that buy them.', about: 'Overweight the picks and shovels of the AI build-out: NVIDIA, Broadcom, AMD, TSMC, Micron, Microsoft, Alphabet and Palantir.', weights: [['NVDA', 25], ['AVGO', 15], ['AMD', 12], ['TSM', 12], ['MU', 10], ['MSFT', 10], ['GOOGL', 8], ['PLTR', 8]], rule: 'month', threshold: 5 },
  { id: 'core', name: 'Core Index', tagline: 'Two indexes, one line.', about: 'S&P 500 and Nasdaq 100 exposure through SPY and QQQ, with a slice of short Treasuries to rebalance from when equities run.', weights: [['SPY', 50], ['QQQ', 30], ['SGOV', 20]], rule: 'quarter', threshold: 5 },
  { id: 'balanced', name: 'Balanced 60/40', tagline: 'Equities and Treasuries, classic split.', about: 'Sixty percent broad equities through SPY and QQQ, forty percent in the short Treasury ETF. Rebalancing sells whichever side ran and buys the other.', weights: [['SPY', 40], ['QQQ', 20], ['SGOV', 40]], rule: 'quarter', threshold: 5 },
  { id: 'hard', name: 'Hard Assets', tagline: 'Silver, oil and the miners of bitcoin.', about: 'Silver through SLV, oil through USO, and bitcoin exposure through MicroStrategy and Coinbase, rebalanced as each cycle turns.', weights: [['SLV', 35], ['USO', 25], ['MSTR', 25], ['COIN', 15]], rule: 'month', threshold: 10 },
  { id: 'space', name: 'Space and Frontier', tagline: 'Launch, satellites and quantum.', about: 'SpaceX, Rocket Lab, AST SpaceMobile, Intuitive Machines, plus IonQ and Rigetti. High dispersion, so a tighter drift rule keeps the weights honest.', weights: [['SPCX', 30], ['RKLB', 20], ['ASTS', 15], ['LUNR', 10], ['IONQ', 15], ['RGTI', 10]], rule: 'drift', threshold: 10 },
]

export const QUOTE_TOKENS = PAY_TOKENS
export const MAX_ASSETS = 12

// Store: vaults live in localStorage, filtered by owner when shown.
const KEY = 'verdex-vaults'
let vaults: Vault[] = load()
const listeners = new Set<() => void>()
function load(): Vault[] {
  try {
    const raw = localStorage.getItem(KEY)
    const parsed = raw ? (JSON.parse(raw) as Vault[]) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}
function commit(next: Vault[]) {
  vaults = next
  try {
    localStorage.setItem(KEY, JSON.stringify(vaults))
  } catch {
    /* storage unavailable */
  }
  listeners.forEach((l) => l())
}
export function getVaults() {
  return vaults
}
export function useVaults() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => {
        listeners.delete(l)
      }
    },
    () => vaults,
    () => vaults,
  )
}
export function addVault(v: Omit<Vault, 'id' | 'createdAt' | 'history' | 'status' | 'funded'>) {
  const full: Vault = { ...v, id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, createdAt: Date.now(), status: 'active', funded: 0, history: [] }
  commit([full, ...vaults])
  return full
}
export function updateVault(id: string, patch: Partial<Vault>) {
  commit(vaults.map((v) => (v.id === id ? { ...v, ...patch } : v)))
}
export function removeVault(id: string) {
  commit(vaults.filter((v) => v.id !== id))
}

// Rebalances land at 09:30 local time on their day. Drift-only vaults have no date.
export function nextRunAfter(from: number, rule: Rule) {
  const r = RULES.find((x) => x.key === rule) ?? RULES[1]
  if (r.key === 'drift') return Number.MAX_SAFE_INTEGER
  const d = new Date(from)
  d.setHours(9, 30, 0, 0)
  do {
    if (r.key === 'month') d.setMonth(d.getMonth() + 1)
    else if (r.key === 'quarter') d.setMonth(d.getMonth() + 3)
    else d.setDate(d.getDate() + r.days)
  } while (d.getTime() <= Date.now())
  return d.getTime()
}
export const nowMs = () => Date.now()
// The date a new vault on this rule would first rebalance on.
export const nextScheduled = (rule: Rule) => nextRunAfter(Date.now(), rule)
export const hasDate = (v: Vault) => v.nextRunAt < Number.MAX_SAFE_INTEGER
export const isDateDue = (v: Vault, now = Date.now()) => v.status === 'active' && v.nextRunAt <= now

// Normalise weights to percentages that sum to 100.
export function normalise(assets: VaultAsset[]): VaultAsset[] {
  const total = assets.reduce((s, a) => s + Math.max(0, a.weight), 0)
  if (!(total > 0)) return assets.map((a) => ({ ...a, weight: 100 / assets.length }))
  return assets.map((a) => ({ ...a, weight: (Math.max(0, a.weight) / total) * 100 }))
}

// Build a template's assets from what the chain carries.
export function templateAssets(tpl: Template, assets: Asset[], chainId: number): VaultAsset[] {
  const out: VaultAsset[] = []
  for (const [ticker, w] of tpl.weights) {
    const a = assets.find((x) => x.ticker === ticker)
    const v = a?.tokens.find((tk) => tk.chainId === chainId)
    if (!a || !v) continue
    out.push({ ticker: a.ticker, name: a.name, logo: a.logo, token: { chainId: v.chainId, address: v.address, symbol: v.symbol, decimals: v.decimals, issuer: v.issuer }, weight: w })
  }
  return normalise(out)
}
export function toVaultAsset(a: Asset, chainId: number, weight: number): VaultAsset | undefined {
  const v = a.tokens.find((tk) => tk.chainId === chainId)
  if (!v) return undefined
  return { ticker: a.ticker, name: a.name, logo: a.logo, token: { chainId: v.chainId, address: v.address, symbol: v.symbol, decimals: v.decimals, issuer: v.issuer }, weight }
}

// Live state of a vault: what the wallet holds of each asset, at today's prices, against the targets.
export type Holding = VaultAsset & { units: number; price: number; usd: number; actual: number; drift: number }
export type VaultState = { holdings: Holding[]; total: number; quoteUnits: number; quoteUsd: number; maxDrift: number; at: number }

export async function readVault(v: Vault, chain: ChainX, fallbackPrices?: Map<string, number>): Promise<VaultState> {
  const price = async (tk: PlanToken, key: string) => {
    try {
      return await tokenPrice(tk)
    } catch {
      const f = fallbackPrices?.get(key)
      if (f && f > 0) return f
      throw new Error(`No price for ${tk.symbol}.`)
    }
  }
  const rows = await Promise.all(
    v.assets.map(async (a) => {
      const [raw, p] = await Promise.all([readBalance(chain, a.token.address, v.owner).catch(() => 0n), price(a.token, a.ticker)])
      const units = Number(formatUnits(raw, a.token.decimals))
      return { ...a, units, price: p, usd: units * p }
    }),
  )
  const quoteRaw = await readBalance(chain, v.quote.address, v.owner).catch(() => 0n)
  const quoteUnits = Number(formatUnits(quoteRaw, v.quote.decimals))
  const quotePrice = await price(v.quote, v.quote.symbol).catch(() => 1)
  const total = rows.reduce((s, r) => s + r.usd, 0)
  const holdings: Holding[] = rows.map((r) => {
    const actual = total > 0 ? (r.usd / total) * 100 : 0
    return { ...r, actual, drift: actual - r.weight }
  })
  const maxDrift = holdings.reduce((m, h) => Math.max(m, Math.abs(h.drift)), 0)
  return { holdings, total, quoteUnits, quoteUsd: quoteUnits * quotePrice, maxDrift, at: Date.now() }
}

// Whether the vault needs attention now: its date has come, or it drifted past the threshold.
export function isDue(v: Vault, state: VaultState | undefined, now = Date.now()) {
  if (v.status !== 'active') return false
  if (isDateDue(v, now)) return true
  return !!state && state.total > 0 && state.maxDrift > v.threshold
}

// Planned trades to bring the vault back to target. Overweight assets are sold to the quote token,
// then underweight ones are bought with it. Extra quote (a deposit) is spread by target weight.
export type PlannedTrade = { side: 'buy' | 'sell'; asset: VaultAsset; usd: number }
export const MIN_TRADE_USD = 2
export function planRebalance(state: VaultState, depositUsd = 0): PlannedTrade[] {
  const total = state.total + depositUsd
  if (!(total > 0)) return []
  const trades: PlannedTrade[] = []
  for (const h of state.holdings) {
    const target = (h.weight / 100) * total
    const delta = target - h.usd
    if (Math.abs(delta) < MIN_TRADE_USD) continue
    trades.push({ side: delta > 0 ? 'buy' : 'sell', asset: h, usd: Math.abs(delta) })
  }
  // Sells first so the quote token is there for the buys; largest first inside each side.
  return trades.sort((a, b) => (a.side === b.side ? b.usd - a.usd : a.side === 'sell' ? -1 : 1))
}

export type Phase = 'idle' | 'switching' | 'reading' | 'pricing' | 'approving' | 'confirming' | 'pending' | 'done' | 'failed'
export const PHASE_LABEL: Record<Phase, string> = { idle: '', switching: 'Switch network in your wallet…', reading: 'Reading balances…', pricing: 'Finding the best route…', approving: 'Approve once in your wallet…', confirming: 'Confirm the trade in your wallet…', pending: 'Waiting for the network…', done: 'Rebalanced', failed: 'Failed' }
export type Progress = { phase: Phase; step: number; steps: number; trade?: PlannedTrade; error?: string }

// Execute a planned rebalance trade by trade. Each trade is a LI.FI swap on the vault's chain, approved
// once per token, confirmed in the wallet. Non-holders carry the Verdex fee; when the route rejects it,
// the trade still goes through without it.
export async function executeRebalance(v: Vault, trades: PlannedTrade[], ctx: { walletClient: WalletClient; account: { address: Address; chainId: number }; chain: ChainX; switchChain: (chainId: number, meta?: ReturnType<typeof chainMeta>) => Promise<void>; holder: boolean; driftBefore: number; onProgress: (p: Progress) => void }): Promise<Rebalance> {
  const steps = trades.length
  if (ctx.account.chainId !== v.chainId) {
    ctx.onProgress({ phase: 'switching', step: 0, steps })
    await ctx.switchChain(v.chainId, chainMeta(ctx.chain))
  }
  const done: Trade[] = []
  const record = () => {
    const rb: Rebalance = { at: Date.now(), trades: done, driftBefore: ctx.driftBefore }
    updateVault(v.id, { history: [rb, ...v.history].slice(0, 100), ...(hasDate(v) ? { nextRunAt: nextRunAfter(Date.now(), v.rule) } : {}) })
    return rb
  }
  for (let i = 0; i < trades.length; i++) {
    const tr = trades[i]
    const step = i + 1
    try {
      ctx.onProgress({ phase: 'pricing', step, steps, trade: tr })
      const from = tr.side === 'sell' ? tr.asset.token : v.quote
      const to = tr.side === 'sell' ? v.quote : tr.asset.token
      const price = await tokenPrice(from)
      const units = (tr.usd / price).toFixed(Math.min(from.decimals, 8))
      let fromAmount = parseUnits(units as `${number}`, from.decimals)
      if (tr.side === 'sell') {
        // Never sell more than the wallet holds; rounding can push the plan a hair past the balance.
        const bal = await readBalance(ctx.chain, from.address, ctx.account.address)
        if (fromAmount > bal) fromAmount = bal
      }
      if (fromAmount <= 0n) continue
      const base = { fromChain: v.chainId, toChain: v.chainId, fromToken: from.address, toToken: to.address, fromAmount: fromAmount.toString(), fromAddress: ctx.account.address, slippage: 0.01 }
      const quote = await fetchQuoteWithFee(base, !ctx.holder && VERDEX_FEE > 0 ? VERDEX_FEE : undefined)
      const tx = quote.transactionRequest
      if (!tx) throw new Error('This route cannot be prepared right now. Try again in a moment.')
      if (!isNative(from.address)) {
        const allowance = await readAllowance(ctx.chain, from.address as Address, ctx.account.address, quote.estimate.approvalAddress as Address)
        if (allowance < fromAmount) {
          ctx.onProgress({ phase: 'approving', step, steps, trade: tr })
          const approveHash = await ctx.walletClient.sendTransaction({ account: ctx.account.address, chain: null, to: from.address as Address, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [quote.estimate.approvalAddress as Address, maxUint256] }) })
          await waitForTx(ctx.chain, approveHash)
        }
      }
      ctx.onProgress({ phase: 'confirming', step, steps, trade: tr })
      const hash = await ctx.walletClient.sendTransaction({ account: ctx.account.address, chain: null, to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : undefined, gas: tx.gasLimit ? BigInt(tx.gasLimit) : undefined })
      ctx.onProgress({ phase: 'pending', step, steps, trade: tr })
      await waitForTx(ctx.chain, hash)
      done.push({ at: Date.now(), txHash: hash, chainId: v.chainId, side: tr.side, ticker: tr.asset.ticker, usd: tr.usd, fromSymbol: from.symbol, toSymbol: to.symbol, fromAmount: fromAmount.toString(), toAmount: quote.estimate.toAmount })
    } catch (e) {
      // Keep what went through; the rest of the plan can be run again from the card.
      if (done.length) record()
      throw e
    }
  }
  const rb = record()
  ctx.onProgress({ phase: 'done', step: steps, steps })
  return rb
}

// Defaults for a new vault on Robinhood Chain, funded with USDG.
export const DEFAULT_CHAIN = ROBINHOOD
export const defaultQuote = (chainId: number) => QUOTE_TOKENS.find((q) => q.chainId === chainId) ?? QUOTE_TOKENS[2]
export const chainsWithQuote = (chains: Chain[] | undefined) => QUOTE_TOKENS.filter((q) => chains?.some((c) => c.id === q.chainId && c.chainType === 'EVM'))
