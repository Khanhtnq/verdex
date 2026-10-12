// Verdex Index: baskets of tokenized stocks as one ERC-20 each. An index holds a fixed number of units of
// every component per share (contracts/VerdexIndex.sol); the router (contracts/VerdexIndexRouter.sol) buys
// those units with USDG in the stocks' Uniswap v3 pools and issues the shares in one transaction, or
// redeems and sells them back. This module reads the indexes, prices them from the pools, builds the
// transactions and holds the templates the deploy page creates from.
import { useQuery } from '@tanstack/react-query'
import { decodeEventLog, encodeDeployData, encodeFunctionData, erc20Abi, formatUnits, parseAbi, type Address, type ContractFunctionParameters } from 'viem'
import factoryArtifact from '../../contracts/VerdexIndexFactory.json'
import routerArtifact from '../../contracts/VerdexIndexRouter.json'
import routerCLArtifact from '../../contracts/VerdexIndexRouterCL.json'
import type { Asset } from './api'
import { ROBINHOOD_INDEX, legTier, type IndexChain } from './indexChains'
import { waitForTx } from './lifi'
import { deepEnough } from './autopilot'
import { MULTICALL3, USDG, clientFor, ensureChainOn, sendTx, stockTokensOn, type Pool, type StockToken, type TxCtx } from './pools'

// Robinhood Chain, for the modules that only read there (the treasury's fee tally).
export const FACTORY_ADDRESS = ROBINHOOD_INDEX.factoryAddress
export const ROUTER_ADDRESS = ROBINHOOD_INDEX.routerAddress
export const DEPLOYED = ROBINHOOD_INDEX.deployed
const ZERO = '0x0000000000000000000000000000000000000000' as Address
export const FACTORY = ROBINHOOD_INDEX.factory
export const ROUTER = ROBINHOOD_INDEX.router
export const DEAD = '0x000000000000000000000000000000000000dEaD' as Address

export const factoryAbi = parseAbi([
  'function create(string name,string symbol,address[] tokens,uint256[] units,uint256 maxSupply) returns (address)',
  'function all() view returns (address[])',
  'function count() view returns (uint256)',
  'function isIndex(address) view returns (bool)',
  'event IndexCreated(address indexed index,address indexed creator,string name,string symbol,address[] tokens,uint256[] units,uint256 maxSupply)',
])
export const indexAbi = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function totalSupply() view returns (uint256)',
  'function maxSupply() view returns (uint256)',
  'function owner() view returns (address)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function components() view returns (address[] tokens,uint256[] units)',
  'function amountsIn(uint256 shares) view returns (uint256[])',
  'function amountsOut(uint256 shares) view returns (uint256[])',
  'function issue(uint256 shares,address to)',
  'function redeem(uint256 shares,address to)',
  'function approve(address spender,uint256 value) returns (bool)',
  'function setMaxSupply(uint256 maxSupply_)',
])
export const routerAbi = parseAbi([
  'constructor(address factory_,address usdg_,address verdex_,address treasury_,uint16 feeBps_)',
  'function spotIn(address index,uint256 shares,uint24[] fees) view returns (uint256 total,uint256[] perLeg)',
  'function spotOut(address index,uint256 shares,uint24[] fees) view returns (uint256 total,uint256[] perLeg)',
  'function buy(address index,uint256 shares,uint256 maxIn,uint24[] fees,uint256[] maxInPerLeg,address to) returns (uint256)',
  'function sell(address index,uint256 shares,uint256 minOut,uint24[] fees,uint256[] minOutPerLeg,address to) returns (uint256)',
  'function feeBps() view returns (uint16)',
  'function treasury() view returns (address)',
  'function owner() view returns (address)',
  'event Bought(address indexed index,address indexed buyer,address indexed to,uint256 shares,uint256 usdgIn,uint256 fee)',
  'event Sold(address indexed index,address indexed seller,address indexed to,uint256 shares,uint256 usdgOut,uint256 fee)',
])
export const FACTORY_BYTECODE = factoryArtifact.bytecode as `0x${string}`
export const ROUTER_BYTECODE = routerArtifact.bytecode as `0x${string}`
export const ROUTER_CL_BYTECODE = routerCLArtifact.bytecode as `0x${string}`
export const routerBytecodeFor = (ic: IndexChain) => (ic.dex === 'slipstream' ? ROUTER_CL_BYTECODE : ROUTER_BYTECODE)
export const DEFAULT_FEE_BPS = 25
export const DEFAULT_SLIPPAGE_BPS = 100
export const DEFAULT_CAP = 25_000n * 10n ** 18n
const ONE = 10n ** 18n

// The indexes Verdex creates at launch: equal value per component, one share worth one USDG at creation.
export type Template = { name: string; symbol: string; tickers: string[]; blurb: string }
export const TEMPLATES: Template[] = [
  { name: 'Verdex Magnificent Seven', symbol: 'VX7', tickers: ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA'], blurb: 'The seven, equal weight at creation.' },
  { name: 'Verdex AI Infrastructure', symbol: 'VXAI', tickers: ['NVDA', 'MU', 'AMD', 'TSM', 'INTC', 'MSFT', 'GOOGL', 'AMZN'], blurb: 'The chips, the memory, the foundry and the clouds that rent them.' },
  { name: 'Verdex Semis', symbol: 'VXSEMI', tickers: ['NVDA', 'MU', 'AMD', 'TSM', 'INTC'], blurb: 'The chip stack and nothing else.' },
  { name: 'Verdex Frontier', symbol: 'VXFRONT', tickers: ['SPCX', 'CRCL', 'MSTR', 'PLTR', 'RDDT'], blurb: 'SpaceX, Circle, Strategy, Palantir, Reddit.' },
]
// On Base the stocks are Coinbase's, quoted in USDC in Aerodrome pools; fewer names, the same idea.
export const BASE_TEMPLATES: Template[] = [
  { name: 'Verdex Magnificent Seven', symbol: 'VX7', tickers: ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA'], blurb: 'The seven, equal weight at creation.' },
  { name: 'Verdex Frontier', symbol: 'VXFRONT', tickers: ['SPCX', 'MSTR', 'PLTR', 'TSLA'], blurb: 'SpaceX, Strategy, Palantir, Tesla.' },
  { name: 'Verdex AI Infrastructure', symbol: 'VXAI', tickers: ['NVDA', 'MSFT', 'GOOGL', 'AMZN', 'META', 'SNDK'], blurb: 'The chips, the clouds that rent them and the memory they fill.' },
]
export const templatesFor = (ic: IndexChain) => (ic.key === 'base' ? BASE_TEMPLATES : TEMPLATES)
// The indexes Verdex made. Anything else from the factories is a community index, shown with its creator.
export const OFFICIAL_INDEXES = new Set([
  '0x7809595cc37a464e973211eae8bbaffa4c5712d9', '0x5f9850cb867f3d4fbf00ceb25d6e07a2ecd2e697', '0xbdccaa07729fe69ce10177b19c9ba7bb40c57bda', '0x0356b1cbbb5fb810aba76ccf0d2c2f130fa21f87',
  '0x9df7ab3a7b453339e6f5d63db0bef0f362c5a8bc', '0xa9f80aed4aa270c73ce65b3fb979b05898f88bf1', '0x571c69aead2a5dbe7c384a868c8522bf86f94628',
])
export const isOfficial = (a: string) => OFFICIAL_INDEXES.has(a.toLowerCase())
export const COMMUNITY_CAP = 1_000_000n * 10n ** 18n
// Units per share for a basket at the weights given, one share worth one dollar at today's pool prices.
export function planWeights(ic: IndexChain, name: string, symbol: string, wanted: { ticker: string; weight: number }[], stocks: StockToken[], pools: Pool[]): TemplatePlan {
  const sum = wanted.reduce((s, w) => s + w.weight, 0) || 1
  const legs: TemplatePlan['legs'] = []
  const missing: string[] = []
  for (const w of wanted) {
    const stock = stocks.find((s) => s.ticker === w.ticker)
    const pool = stock ? poolForOn(ic, stock, pools) : undefined
    if (!stock || !pool || !deepEnough(pool) || w.weight <= 0) { missing.push(w.ticker); continue }
    const units = BigInt(Math.max(1, Math.round(((w.weight / sum) / pool.priceUsd) * 10 ** stock.decimals)))
    legs.push({ ticker: w.ticker, priceUsd: pool.priceUsd, units, fee: pool.fee, liquidityUsd: pool.liquidityUsd })
  }
  return { name, symbol, tokens: legs.map((l) => stocks.find((s) => s.ticker === l.ticker)!.address), units: legs.map((l) => l.units), legs, missing }
}
// The index a creation transaction made, from its IndexCreated event.
export async function createdIndex(ic: IndexChain, hash: `0x${string}`): Promise<Address | undefined> {
  const r = await clientFor(ic).waitForTransactionReceipt({ hash, timeout: 180_000 })
  const ev = factoryAbi.find((x) => x.type === 'event' && x.name === 'IndexCreated')!
  for (const l of r.logs) { try { const d = decodeEventLog({ abi: [ev], data: l.data, topics: l.topics }); return (d.args as unknown as { index: Address }).index } catch { /* not ours */ } }
  return undefined
}
// The deepest pool in the chain's quote token for a stock.
export function poolForOn(ic: IndexChain, stock: StockToken, pools: Pool[]): Pool | undefined {
  const mine = pools.filter((p) => lc(p.quote.address) === lc(ic.quote.address) && (lc(p.token0.address) === lc(stock.address) || lc(p.token1.address) === lc(stock.address)))
  return mine.sort((a, b) => b.liquidityUsd - a.liquidityUsd)[0]
}

export type IndexComponent = { token: Address; units: bigint; stock?: StockToken; pool?: Pool; priceUsd: number; valueUsd: number; weight: number }
export type IndexInfo = {
  address: Address
  name: string
  symbol: string
  totalSupply: bigint
  maxSupply: bigint
  owner: Address
  components: IndexComponent[]
  navUsd: number // one share, from the pools' spot prices
  tvlUsd: number
  fees: number[] // the router's tier per component: the fee of the deepest quote pool, or its tick spacing on Slipstream
  tradable: boolean // every component has a deep enough quote pool
  chain: IndexChain
}

const lc = (a: string) => a.toLowerCase()

export async function readIndexes(ic: IndexChain, assets: Asset[], pools: Pool[]): Promise<IndexInfo[]> {
  if (!ic.deployed) return []
  const c = clientFor(ic)
  const list = await c.readContract({ address: ic.factory, abi: factoryAbi, functionName: 'all' })
  if (list.length === 0) return []
  const stocks = stockTokensOn(assets, ic.id)
  const byAddr = new Map(stocks.map((s) => [lc(s.address), s]))
  const res = await c.multicall({
    multicallAddress: MULTICALL3,
    batchSize: 4096,
    contracts: list.flatMap((address) => [
      { address, abi: indexAbi, functionName: 'name' as const },
      { address, abi: indexAbi, functionName: 'symbol' as const },
      { address, abi: indexAbi, functionName: 'totalSupply' as const },
      { address, abi: indexAbi, functionName: 'maxSupply' as const },
      { address, abi: indexAbi, functionName: 'owner' as const },
      { address, abi: indexAbi, functionName: 'components' as const },
    ]),
  })
  return list.map((address, i) => {
    const at = <T,>(k: number, fallback: T): T => (res[i * 6 + k].status === 'success' ? (res[i * 6 + k].result as T) : fallback)
    const [tokens, units] = at<readonly [readonly Address[], readonly bigint[]]>(5, [[], []])
    const components: IndexComponent[] = tokens.map((token, k) => {
      const stock = byAddr.get(lc(token))
      const pool = stock ? poolForOn(ic, stock, pools) : undefined
      const priceUsd = pool?.priceUsd ?? 0
      const valueUsd = (Number(formatUnits(units[k], stock?.decimals ?? 18)) * priceUsd)
      return { token, units: units[k], stock, pool, priceUsd, valueUsd, weight: 0 }
    })
    const navUsd = components.reduce((s, x) => s + x.valueUsd, 0)
    for (const x of components) x.weight = navUsd > 0 ? x.valueUsd / navUsd : 0
    const totalSupply = at<bigint>(2, 0n)
    return {
      address,
      name: at<string>(0, 'Index'),
      symbol: at<string>(1, '?'),
      totalSupply,
      maxSupply: at<bigint>(3, 0n),
      owner: at<Address>(4, ZERO),
      components,
      navUsd,
      tvlUsd: navUsd * Number(formatUnits(totalSupply, 18)),
      fees: components.map((x) => (x.pool ? legTier(ic, x.pool) : 0)),
      tradable: components.length > 0 && components.every((x) => deepEnough(x.pool)),
      chain: ic,
    }
  })
}
export function useIndexes(ic: IndexChain, assets: Asset[] | undefined, pools: Pool[] | undefined) {
  return useQuery({ queryKey: ['indexes', ic.key, pools?.length ?? 0], queryFn: () => readIndexes(ic, assets!, pools!), enabled: ic.deployed && !!assets && !!pools, staleTime: 30_000, refetchInterval: 60_000, retry: 1 })
}

export type IndexWallet = { shares: Record<string, bigint>; usdg: bigint; usdgAllowance: bigint; verdex: bigint; feeBps: number }
export async function readWallet(ic: IndexChain, owner: Address, indexes: Address[]): Promise<IndexWallet> {
  const c = clientFor(ic)
  const contracts: ContractFunctionParameters[] = [
    { address: ic.quote.address, abi: erc20Abi, functionName: 'balanceOf', args: [owner] },
    { address: ic.quote.address, abi: erc20Abi, functionName: 'allowance', args: [owner, ic.router] },
    { address: ic.verdex === ZERO ? ic.quote.address : ic.verdex, abi: erc20Abi, functionName: 'balanceOf', args: [ic.verdex === ZERO ? ZERO : owner] },
    { address: ic.router, abi: routerAbi, functionName: 'feeBps' },
    ...indexes.map((address): ContractFunctionParameters => ({ address, abi: indexAbi, functionName: 'balanceOf', args: [owner] })),
  ]
  const res = await c.multicall({ multicallAddress: MULTICALL3, batchSize: 4096, contracts })
  const v = (k: number) => (res[k].status === 'success' ? (res[k].result as bigint) : 0n)
  const shares: Record<string, bigint> = {}
  indexes.forEach((a, i) => (shares[lc(a)] = v(4 + i)))
  return { shares, usdg: v(0), usdgAllowance: v(1), verdex: ic.verdex === ZERO ? 0n : v(2), feeBps: Number(v(3)) }
}
export function useIndexWallet(ic: IndexChain, owner: Address | undefined, indexes: Address[] | undefined) {
  return useQuery({ queryKey: ['index-wallet', ic.key, owner?.toLowerCase(), indexes?.length ?? 0], queryFn: () => readWallet(ic, owner!, indexes!), enabled: ic.deployed && !!owner && !!indexes, staleTime: 10_000, retry: 1 })
}

// Spot quotes from the router: what the pools would charge or pay with no price impact.
export async function quoteBuy(index: IndexInfo, shares: bigint) {
  const [total, perLeg] = await clientFor(index.chain).readContract({ address: index.chain.router, abi: routerAbi, functionName: 'spotIn', args: [index.address, shares, index.fees] })
  return { total, perLeg: [...perLeg] }
}
export async function quoteSell(index: IndexInfo, shares: bigint) {
  const [total, perLeg] = await clientFor(index.chain).readContract({ address: index.chain.router, abi: routerAbi, functionName: 'spotOut', args: [index.address, shares, index.fees] })
  return { total, perLeg: [...perLeg] }
}
export function useQuote(index: IndexInfo | undefined, shares: bigint, side: 'buy' | 'sell') {
  return useQuery({
    queryKey: ['index-quote', index?.chain.key, index?.address, side, shares.toString(), index?.fees.join(',')],
    queryFn: () => (side === 'buy' ? quoteBuy(index!, shares) : quoteSell(index!, shares)),
    enabled: !!index && index.chain.deployed && index.tradable && shares > 0n,
    staleTime: 15_000,
    retry: 1,
  })
}

// Shares a USDG amount buys at the index's spot NAV, rounded to the share's 18 decimals.
export function sharesFor(index: IndexInfo, usdg: bigint): bigint {
  if (index.navUsd <= 0) return 0n
  const usd = Number(formatUnits(usdg, index.chain.quote.decimals))
  return BigInt(Math.floor((usd / index.navUsd) * 1e6)) * 10n ** 12n
}

async function approveExact(ctx: TxCtx, ic: IndexChain, token: Address, spender: Address, amount: bigint) {
  ctx.onPhase('approving')
  const hash = await ctx.walletClient.sendTransaction({ account: ctx.account.address, chain: null, to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] }) })
  await waitForTx(ctx.chain && ctx.chain.id === ic.id ? ctx.chain : ({ id: ic.id, metamask: { rpcUrls: ic.rpcUrls } } as never), hash)
}
// sendTx waits for the receipt on the context's chain; make sure that chain is the index's.
const onChain = (ctx: TxCtx, ic: IndexChain): TxCtx => ({ ...ctx, chain: ctx.chain && ctx.chain.id === ic.id ? ctx.chain : ({ id: ic.id, key: ic.key, name: ic.name, chainType: 'EVM', logoURI: '', mainnet: true, metamask: { rpcUrls: ic.rpcUrls, blockExplorerUrls: [ic.explorer] } } as TxCtx['chain']) })

// Buy: approve exactly what the router may pull (spot plus slippage plus the fee), then one transaction.
export async function buyIndex(ctx0: TxCtx, index: IndexInfo, shares: bigint, quote: { total: bigint; perLeg: bigint[] }, slippageBps: number, feeBps: number) {
  const ic = index.chain, ctx = onChain(ctx0, ic)
  await ensureChainOn(ctx, ic)
  const maxLeg = quote.perLeg.map((v) => (v * BigInt(10_000 + slippageBps)) / 10_000n)
  const maxIn = (quote.total * BigInt(10_000 + slippageBps + feeBps)) / 10_000n + 1n
  const allowance = await clientFor(ic).readContract({ address: ic.quote.address, abi: erc20Abi, functionName: 'allowance', args: [ctx.account.address, ic.router] })
  if (allowance < maxIn) await approveExact(ctx, ic, ic.quote.address, ic.router, maxIn)
  const data = encodeFunctionData({ abi: routerAbi, functionName: 'buy', args: [index.address, shares, maxIn, index.fees, maxLeg, ctx.account.address] })
  return sendTx(ctx, ic.router, data)
}
// Sell: approve exactly the shares, then one transaction that redeems and sells every leg.
export async function sellIndex(ctx0: TxCtx, index: IndexInfo, shares: bigint, quote: { total: bigint; perLeg: bigint[] }, slippageBps: number, feeBps: number) {
  const ic = index.chain, ctx = onChain(ctx0, ic)
  await ensureChainOn(ctx, ic)
  const minLeg = quote.perLeg.map((v) => (v * BigInt(10_000 - slippageBps)) / 10_000n)
  const minOut = (quote.total * BigInt(10_000 - slippageBps - feeBps)) / 10_000n
  const allowance = await clientFor(ic).readContract({ address: index.address, abi: indexAbi, functionName: 'allowance', args: [ctx.account.address, ic.router] })
  if (allowance < shares) await approveExact(ctx, ic, index.address, ic.router, shares)
  const data = encodeFunctionData({ abi: routerAbi, functionName: 'sell', args: [index.address, shares, minOut, index.fees, minLeg, ctx.account.address] })
  return sendTx(ctx, ic.router, data)
}
// Redeem in kind: the stocks themselves, straight from the index, no pool and no fee.
export async function redeemIndex(ctx0: TxCtx, index: IndexInfo, shares: bigint) {
  const ic = index.chain, ctx = onChain(ctx0, ic)
  await ensureChainOn(ctx, ic)
  return sendTx(ctx, index.address, encodeFunctionData({ abi: indexAbi, functionName: 'redeem', args: [shares, ctx.account.address] }))
}

// ----- Deploy page -----

export type TemplatePlan = { name: string; symbol: string; tokens: Address[]; units: bigint[]; legs: { ticker: string; priceUsd: number; units: bigint; fee: number; liquidityUsd: number }[]; missing: string[] }
// Units per share for an equal-value basket worth one USDG per share at today's pool prices.
export function planTemplate(ic: IndexChain, tpl: Template, stocks: StockToken[], pools: Pool[]): TemplatePlan {
  const n = tpl.tickers.length
  const legs: TemplatePlan['legs'] = []
  const missing: string[] = []
  for (const ticker of tpl.tickers) {
    const stock = stocks.find((s) => s.ticker === ticker)
    const pool = stock ? poolForOn(ic, stock, pools) : undefined
    if (!stock || !deepEnough(pool) || !pool) { missing.push(ticker); continue }
    const units = BigInt(Math.round(((1 / n) / pool.priceUsd) * 10 ** stock.decimals))
    legs.push({ ticker, priceUsd: pool.priceUsd, units, fee: pool.fee, liquidityUsd: pool.liquidityUsd })
  }
  return { name: tpl.name, symbol: tpl.symbol, tokens: legs.map((l) => stocks.find((s) => s.ticker === l.ticker)!.address), units: legs.map((l) => l.units), legs, missing }
}
export async function deployFactory(ctx0: TxCtx, ic: IndexChain) {
  const ctx = onChain(ctx0, ic)
  await ensureChainOn(ctx, ic)
  ctx.onPhase('confirming')
  const hash = await ctx.walletClient.sendTransaction({ account: ctx.account.address, chain: null, data: encodeDeployData({ abi: factoryAbi, bytecode: FACTORY_BYTECODE }) })
  ctx.onPhase('pending')
  const receipt = await clientFor(ic).waitForTransactionReceipt({ hash, timeout: 180_000 })
  ctx.onPhase('done')
  return { hash, address: receipt.contractAddress as Address }
}
// The router's constructor: the DEX factory, the quote token, VERDEX (zero where it does not exist), the treasury and the fee.
export const routerArgs = (ic: IndexChain, treasury: Address, feeBps: number) => [ic.dexFactory, ic.quote.address, ic.verdex, treasury, feeBps] as const
export async function deployRouter(ctx0: TxCtx, ic: IndexChain, treasury: Address, feeBps: number) {
  const ctx = onChain(ctx0, ic)
  await ensureChainOn(ctx, ic)
  ctx.onPhase('confirming')
  const hash = await ctx.walletClient.sendTransaction({ account: ctx.account.address, chain: null, data: encodeDeployData({ abi: routerAbi, bytecode: routerBytecodeFor(ic), args: [...routerArgs(ic, treasury, feeBps)] }) })
  ctx.onPhase('pending')
  const receipt = await clientFor(ic).waitForTransactionReceipt({ hash, timeout: 180_000 })
  ctx.onPhase('done')
  return { hash, address: receipt.contractAddress as Address }
}
export async function createIndex(ctx0: TxCtx, ic: IndexChain, factory: Address, plan: TemplatePlan, cap: bigint) {
  const ctx = onChain(ctx0, ic)
  await ensureChainOn(ctx, ic)
  return sendTx(ctx, factory, encodeFunctionData({ abi: factoryAbi, functionName: 'create', args: [plan.name, plan.symbol, plan.tokens, plan.units, cap] }))
}

export const fmtShares = (v: bigint, d = 2) => Number(formatUnits(v, 18)).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
export const fmtUsdg = (v: bigint, d = 2, decimals = USDG.decimals) => `$${Number(formatUnits(v, decimals)).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`
export const ONE_SHARE = ONE
