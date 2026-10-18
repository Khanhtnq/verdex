// Vaults without you: target weights over tokenized stocks kept by a contract on Robinhood Chain while the
// owner is away. The contract (contracts/VerdexVaults.sol) values the owner's holdings at the pools' spot
// prices; when any weight has drifted past the threshold and the interval has passed, the executor sells the
// overweight stocks for USDG, buys the underweight ones with the proceeds and sends everything to the owner,
// all inside one transaction with a floor on every leg. This module reads vaults and builds the transactions.
import { useQuery } from '@tanstack/react-query'
import { encodeFunctionData, erc20Abi, formatUnits, isAddress, parseAbi, parseUnits, type Address } from 'viem'
import artifact from '../../contracts/VerdexVaults.json'
import { VAULTS_ADDRESS as BUILT_IN, BASE_VAULTS_ADDRESS as BASE_BUILT_IN } from '../../scripts/vaults-address.mjs'
import type { Asset } from './api'
import { BASE_INDEX, ROBINHOOD_INDEX, type IndexChain } from './indexChains'
import { waitForTx } from './lifi'
import { deepEnough, poolFor } from './autopilot'
import { MULTICALL3, USDG, clientFor, ensureChainOn, sendTx, stockTokensOn, type Pool, type StockToken, type TxCtx } from './pools'

export const VAULTS_ADDRESS = (String(import.meta.env.VITE_VAULTS_ADDRESS ?? '').trim() || BUILT_IN).trim()
export const BASE_VAULTS_ADDRESS = (String(import.meta.env.VITE_BASE_VAULTS_ADDRESS ?? '').trim() || BASE_BUILT_IN).trim()
export const DEPLOYED = isAddress(VAULTS_ADDRESS)
export const CONTRACT = (DEPLOYED ? VAULTS_ADDRESS : '0x0000000000000000000000000000000000000000') as Address
export const abi = parseAbi([
  'constructor(address factory_, address usdg_, address executor_)',
  'function create(address[] tokens,uint24[] fees,uint16[] targets,uint16 thresholdBps,uint32 interval,uint16 maxSlippageBps,uint96 tip) returns (uint256)',
  'function setPaused(uint256 id,bool paused)',
  'function vaultsOf(address owner) view returns (uint256[])',
  'function legs(uint256 id) view returns ((address token,uint24 fee,uint16 targetBps)[])',
  'function vaults(uint256) view returns (address owner,uint16 thresholdBps,uint16 maxSlippageBps,uint32 interval,uint40 lastRun,uint32 runs,bool paused,uint96 tip)',
  'function vaultCount() view returns (uint256)',
  'function value(uint256 id) view returns (uint256[] balances,uint256[] values,uint256 total)',
  'function drift(uint256 id) view returns (uint16)',
  'function isDue(uint256 id) view returns (bool)',
  'function execute(uint256 id) returns (uint256 soldUsdg,uint256 boughtUsdg)',
  'function admin() view returns (address)',
  'function isExecutor(address) view returns (bool)',
  'function setExecutor(address executor,bool allowed)',
  'event VaultCreated(uint256 indexed id,address indexed owner,address[] tokens,uint16[] targets,uint16 thresholdBps,uint32 interval)',
  'event Rebalanced(uint256 indexed id,address indexed executor,uint256 totalUsdg,uint256 soldUsdg,uint256 boughtUsdg,uint256 tip)',
])
export const BYTECODE = artifact.bytecode as `0x${string}`
export const EXPLORER = 'https://robin.etherscan.io'
// The Base contract (contracts/VerdexVaultsCL.sol): Slipstream's tick spacing in place of the fee tier.
export const abiCL = parseAbi([
  'function create(address[] tokens,int24[] tickSpacings,uint16[] targets,uint16 thresholdBps,uint32 interval,uint16 maxSlippageBps,uint96 tip) returns (uint256)',
  'function legs(uint256 id) view returns ((address token,int24 tickSpacing,uint16 targetBps)[])',
])
// Where vaults can live: the chain, its contract, the stablecoin the legs are valued in and the pool interface.
export type VaultChain = { key: 'robinhood' | 'base'; ic: IndexChain; contract: Address; deployed: boolean; isCL: boolean; quote: { address: Address; symbol: string; decimals: number }; source: string }
export const VAULT_CHAINS: VaultChain[] = [
  { key: 'robinhood', ic: ROBINHOOD_INDEX, contract: CONTRACT, deployed: DEPLOYED, isCL: false, quote: USDG, source: 'VerdexVaults.sol' },
  { key: 'base', ic: BASE_INDEX, contract: (isAddress(BASE_VAULTS_ADDRESS) ? BASE_VAULTS_ADDRESS : '0x0000000000000000000000000000000000000000') as Address, deployed: isAddress(BASE_VAULTS_ADDRESS), isCL: true, quote: BASE_INDEX.quote as { address: Address; symbol: string; decimals: number }, source: 'VerdexVaultsCL.sol' },
]
export const vaultChain = (key: string | null | undefined) => VAULT_CHAINS.find((c) => c.key === key) ?? VAULT_CHAINS[0]
export const DEFAULT_TIP = parseUnits('0.10', 6)
export const DEFAULT_SLIPPAGE_BPS = 100
export const THRESHOLDS = [200, 500, 1000] // bps
export const INTERVALS: { key: string; label: string; seconds: number }[] = [{ key: 'day', label: 'Daily at most', seconds: 86_400 }, { key: 'week', label: 'Weekly at most', seconds: 604_800 }, { key: 'month', label: 'Monthly at most', seconds: 2_592_000 }]
export const intervalLabel = (s: number) => INTERVALS.find((x) => x.seconds === s)?.label ?? `Every ${Math.round(s / 3600)} hours at most`

export type Preset = { id: string; name: string; blurb: string; weights: [string, number][] }
export const PRESETS: Preset[] = [
  { id: 'mag7', name: 'Magnificent 7', blurb: 'The seven, one seventh each. Winners get trimmed into the laggards.', weights: [['AAPL', 1], ['MSFT', 1], ['GOOGL', 1], ['AMZN', 1], ['NVDA', 1], ['META', 1], ['TSLA', 1]] },
  { id: 'semis', name: 'Semis', blurb: 'The chip stack, equal weight.', weights: [['NVDA', 1], ['MU', 1], ['AMD', 1], ['TSM', 1], ['INTC', 1]] },
  { id: 'ai', name: 'AI Infrastructure', blurb: 'The chips and the clouds that rent them.', weights: [['NVDA', 2], ['MSFT', 1], ['GOOGL', 1], ['AMZN', 1], ['AMD', 1], ['TSM', 1]] },
  { id: 'frontier', name: 'Frontier', blurb: 'SpaceX, Circle, Strategy, Palantir, Reddit.', weights: [['SPCX', 1], ['CRCL', 1], ['MSTR', 1], ['PLTR', 1], ['RDDT', 1]] },
  { id: 'core', name: 'Core Index', blurb: 'S&P 500 and Nasdaq 100, 60/40.', weights: [['SPY', 3], ['QQQ', 2]] },
]

export type Target = { stock: StockToken; pool: Pool; weight: number }
// A preset over the stocks that have a deep USDG pool today, weights normalised to sum to one.
export function presetTargets(p: Preset, stocks: StockToken[], pools: Pool[]): Target[] {
  const out: Target[] = []
  for (const [ticker, w] of p.weights) {
    const stock = stocks.find((s) => s.ticker === ticker)
    const pool = stock ? poolFor(stock, pools) : undefined
    if (stock && pool && deepEnough(pool)) out.push({ stock, pool, weight: w })
  }
  return normalise(out)
}
export function normalise(ts: Target[]): Target[] {
  const sum = ts.reduce((s, x) => s + x.weight, 0)
  return sum > 0 ? ts.map((x) => ({ ...x, weight: x.weight / sum })) : ts
}
// Weights in bps that sum to exactly 10_000 (the last leg takes the rounding).
export function toBps(ts: Target[]): number[] {
  const bps = ts.map((x) => Math.round(x.weight * 10_000))
  const diff = 10_000 - bps.reduce((s, b) => s + b, 0)
  if (bps.length) bps[bps.length - 1] += diff
  return bps
}

export type OnchainLeg = { token: Address; fee: number; targetBps: number; stock?: StockToken; balance: bigint; valueUsdg: bigint; weightBps: number; allowance: bigint }
export type OnchainVault = {
  id: bigint
  owner: Address
  thresholdBps: number
  maxSlippageBps: number
  interval: number
  lastRun: number
  runs: number
  paused: boolean
  tip: bigint
  legs: OnchainLeg[]
  totalUsdg: bigint
  driftBps: number
  due: boolean
  state: 'active' | 'paused'
}
type RawVault = readonly [Address, number, number, number, number, number, boolean, bigint]
type RawLeg = { token: Address; fee: number; targetBps: number }
const lc = (a: string) => a.toLowerCase()

export async function readVaults(vc: VaultChain, owner: Address, assets: Asset[]): Promise<OnchainVault[]> {
  if (!vc.deployed) return []
  const c = clientFor(vc.ic)
  const CONTRACT = vc.contract
  const ids = [...(await c.readContract({ address: CONTRACT, abi, functionName: 'vaultsOf', args: [owner] }))]
  if (!ids.length) return []
  const raw = await c.multicall({ multicallAddress: MULTICALL3, batchSize: 4096, contracts: ids.flatMap((id) => [
    { address: CONTRACT, abi, functionName: 'vaults', args: [id] } as const,
    { address: CONTRACT, abi: vc.isCL ? abiCL : abi, functionName: 'legs', args: [id] } as const,
    { address: CONTRACT, abi, functionName: 'value', args: [id] } as const,
    { address: CONTRACT, abi, functionName: 'drift', args: [id] } as const,
    { address: CONTRACT, abi, functionName: 'isDue', args: [id] } as const,
  ]) })
  const stocks = stockTokensOn(assets, vc.ic.id)
  const out: OnchainVault[] = []
  for (let i = 0; i < ids.length; i++) {
    const v = raw[i * 5].result as RawVault
    const legs = ((raw[i * 5 + 1].result ?? []) as readonly (RawLeg | { token: Address; tickSpacing: number; targetBps: number })[]).map((l) => ('fee' in l ? l : { token: l.token, fee: l.tickSpacing, targetBps: l.targetBps }) as RawLeg)
    const val = raw[i * 5 + 2].status === 'success' ? (raw[i * 5 + 2].result as readonly [readonly bigint[], readonly bigint[], bigint]) : ([[], [], 0n] as const)
    const driftBps = raw[i * 5 + 3].status === 'success' ? Number(raw[i * 5 + 3].result) : 0
    const due = raw[i * 5 + 4].status === 'success' && (raw[i * 5 + 4].result as boolean)
    const allow = await c.multicall({ multicallAddress: MULTICALL3, batchSize: 4096, contracts: legs.map((l) => ({ address: l.token, abi: erc20Abi, functionName: 'allowance', args: [owner, CONTRACT] } as const)) })
    const total = val[2]
    out.push({
      id: ids[i], owner: v[0], thresholdBps: v[1], maxSlippageBps: v[2], interval: v[3], lastRun: v[4], runs: v[5], paused: v[6], tip: v[7],
      legs: legs.map((l, k) => ({ token: l.token, fee: l.fee, targetBps: l.targetBps, stock: stocks.find((s) => lc(s.address) === lc(l.token)), balance: val[0][k] ?? 0n, valueUsdg: val[1][k] ?? 0n, weightBps: total > 0n ? Number(((val[1][k] ?? 0n) * 10_000n) / total) : 0, allowance: allow[k]?.status === 'success' ? (allow[k].result as bigint) : 0n })),
      totalUsdg: total, driftBps, due, state: v[6] ? 'paused' : 'active',
    })
  }
  return out.reverse()
}
export function useOnchainVaults(vc: VaultChain, owner: Address | undefined, assets: Asset[] | undefined) {
  return useQuery({ queryKey: ['vaults-onchain', vc.key, owner?.toLowerCase()], queryFn: () => readVaults(vc, owner!, assets!), enabled: vc.deployed && !!owner && !!assets, staleTime: 15_000, refetchInterval: 30_000, retry: 1 })
}
export type Totals = { vaults: number; runs: number; active: number }
export async function readTotals(vc: VaultChain): Promise<Totals> {
  if (!vc.deployed) return { vaults: 0, runs: 0, active: 0 }
  const c = clientFor(vc.ic)
  const CONTRACT = vc.contract
  const n = Number(await c.readContract({ address: CONTRACT, abi, functionName: 'vaultCount' }))
  const ids = Array.from({ length: Math.min(n, 400) }, (_, i) => BigInt(n - i))
  const raw = ids.length ? await c.multicall({ multicallAddress: MULTICALL3, batchSize: 4096, contracts: ids.map((id) => ({ address: CONTRACT, abi, functionName: 'vaults', args: [id] } as const)) }) : []
  let runs = 0, active = 0
  for (const r of raw) { if (r.status !== 'success') continue; const v = r.result as RawVault; runs += v[5]; if (!v[6]) active++ }
  return { vaults: n, runs, active }
}
export function useVaultTotals(vc: VaultChain) {
  return useQuery({ queryKey: ['vaults-onchain-totals', vc.key], queryFn: () => readTotals(vc), enabled: vc.deployed, staleTime: 60_000, refetchInterval: 120_000, retry: 1 })
}

const onChain = (ctx: TxCtx, ic: IndexChain): TxCtx => ({ ...ctx, chain: ctx.chain && ctx.chain.id === ic.id ? ctx.chain : ({ id: ic.id, key: ic.key, name: ic.name, chainType: 'EVM', logoURI: '', mainnet: true, metamask: { rpcUrls: ic.rpcUrls, blockExplorerUrls: [ic.explorer] } } as TxCtx['chain']) })

export type NewVault = { targets: Target[]; thresholdBps: number; interval: number; slippageBps: number; tip: bigint }
export async function createVault(ctx0: TxCtx, vc: VaultChain, v: NewVault) {
  const ctx = onChain(ctx0, vc.ic)
  await ensureChainOn(ctx, vc.ic)
  const data = vc.isCL
    ? encodeFunctionData({ abi: abiCL, functionName: 'create', args: [v.targets.map((t) => t.stock.address), v.targets.map((t) => t.pool.spacing), toBps(v.targets), v.thresholdBps, v.interval, v.slippageBps, v.tip] })
    : encodeFunctionData({ abi, functionName: 'create', args: [v.targets.map((t) => t.stock.address), v.targets.map((t) => t.pool.fee), toBps(v.targets), v.thresholdBps, v.interval, v.slippageBps, v.tip] })
  return sendTx(ctx, vc.contract, data)
}
// Approve each stock for exactly what the wallet holds today: the most a rebalance can ever sell of it.
export async function approveHoldings(ctx0: TxCtx, vc: VaultChain, tokens: Address[], onToken?: (i: number) => void) {
  const ctx = onChain(ctx0, vc.ic)
  await ensureChainOn(ctx, vc.ic)
  const c = clientFor(vc.ic)
  const CONTRACT = vc.contract
  for (let i = 0; i < tokens.length; i++) {
    onToken?.(i)
    const bal = await c.readContract({ address: tokens[i], abi: erc20Abi, functionName: 'balanceOf', args: [ctx.account.address] })
    const allowance = await c.readContract({ address: tokens[i], abi: erc20Abi, functionName: 'allowance', args: [ctx.account.address, CONTRACT] })
    if (allowance >= bal) continue
    ctx.onPhase('approving')
    const hash = await ctx.walletClient.sendTransaction({ account: ctx.account.address, chain: null, to: tokens[i], data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [CONTRACT, bal] }) })
    await waitForTx(ctx.chain!, hash)
  }
  ctx.onPhase('done')
}
export async function revokeHoldings(ctx0: TxCtx, vc: VaultChain, tokens: Address[]) {
  const ctx = onChain(ctx0, vc.ic)
  await ensureChainOn(ctx, vc.ic)
  const CONTRACT = vc.contract
  for (const token of tokens) {
    ctx.onPhase('approving')
    const hash = await ctx.walletClient.sendTransaction({ account: ctx.account.address, chain: null, to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [CONTRACT, 0n] }) })
    await waitForTx(ctx.chain!, hash)
  }
  ctx.onPhase('done')
}
export async function setPaused(ctx0: TxCtx, vc: VaultChain, id: bigint, paused: boolean) {
  const ctx = onChain(ctx0, vc.ic)
  await ensureChainOn(ctx, vc.ic)
  return sendTx(ctx, vc.contract, encodeFunctionData({ abi, functionName: 'setPaused', args: [id, paused] }))
}
export async function runNow(ctx0: TxCtx, vc: VaultChain, id: bigint) {
  const ctx = onChain(ctx0, vc.ic)
  await ensureChainOn(ctx, vc.ic)
  return sendTx(ctx, vc.contract, encodeFunctionData({ abi, functionName: 'execute', args: [id] }))
}
export const fmtUsdg = (v: bigint, d = 2) => `$${Number(formatUnits(v, USDG.decimals)).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`
export const fmtWhen = (sec: number) => new Date(sec * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
export const explorerAddress = (a: string) => `${EXPLORER}/address/${a}`
export { deepEnough, poolFor }
