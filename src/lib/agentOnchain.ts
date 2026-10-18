// Agent without you: a budget and rules for the agent, kept by a contract on Robinhood Chain while the owner is
// away. A mandate (contracts/VerdexAgent.sol) names the stocks the agent may trade, the rule it follows, how much
// USDG it may spend in all, per trade and per day, the least time between two trades on the same stock, a floor,
// an expiry and a tip. The executor applies the rule to each stock's move on the day and trades inside the limits;
// the contract refuses anything outside them. This module reads mandates and builds the transactions.
import { useQuery } from '@tanstack/react-query'
import { encodeFunctionData, erc20Abi, formatUnits, isAddress, parseAbi, parseUnits, type Address } from 'viem'
import artifact from '../../contracts/VerdexAgent.json'
import { AGENT_ADDRESS as BUILT_IN } from '../../scripts/agent-address.mjs'
import type { Asset } from './api'
import { ROBINHOOD } from './api'
import { waitForTx } from './lifi'
import { deepEnough, poolFor } from './autopilot'
import { MULTICALL3, USDG, client, ensureChain, sendTx, stockTokens, type Pool, type StockToken, type TxCtx } from './pools'

export const AGENT_ADDRESS = (String(import.meta.env.VITE_AGENT_ADDRESS ?? '').trim() || BUILT_IN).trim()
export const DEPLOYED = isAddress(AGENT_ADDRESS)
export const CONTRACT = (DEPLOYED ? AGENT_ADDRESS : '0x0000000000000000000000000000000000000000') as Address
export const abi = parseAbi([
  'constructor(address factory_, address usdg_, address executor_)',
  'function create(address[] tokens,uint24[] fees,uint8 rule,uint16 param,uint96 budget,uint96 perTrade,uint96 perDay,uint16 maxSlippageBps,uint32 cooldown,uint40 expiresAt,uint96 tip) returns (uint256)',
  'function topUp(uint256 id,uint96 amount)',
  'function setPaused(uint256 id,bool paused)',
  'function close(uint256 id)',
  'function mandatesOf(address owner) view returns (uint256[])',
  'function tokensOf(uint256 id) view returns (address[] tokens,uint24[] fees)',
  'function mandates(uint256) view returns (address owner,uint8 rule,uint16 param,uint16 maxSlippageBps,uint32 cooldown,bool paused,bool closed,uint40 expiresAt,uint96 budget,uint96 perTrade,uint96 perDay,uint96 tip,uint40 dayStart,uint96 spentToday,uint96 spent,uint40 lastTrade,uint96 sold,uint32 trades)',
  'function mandateCount() view returns (uint256)',
  'function lastTradeAt(uint256,address) view returns (uint40)',
  'function check(uint256 id,uint256 i,bool sell,uint256 amountIn) view returns (uint8)',
  'function quoteSpot(uint256 id,uint256 i,bool sell,uint256 amountIn) view returns (uint256)',
  'function floorOut(uint256 id,uint256 i,bool sell,uint256 amountIn) view returns (uint256)',
  'function leftToday(uint256 id) view returns (uint256)',
  'function execute(uint256 id,uint256 i,bool sell,uint256 amountIn,uint256 minOut) returns (uint256)',
  'function admin() view returns (address)',
  'function isExecutor(address) view returns (bool)',
  'function setExecutor(address executor,bool allowed)',
  'event MandateCreated(uint256 indexed id,address indexed owner,address[] tokens,uint8 rule,uint16 param,uint96 budget,uint96 perTrade,uint96 perDay)',
  'event Traded(uint256 indexed id,address indexed executor,address indexed token,bool sell,uint256 amountIn,uint256 amountOut,uint256 tip)',
])
export const BYTECODE = artifact.bytecode as `0x${string}`
export const EXPLORER = 'https://robin.etherscan.io'
export const DEFAULT_TIP = parseUnits('0.10', 6)
export const DEFAULT_SLIPPAGE_BPS = 100

export type Rule = { id: number; key: 'dip' | 'trend' | 'profit' | 'loss' | 'both'; name: string; side: 'buy' | 'sell' | 'both'; verb: string; when: (pct: string) => string; blurb: string }
export const RULES: Rule[] = [
  { id: 0, key: 'dip', name: 'Buy the dips', side: 'buy', verb: 'buys', when: (p) => `a stock is ${p} or more down on the day`, blurb: 'A red day is a buy: when one of the stocks is down by the size you set, the agent buys it with USDG.' },
  { id: 1, key: 'trend', name: 'Buy strength', side: 'buy', verb: 'buys', when: (p) => `a stock is ${p} or more up on the day`, blurb: 'A green day is a buy: when one of the stocks is up by the size you set, the agent buys it with USDG.' },
  { id: 2, key: 'profit', name: 'Take profits', side: 'sell', verb: 'sells', when: (p) => `a stock is ${p} or more up on the day`, blurb: 'A green day is a sale: when one of the stocks you hold is up by the size you set, the agent sells a slice of it for USDG.' },
  { id: 3, key: 'loss', name: 'Cut losses', side: 'sell', verb: 'sells', when: (p) => `a stock is ${p} or more down on the day`, blurb: 'A red day is a sale: when one of the stocks you hold is down by the size you set, the agent sells a slice of it for USDG.' },
  { id: 4, key: 'both', name: 'Both ways', side: 'both', verb: 'buys and sells', when: (p) => `a stock is ${p} or more down (buy) or up (sell)`, blurb: 'Buy the dips and take the profits in one mandate: down by the size you set, the agent buys with USDG; up by it, the agent sells a slice for USDG.' },
]
// Rules v2 live in the same byte the contract stores and never reads: bits 0-2 the rule, bit 3 the window (the last
// hour instead of the day), bits 4-5 a weekly cap as a multiple of the day cap (none, 2x, 3x, 5x), kept by the executor.
export const WEEK_X = [0, 2, 3, 5]
export const decodeRule = (code: number) => ({ base: code & 7, hourly: (code & 8) !== 0, weekX: WEEK_X[(code >> 4) & 3] })
export const encodeRule = (base: number, hourly: boolean, weekX: number) => (base & 7) | (hourly ? 8 : 0) | (Math.max(0, WEEK_X.indexOf(weekX)) << 4)
export const windowPhrase = (hourly: boolean) => (hourly ? 'in the last hour' : 'on the day')
export const ruleFor = (code: number) => RULES.find((r) => r.id === (code & 7))
export const PARAMS = [200, 300, 500, 1000] // bps of a day's move
export const COOLDOWNS: { key: string; label: string; seconds: number }[] = [{ key: '6h', label: '6 hours', seconds: 21_600 }, { key: 'day', label: 'a day', seconds: 86_400 }, { key: '3d', label: '3 days', seconds: 259_200 }, { key: 'week', label: 'a week', seconds: 604_800 }]
export const cooldownLabel = (s: number) => COOLDOWNS.find((x) => x.seconds === s)?.label ?? `${Math.round(s / 3600)} hours`
// 'at most once a day', 'at most every 6 hours': the cooldown as a phrase after 'the same stock'.
export const cooldownPhrase = (s: number) => { const l = cooldownLabel(s); return l.startsWith('a ') ? `at most once ${l}` : `at most every ${l}` }
export const EXPIRIES: { key: string; label: string; seconds: number }[] = [{ key: 'month', label: '30 days', seconds: 30 * 86_400 }, { key: 'quarter', label: '90 days', seconds: 90 * 86_400 }, { key: 'never', label: 'Until closed', seconds: 0 }]
export const BUDGETS = [100, 250, 500, 1000, 2500]
export const PER_TRADES = [25, 50, 100, 250, 500]

export type Pick = { stock: StockToken; pool: Pool }
export type OnchainLeg = { token: Address; fee: number; stock?: StockToken; balance: bigint; allowance: bigint; lastTradeAt: number }
export type OnchainMandate = {
  id: bigint
  owner: Address
  rule: number
  param: number
  maxSlippageBps: number
  cooldown: number
  paused: boolean
  closed: boolean
  expiresAt: number
  budget: bigint
  perTrade: bigint
  perDay: bigint
  tip: bigint
  spentToday: bigint
  spent: bigint
  lastTrade: number
  sold: bigint
  trades: number
  leftToday: bigint
  legs: OnchainLeg[]
  usdgAllowance: bigint
  usdgBalance: bigint
  state: 'active' | 'paused' | 'closed' | 'expired' | 'spent'
}
type RawMandate = readonly [Address, number, number, number, number, boolean, boolean, number, bigint, bigint, bigint, bigint, number, bigint, bigint, number, bigint, number]
const lc = (a: string) => a.toLowerCase()

export async function readMandates(owner: Address, assets: Asset[]): Promise<OnchainMandate[]> {
  if (!DEPLOYED) return []
  const c = client()
  const ids = [...(await c.readContract({ address: CONTRACT, abi, functionName: 'mandatesOf', args: [owner] }))]
  if (!ids.length) return []
  const raw = await c.multicall({ multicallAddress: MULTICALL3, batchSize: 4096, contracts: ids.flatMap((id) => [
    { address: CONTRACT, abi, functionName: 'mandates', args: [id] } as const,
    { address: CONTRACT, abi, functionName: 'tokensOf', args: [id] } as const,
    { address: CONTRACT, abi, functionName: 'leftToday', args: [id] } as const,
  ]) })
  const [usdgAllowance, usdgBalance] = await Promise.all([
    c.readContract({ address: USDG.address, abi: erc20Abi, functionName: 'allowance', args: [owner, CONTRACT] }),
    c.readContract({ address: USDG.address, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }),
  ])
  const stocks = stockTokens(assets)
  const now = Math.floor(Date.now() / 1000)
  const out: OnchainMandate[] = []
  for (let i = 0; i < ids.length; i++) {
    if (raw[i * 3].status !== 'success') continue
    const m = raw[i * 3].result as RawMandate
    const t = (raw[i * 3 + 1].status === 'success' ? raw[i * 3 + 1].result : [[], []]) as readonly [readonly Address[], readonly number[]]
    const leftToday = raw[i * 3 + 2].status === 'success' ? (raw[i * 3 + 2].result as bigint) : 0n
    const per = await c.multicall({ multicallAddress: MULTICALL3, batchSize: 4096, contracts: t[0].flatMap((token) => [
      { address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] } as const,
      { address: token, abi: erc20Abi, functionName: 'allowance', args: [owner, CONTRACT] } as const,
      { address: CONTRACT, abi, functionName: 'lastTradeAt', args: [ids[i], token] } as const,
    ]) })
    const legs: OnchainLeg[] = t[0].map((token, k) => ({ token, fee: t[1][k], stock: stocks.find((s) => lc(s.address) === lc(token)), balance: per[k * 3]?.status === 'success' ? (per[k * 3].result as bigint) : 0n, allowance: per[k * 3 + 1]?.status === 'success' ? (per[k * 3 + 1].result as bigint) : 0n, lastTradeAt: per[k * 3 + 2]?.status === 'success' ? Number(per[k * 3 + 2].result) : 0 }))
    const rule = ruleFor(m[1])
    const state: OnchainMandate['state'] = m[6] ? 'closed' : m[5] ? 'paused' : m[7] !== 0 && now > m[7] ? 'expired' : (rule?.side === 'buy' || (rule?.side === 'both' && legs.every((l) => l.balance === 0n))) && m[8] < 1_000_000n ? 'spent' : 'active'
    out.push({ id: ids[i], owner: m[0], rule: m[1], param: m[2], maxSlippageBps: m[3], cooldown: m[4], paused: m[5], closed: m[6], expiresAt: m[7], budget: m[8], perTrade: m[9], perDay: m[10], tip: m[11], spentToday: m[13], spent: m[14], lastTrade: m[15], sold: m[16], trades: m[17], leftToday, legs, usdgAllowance, usdgBalance, state })
  }
  return out.reverse()
}
export function useOnchainMandates(owner: Address | undefined, assets: Asset[] | undefined) {
  return useQuery({ queryKey: ['agent-onchain', owner?.toLowerCase()], queryFn: () => readMandates(owner!, assets!), enabled: DEPLOYED && !!owner && !!assets, staleTime: 15_000, refetchInterval: 30_000, retry: 1 })
}
export type Totals = { mandates: number; trades: number; active: number; spentUsdg: bigint; soldUsdg: bigint }
export async function readTotals(): Promise<Totals> {
  if (!DEPLOYED) return { mandates: 0, trades: 0, active: 0, spentUsdg: 0n, soldUsdg: 0n }
  const c = client()
  const n = Number(await c.readContract({ address: CONTRACT, abi, functionName: 'mandateCount' }))
  const ids = Array.from({ length: Math.min(n, 400) }, (_, i) => BigInt(n - i))
  const raw = ids.length ? await c.multicall({ multicallAddress: MULTICALL3, batchSize: 4096, contracts: ids.map((id) => ({ address: CONTRACT, abi, functionName: 'mandates', args: [id] } as const)) }) : []
  const now = Math.floor(Date.now() / 1000)
  let trades = 0, active = 0, spentUsdg = 0n, soldUsdg = 0n
  for (const r of raw) { if (r.status !== 'success') continue; const m = r.result as RawMandate; trades += m[17]; spentUsdg += m[14]; soldUsdg += m[16]; if (!m[6] && !m[5] && (m[7] === 0 || now <= m[7])) active++ }
  return { mandates: n, trades, active, spentUsdg, soldUsdg }
}
export function useAgentTotals() {
  return useQuery({ queryKey: ['agent-onchain-totals'], queryFn: readTotals, enabled: DEPLOYED, staleTime: 60_000, refetchInterval: 120_000, retry: 1 })
}

// The mandate's recent trades, from the contract's events.
export type Trade = { id: bigint; token: Address; sell: boolean; amountIn: bigint; amountOut: bigint; tip: bigint; hash: `0x${string}`; block: bigint }
export async function readTrades(ids: bigint[], blocks = 6_048_000n): Promise<Trade[]> {
  if (!DEPLOYED || !ids.length) return []
  const c = client()
  const head = await c.getBlockNumber()
  const logs = await c.getLogs({ address: CONTRACT, event: abi.find((x) => x.type === 'event' && x.name === 'Traded')!, args: { id: ids }, fromBlock: head > blocks ? head - blocks : 0n, toBlock: head })
  return logs.map((l) => { const a = l.args as unknown as { id: bigint; token: Address; sell: boolean; amountIn: bigint; amountOut: bigint; tip: bigint }; return { id: a.id, token: a.token, sell: a.sell, amountIn: a.amountIn, amountOut: a.amountOut, tip: a.tip, hash: l.transactionHash, block: l.blockNumber } }).reverse()
}
export function useTrades(ids: bigint[] | undefined) {
  const key = (ids ?? []).map(String).join(',')
  return useQuery({ queryKey: ['agent-onchain-trades', key], queryFn: () => readTrades(ids!), enabled: DEPLOYED && !!ids && ids.length > 0, staleTime: 30_000, refetchInterval: 60_000, retry: 1 })
}

export type NewMandate = { picks: Pick[]; rule: Rule; hourly: boolean; weekX: number; paramBps: number; budget: bigint; perTrade: bigint; perDay: bigint; slippageBps: number; cooldown: number; expiresIn: number; tip: bigint }
// The USDG a buy mandate needs approved: the budget plus a tip for every trade the budget allows.
export function budgetAllowance(m: { budget: bigint; perTrade: bigint; tip: bigint }) {
  const trades = m.perTrade > 0n ? (m.budget + m.perTrade - 1n) / m.perTrade : 0n
  return m.budget + m.tip * trades
}
export async function createMandate(ctx: TxCtx, m: NewMandate) {
  await ensureChain(ctx)
  const expiresAt = m.expiresIn ? Math.floor(Date.now() / 1000) + m.expiresIn : 0
  const data = encodeFunctionData({ abi, functionName: 'create', args: [m.picks.map((p) => p.stock.address), m.picks.map((p) => p.pool.fee), encodeRule(m.rule.id, m.hourly, m.weekX), m.paramBps, m.budget, m.perTrade, m.perDay, m.slippageBps, m.cooldown, expiresAt, m.tip] })
  return sendTx(ctx, CONTRACT, data)
}
// Approve USDG for exactly what the mandate may spend, on top of what other mandates already have.
export async function approveUsdg(ctx: TxCtx, amount: bigint, additive = true) {
  await ensureChain(ctx)
  const c = client()
  const allowance = await c.readContract({ address: USDG.address, abi: erc20Abi, functionName: 'allowance', args: [ctx.account.address, CONTRACT] })
  const target = additive ? allowance + amount : amount
  if (allowance >= target) { ctx.onPhase('done'); return }
  ctx.onPhase('approving')
  const hash = await ctx.walletClient.sendTransaction({ account: ctx.account.address, chain: null, to: USDG.address, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [CONTRACT, target] }) })
  await waitForTx(ctx.chain ?? ({ id: ROBINHOOD } as never), hash)
  ctx.onPhase('done')
}
// Approve each stock for exactly what the wallet holds today: the most the agent can ever sell of it.
export async function approveHoldings(ctx: TxCtx, tokens: Address[]) {
  await ensureChain(ctx)
  const c = client()
  for (const token of tokens) {
    const bal = await c.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [ctx.account.address] })
    const allowance = await c.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [ctx.account.address, CONTRACT] })
    if (bal === 0n || allowance >= bal) continue
    ctx.onPhase('approving')
    const hash = await ctx.walletClient.sendTransaction({ account: ctx.account.address, chain: null, to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [CONTRACT, bal] }) })
    await waitForTx(ctx.chain ?? ({ id: ROBINHOOD } as never), hash)
  }
  ctx.onPhase('done')
}
export async function revokeAll(ctx: TxCtx, tokens: Address[]) {
  await ensureChain(ctx)
  for (const token of [USDG.address, ...tokens]) {
    ctx.onPhase('approving')
    const hash = await ctx.walletClient.sendTransaction({ account: ctx.account.address, chain: null, to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [CONTRACT, 0n] }) })
    await waitForTx(ctx.chain ?? ({ id: ROBINHOOD } as never), hash)
  }
  ctx.onPhase('done')
}
export async function setPaused(ctx: TxCtx, id: bigint, paused: boolean) {
  await ensureChain(ctx)
  return sendTx(ctx, CONTRACT, encodeFunctionData({ abi, functionName: 'setPaused', args: [id, paused] }))
}
export async function closeMandate(ctx: TxCtx, id: bigint) {
  await ensureChain(ctx)
  return sendTx(ctx, CONTRACT, encodeFunctionData({ abi, functionName: 'close', args: [id] }))
}
export async function topUp(ctx: TxCtx, id: bigint, amount: bigint) {
  await ensureChain(ctx)
  return sendTx(ctx, CONTRACT, encodeFunctionData({ abi, functionName: 'topUp', args: [id, amount] }))
}
export const fmtUsdg = (v: bigint, d = 2) => `$${Number(formatUnits(v, USDG.decimals)).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`
export const fmtWhen = (sec: number) => new Date(sec * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
export const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 ? 1 : 0)}%`
export const explorerAddress = (a: string) => `${EXPLORER}/address/${a}`
export { deepEnough, poolFor }
