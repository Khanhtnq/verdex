// The Verdex API: the same reads the site makes in the browser, made by the server and served as JSON with a
// sixty-second cache. Nothing is stored; every call reads the chain (and the aggregator's public record) again
// when the cache expires. Used by server.mjs.
import { createPublicClient, http, formatUnits, parseAbi, parseAbiItem, erc20Abi } from 'viem'
import { readFileSync } from 'node:fs'
import { INDEX_FACTORY_ADDRESS, INDEX_ROUTER_ADDRESS, BASE_INDEX_FACTORY_ADDRESS, BASE_INDEX_ROUTER_ADDRESS } from './index-addresses.mjs'
import { TREASURY_ADDRESS } from './treasury-address.mjs'
import { AUTOINVEST_ADDRESS } from './autoinvest-address.mjs'
import { ORDERS_ADDRESS } from './orders-address.mjs'
import { VAULTS_ADDRESS } from './vaults-address.mjs'
import { AGENT_ADDRESS } from './agent-address.mjs'

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11'
const CHAINS = {
  robinhood: { id: 4663, name: 'Robinhood Chain', rpc: process.env.RPC || 'https://rpc.mainnet.chain.robinhood.com/', dex: 'uniswap-v3', factory: '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA', tiers: [100, 500, 3000, 10000], quote: { address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', symbol: 'USDG', decimals: 6 }, dexscreener: 'robinhood', explorer: 'https://robin.etherscan.io', indexFactory: INDEX_FACTORY_ADDRESS, indexRouter: INDEX_ROUTER_ADDRESS, logWindow: 9_000_000n, lookback: 24_192_000n },
  base: { id: 8453, name: 'Base', rpc: process.env.BASE_RPC || 'https://base-rpc.publicnode.com', dex: 'slipstream', factory: '0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef', tiers: [1, 10, 50, 100, 200], quote: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6 }, dexscreener: 'base', explorer: 'https://basescan.org', indexFactory: BASE_INDEX_FACTORY_ADDRESS, indexRouter: BASE_INDEX_ROUTER_ADDRESS, logWindow: 10_000n, lookback: 200_000n },
}
const clientFor = (ch) => createPublicClient({ chain: { id: ch.id, name: ch.name, nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [ch.rpc] } } }, transport: http(ch.rpc, { retryCount: 2, retryDelay: 800, timeout: 30_000 }) })
const factoryAbi = parseAbi(['function getPool(address,address,uint24) view returns (address)'])
const clFactoryAbi = parseAbi(['function getPool(address,address,int24) view returns (address)'])
const poolAbi = parseAbi(['function liquidity() view returns (uint128)', 'function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)', 'function fee() view returns (uint24)'])
const clPoolAbi = parseAbi(['function liquidity() view returns (uint128)', 'function slot0() view returns (uint160,int24,uint16,uint16,uint16,bool)', 'function fee() view returns (uint24)'])
const indexFactoryAbi = parseAbi(['function all() view returns (address[])'])
const indexAbi = parseAbi(['function name() view returns (string)', 'function symbol() view returns (string)', 'function totalSupply() view returns (uint256)', 'function maxSupply() view returns (uint256)', 'function components() view returns (address[] tokens,uint256[] units)'])
const countAbi = parseAbi(['function planCount() view returns (uint256)', 'function orderCount() view returns (uint256)', 'function vaultCount() view returns (uint256)', 'function mandateCount() view returns (uint256)'])
const treasuryAbi = parseAbi(['function totalBought() view returns (uint256)', 'function totalBurned() view returns (uint256)', 'function totalPaidBack() view returns (uint256)', 'function rewardsAvailable() view returns (uint256)', 'function epoch() view returns (uint256)'])
const EV = {
  executed: parseAbiItem('event Executed(uint256 indexed id,address indexed executor,uint256 amountIn,uint256 amountOut,uint256 tip,uint40 nextAt)'),
  filled: parseAbiItem('event Filled(uint256 indexed id,address indexed executor,uint256 amountIn,uint256 amountOut,uint256 tip)'),
  rebalanced: parseAbiItem('event Rebalanced(uint256 indexed id,address indexed executor,uint256 totalUsdg,uint256 soldUsdg,uint256 boughtUsdg,uint256 tip)'),
  traded: parseAbiItem('event Traded(uint256 indexed id,address indexed executor,address indexed token,bool sell,uint256 amountIn,uint256 amountOut,uint256 tip)'),
  bought: parseAbiItem('event Bought(address indexed index,address indexed buyer,address indexed to,uint256 shares,uint256 usdgIn,uint256 fee)'),
  sold: parseAbiItem('event Sold(address indexed index,address indexed seller,address indexed to,uint256 shares,uint256 usdgOut,uint256 fee)'),
  swept: parseAbiItem('event Swept(address indexed executor,address indexed tokenIn,uint256 amountIn,uint256 verdexOut,uint256 burned,uint256 kept)'),
  distributed: parseAbiItem('event Distributed(uint256 indexed epoch,uint256 total,uint256 recipients)'),
}
const lc = (a) => String(a).toLowerCase()
const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a ?? ''))
const num = (v, d) => Number(formatUnits(v, d))
const json = (v) => JSON.parse(JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() : x)))

// Logs in windows the RPC accepts, a few at a time; a failed window is skipped.
async function logs(c, ch, address, event, from, to) {
  const spans = []
  for (let a = from; a <= to; a += ch.logWindow) spans.push([a, a + ch.logWindow - 1n > to ? to : a + ch.logWindow - 1n])
  let out = []
  for (let i = 0; i < spans.length; i += 6) out = out.concat((await Promise.all(spans.slice(i, i + 6).map(([x, y]) => c.getLogs({ address, event, fromBlock: x, toBlock: y }).catch(() => [])))).flat())
  return out
}

// The stock list the site uses, with each chain's tokens.
let assetsCache
export function assets() {
  if (!assetsCache) assetsCache = JSON.parse(readFileSync(new URL('../public/api/assets.json', import.meta.url), 'utf8')).assets
  return assetsCache
}
const stocksOn = (chainId) => { const seen = new Set(); const out = []; for (const a of assets()) for (const tk of a.tokens) { if (tk.chainId !== chainId || seen.has(lc(tk.address))) continue; seen.add(lc(tk.address)); out.push({ address: tk.address, symbol: tk.symbol, decimals: tk.decimals, ticker: a.ticker, name: a.name }) } return out }

async function market(chainKey, addresses) {
  const out = new Map()
  for (let i = 0; i < addresses.length; i += 30) {
    try { const r = await fetch(`https://api.dexscreener.com/latest/dex/pairs/${chainKey}/${addresses.slice(i, i + 30).join(',')}`); if (!r.ok) continue; const j = await r.json(); for (const p of j.pairs ?? []) out.set(lc(p.pairAddress), { priceUsd: Number(p.priceUsd ?? 0), liquidityUsd: p.liquidity?.usd ?? 0, volume24hUsd: p.volume?.h24 ?? 0, priceChange24h: Number(p.priceChange?.h24 ?? 0) }) } catch { /* onchain figures only */ }
  }
  return out
}
const sqrtToPrice = (sqrtP, dec0, dec1, stockIsToken0) => { const raw = (Number(sqrtP) / 2 ** 96) ** 2 * 10 ** (dec0 - dec1); return stockIsToken0 ? raw : 1 / raw }

// Every stock pool on a chain against its stablecoin, with price, liquidity and the day's move.
export async function pools(chainKey) {
  const ch = CHAINS[chainKey]
  const c = clientFor(ch)
  const stocks = stocksOn(ch.id)
  const combos = stocks.flatMap((s) => ch.tiers.map((tier) => ({ s, tier })))
  const found = await c.multicall({ multicallAddress: MULTICALL3, batchSize: 4096, contracts: combos.map(({ s, tier }) => (ch.dex === 'slipstream' ? { address: ch.factory, abi: clFactoryAbi, functionName: 'getPool', args: [s.address, ch.quote.address, tier] } : { address: ch.factory, abi: factoryAbi, functionName: 'getPool', args: [s.address, ch.quote.address, tier] })) })
  const cands = combos.map((x, i) => ({ ...x, address: found[i].status === 'success' ? found[i].result : undefined })).filter((x) => x.address && x.address !== '0x0000000000000000000000000000000000000000')
  if (!cands.length) return []
  const pa = ch.dex === 'slipstream' ? clPoolAbi : poolAbi
  const state = await c.multicall({ multicallAddress: MULTICALL3, batchSize: 4096, contracts: cands.flatMap((p) => [{ address: p.address, abi: pa, functionName: 'liquidity' }, { address: p.address, abi: pa, functionName: 'slot0' }, { address: p.address, abi: pa, functionName: 'fee' }]) })
  const m = await market(ch.dexscreener, cands.map((p) => p.address))
  const out = []
  cands.forEach((p, i) => {
    const liq = state[i * 3], s0 = state[i * 3 + 1], f = state[i * 3 + 2]
    if (liq.status !== 'success' || s0.status !== 'success' || liq.result === 0n) return
    const stockIsToken0 = lc(p.s.address) < lc(ch.quote.address)
    const price = stockIsToken0 ? sqrtToPrice(s0.result[0], p.s.decimals, ch.quote.decimals, true) : sqrtToPrice(s0.result[0], ch.quote.decimals, p.s.decimals, false)
    const mk = m.get(lc(p.address))
    out.push({ chain: ch.name, chainId: ch.id, ticker: p.s.ticker, name: p.s.name, token: p.s.address, pool: p.address, quote: ch.quote.symbol, fee: f.status === 'success' ? Number(f.result) : (ch.dex === 'uniswap-v3' ? p.tier : 0), tickSpacing: ch.dex === 'slipstream' ? p.tier : undefined, dex: ch.dex, priceUsd: mk?.priceUsd || price, liquidityUsd: mk?.liquidityUsd ?? 0, volume24hUsd: mk?.volume24hUsd ?? 0, priceChange24h: mk?.priceChange24h ?? null, liquidity: liq.result.toString(), explorer: `${ch.explorer}/address/${p.address}` })
  })
  return out.sort((a, b) => b.liquidityUsd - a.liquidityUsd)
}

// Every index on a chain: components, units, weights, NAV and TVL at the pools.
export async function indexes(chainKey) {
  const ch = CHAINS[chainKey]
  if (!isAddr(ch.indexFactory)) return []
  const c = clientFor(ch)
  const list = await c.readContract({ address: ch.indexFactory, abi: indexFactoryAbi, functionName: 'all' })
  if (!list.length) return []
  const ps = await pools(chainKey)
  const best = new Map(); for (const p of ps) { const k = lc(p.token); if (!best.has(k) || best.get(k).liquidityUsd < p.liquidityUsd) best.set(k, p) }
  const res = await c.multicall({ multicallAddress: MULTICALL3, batchSize: 4096, contracts: list.flatMap((address) => [{ address, abi: indexAbi, functionName: 'name' }, { address, abi: indexAbi, functionName: 'symbol' }, { address, abi: indexAbi, functionName: 'totalSupply' }, { address, abi: indexAbi, functionName: 'maxSupply' }, { address, abi: indexAbi, functionName: 'components' }]) })
  const stocks = new Map(stocksOn(ch.id).map((s) => [lc(s.address), s]))
  return list.map((address, i) => {
    const at = (k, fb) => (res[i * 5 + k].status === 'success' ? res[i * 5 + k].result : fb)
    const [tokens, units] = at(4, [[], []])
    const components = tokens.map((token, k) => { const s = stocks.get(lc(token)); const p = best.get(lc(token)); const u = num(units[k], s?.decimals ?? 18); const value = u * (p?.priceUsd ?? 0); return { ticker: s?.ticker ?? null, token, unitsPerShare: u, priceUsd: p?.priceUsd ?? null, valuePerShareUsd: value, pool: p?.pool ?? null } })
    const nav = components.reduce((s, x) => s + x.valuePerShareUsd, 0)
    for (const x of components) x.weight = nav > 0 ? x.valuePerShareUsd / nav : 0
    const supply = num(at(2, 0n), 18)
    return { chain: ch.name, chainId: ch.id, address, name: at(0, 'Index'), symbol: at(1, '?'), totalSupply: supply, maxSupply: num(at(3, 0n), 18), navUsd: nav, tvlUsd: nav * supply, components, explorer: `${ch.explorer}/address/${address}`, page: `https://useverdex.xyz/index${chainKey === 'base' ? '?chain=base' : ''}` }
  })
}

// The four contracts that work without you: counts and every execution in the last four weeks.
export async function withoutYou() {
  const ch = CHAINS.robinhood
  const c = clientFor(ch)
  const cs = { autoInvest: AUTOINVEST_ADDRESS, orders: ORDERS_ADDRESS, vaults: VAULTS_ADDRESS, agent: AGENT_ADDRESS }
  const counts = await c.multicall({ multicallAddress: MULTICALL3, contracts: [{ address: cs.autoInvest, abi: countAbi, functionName: 'planCount' }, { address: cs.orders, abi: countAbi, functionName: 'orderCount' }, { address: cs.vaults, abi: countAbi, functionName: 'vaultCount' }, { address: cs.agent, abi: countAbi, functionName: 'mandateCount' }] })
  const n = (k) => (counts[k].status === 'success' ? Number(counts[k].result) : 0)
  const head = await c.getBlockNumber()
  const from = head > ch.lookback ? head - ch.lookback : 0n
  const tx = (l, label, usd) => ({ label, hash: l.transactionHash, block: Number(l.blockNumber), usd, explorer: `${ch.explorer}/tx/${l.transactionHash}` })
  const [ex, fi, re, tr] = await Promise.all([
    isAddr(cs.autoInvest) ? logs(c, ch, cs.autoInvest, EV.executed, from, head) : [],
    isAddr(cs.orders) ? logs(c, ch, cs.orders, EV.filled, from, head) : [],
    isAddr(cs.vaults) ? logs(c, ch, cs.vaults, EV.rebalanced, from, head) : [],
    isAddr(cs.agent) ? logs(c, ch, cs.agent, EV.traded, from, head) : [],
  ])
  const executions = [
    ...ex.map((l) => tx(l, `Auto-Invest buy, plan #${l.args.id}`, num(l.args.amountIn, 6))),
    ...fi.map((l) => tx(l, `Order filled, #${l.args.id}`)),
    ...re.map((l) => tx(l, `Vault rebalanced, #${l.args.id}`, num(l.args.totalUsdg, 6))),
    ...tr.map((l) => tx(l, `Agent ${l.args.sell ? 'sale' : 'buy'}, mandate #${l.args.id}`)),
  ].sort((a, b) => b.block - a.block)
  return {
    chain: ch.name, chainId: ch.id, since: { block: Number(from), note: 'executions over about the last four weeks of blocks' },
    autoInvest: { contract: cs.autoInvest || null, plans: n(0), buys: ex.length, buysUsdg: ex.reduce((s, l) => s + num(l.args.amountIn, 6), 0) },
    orders: { contract: cs.orders || null, orders: n(1), fills: fi.length },
    vaults: { contract: cs.vaults || null, vaults: n(2), rebalances: re.length },
    agent: { contract: cs.agent || null, mandates: n(3), trades: tr.length },
    executions,
  }
}

export async function treasury() {
  const ch = CHAINS.robinhood
  if (!isAddr(TREASURY_ADDRESS)) return { contract: null }
  const c = clientFor(ch)
  const [res, head] = await Promise.all([c.multicall({ multicallAddress: MULTICALL3, contracts: ['totalBought', 'totalBurned', 'totalPaidBack', 'rewardsAvailable', 'epoch'].map((fn) => ({ address: TREASURY_ADDRESS, abi: treasuryAbi, functionName: fn })) }), c.getBlockNumber()])
  const v = (k) => (res[k].status === 'success' ? res[k].result : 0n)
  const from = head > ch.lookback ? head - ch.lookback : 0n
  const [sw, di] = await Promise.all([logs(c, ch, TREASURY_ADDRESS, EV.swept, from, head), logs(c, ch, TREASURY_ADDRESS, EV.distributed, from, head)])
  return {
    chain: ch.name, contract: TREASURY_ADDRESS, explorer: `${ch.explorer}/address/${TREASURY_ADDRESS}`,
    verdex: { bought: num(v(0), 18), burned: num(v(1), 18), paidBack: num(v(2), 18), waitingForPayout: num(v(3), 18) }, epoch: Number(v(4)),
    sweeps: sw.map((l) => ({ tokenIn: l.args.tokenIn, amountIn: l.args.amountIn.toString(), verdexOut: num(l.args.verdexOut, 18), burned: num(l.args.burned, 18), kept: num(l.args.kept, 18), hash: l.transactionHash, block: Number(l.blockNumber), explorer: `${ch.explorer}/tx/${l.transactionHash}` })).reverse(),
    payouts: di.map((l) => ({ epoch: Number(l.args.epoch), verdex: num(l.args.total, 18), recipients: Number(l.args.recipients), hash: l.transactionHash, block: Number(l.blockNumber), explorer: `${ch.explorer}/tx/${l.transactionHash}` })).reverse(),
  }
}

// Swaps and bridges made through Verdex, from the aggregator's public record (the last 89 days).
export async function volume() {
  const since = Math.floor(Date.now() / 1000) - 89 * 86_400
  const r = await fetch(`https://li.quest/v1/analytics/transfers?integrator=verdex&fromTimestamp=${since}`)
  if (!r.ok) throw new Error(`analytics ${r.status}`)
  const j = await r.json()
  const done = (j.transfers ?? []).filter((x) => x.status === 'DONE')
  const byChain = {}
  for (const x of done) { const k = x.sending.chainId; byChain[k] = byChain[k] ?? { usd: 0, count: 0 }; byChain[k].usd += Number(x.sending.amountUSD ?? 0); byChain[k].count++ }
  return { source: 'li.quest analytics, integrator verdex', sinceUnix: since, usd: done.reduce((s, x) => s + Number(x.sending.amountUSD ?? 0), 0), count: done.length, byChain, transfers: done.map((x) => ({ chainId: x.sending.chainId, toChainId: x.receiving?.chainId ?? null, usd: Number(x.sending.amountUSD ?? 0), tool: x.tool, at: x.sending.timestamp ?? null, hash: x.sending.txHash ?? null, explorer: x.sending.txLink ?? null })) }
}

async function indexTrades() {
  const out = { buys: 0, sells: 0, usd: 0, feesUsd: 0, trades: [] }
  for (const key of ['robinhood', 'base']) {
    const ch = CHAINS[key]
    if (!isAddr(ch.indexRouter)) continue
    const c = clientFor(ch)
    const head = await c.getBlockNumber().catch(() => 0n)
    if (!head) continue
    const from = head > ch.lookback ? head - ch.lookback : 0n
    const [b, s] = await Promise.all([logs(c, ch, ch.indexRouter, EV.bought, from, head), logs(c, ch, ch.indexRouter, EV.sold, from, head)])
    out.buys += b.length; out.sells += s.length
    for (const l of b) { out.usd += num(l.args.usdgIn, 6); out.feesUsd += num(l.args.fee, 6); out.trades.push({ chain: ch.name, side: 'buy', index: l.args.index, usd: num(l.args.usdgIn, 6), hash: l.transactionHash, explorer: `${ch.explorer}/tx/${l.transactionHash}` }) }
    for (const l of s) { out.usd += num(l.args.usdgOut, 6); out.feesUsd += num(l.args.fee, 6); out.trades.push({ chain: ch.name, side: 'sell', index: l.args.index, usd: num(l.args.usdgOut, 6), hash: l.transactionHash, explorer: `${ch.explorer}/tx/${l.transactionHash}` }) }
  }
  return out
}

// The numbers page in one object.
export async function numbers() {
  const [rh, bs, vol, it, tr, wy] = await Promise.all([indexes('robinhood').catch(() => []), indexes('base').catch(() => []), volume().catch(() => null), indexTrades().catch(() => null), treasury().catch(() => null), withoutYou().catch(() => null)])
  const all = [...rh, ...bs]
  return {
    readAt: new Date().toISOString(),
    index: { tvlUsd: all.reduce((s, x) => s + x.tvlUsd, 0), count: all.length, indexes: all.map(({ chain, symbol, name, address, tvlUsd, totalSupply, explorer }) => ({ chain, symbol, name, address, tvlUsd, totalSupply, explorer })) },
    volume: vol && { usd: vol.usd, count: vol.count, byChain: vol.byChain, sinceUnix: vol.sinceUnix },
    indexTrades: it && { buys: it.buys, sells: it.sells, usd: it.usd, feesUsd: it.feesUsd },
    treasury: tr && tr.contract ? { contract: tr.contract, verdex: tr.verdex, sweeps: tr.sweeps.length, payouts: tr.payouts.length } : null,
    withoutYou: wy && { autoInvest: wy.autoInvest, orders: wy.orders, vaults: wy.vaults, agent: wy.agent, executions: wy.executions.length },
  }
}

// ---- VERDEX holders: every address that ever received VERDEX, from the token's Transfer events since the mint,
// with each one's balance read from the token itself (so the sum is the supply, whatever the logs missed). The scan
// is kept in memory and only new blocks are read after the first call.
const VERDEX = '0x96f455a90a80dcf0c2df6703ea4ba3bedf286e43'
const VERDEX_MINT_BLOCK = 74_800_000n
const POOL_MANAGER = '0x8366a39CC670B4001A1121B8F6A443A643e40951'
const transferEv = parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 value)')
const scanState = { to: VERDEX_MINT_BLOCK - 1n, firstSeen: new Map(), transfers: [] }
async function scanSplit(c, a, b) {
  try { return await c.getLogs({ address: VERDEX, event: transferEv, fromBlock: a, toBlock: b }) }
  catch (e) { if (b - a < 2000n) throw e; const m = (a + b) / 2n; return [...(await scanSplit(c, a, m)), ...(await scanSplit(c, m + 1n, b))] }
}
let scanning = null
async function scanVerdex(c) {
  if (scanning) return scanning
  scanning = (async () => {
    const head = await c.getBlockNumber()
    for (let a = scanState.to + 1n; a <= head; a += 5_000_000n) {
      const b = a + 4_999_999n > head ? head : a + 4_999_999n
      const got = await scanSplit(c, a, b)
      for (const l of got) {
        const to = l.args.to
        if (to !== '0x0000000000000000000000000000000000000000' && !scanState.firstSeen.has(lc(to))) scanState.firstSeen.set(lc(to), { address: to, block: l.blockNumber })
        scanState.transfers.push(l.blockNumber)
      }
      scanState.to = b
    }
    return head
  })().finally(() => { scanning = null })
  return scanning
}
export async function holders() {
  const ch = CHAINS.robinhood
  const c = clientFor(ch)
  const head = await scanVerdex(c)
  const list = [...scanState.firstSeen.values()]
  const bals = await c.multicall({ multicallAddress: MULTICALL3, batchSize: 8192, contracts: list.map((x) => ({ address: VERDEX, abi: erc20Abi, functionName: 'balanceOf', args: [x.address] })) })
  const headBlock = await c.getBlock({ blockNumber: head })
  const back = await c.getBlock({ blockNumber: head - 1_000_000n })
  const secPerBlock = Number(headBlock.timestamp - back.timestamp) / 1_000_000
  const when = (block) => Number(headBlock.timestamp) - Number(head - block) * secPerBlock
  const SUPPLY = 1_000_000_000
  const rows = list.map((x, i) => ({ address: x.address, verdex: bals[i].status === 'success' ? num(bals[i].result, 18) : 0, since: Math.round(when(x.block)) })).filter((x) => x.verdex > 0)
  const codes = await Promise.all(rows.map((r) => (r.verdex >= SUPPLY * 0.001 ? c.getCode({ address: r.address }).catch(() => '0x') : Promise.resolve('0x'))))
  for (let i = 0; i < rows.length; i++) {
    const code = codes[i] ?? '0x'
    rows[i].kind = lc(rows[i].address) === lc(POOL_MANAGER) ? 'pool' : code.length > 2 && !code.startsWith('0xef0100') ? 'contract' : 'wallet'
  }
  rows.sort((a, b) => b.verdex - a.verdex)
  const people = rows.filter((r) => r.kind === 'wallet')
  const now = Number(headBlock.timestamp)
  const share = (v) => (v / SUPPLY) * 100
  const bucket = (lo, hi) => people.filter((r) => share(r.verdex) >= lo && share(r.verdex) < hi).length
  // Holders over time: wallets that hold today, counted from the day they first received VERDEX.
  const days = []
  const start = Math.min(...people.map((r) => r.since))
  for (let d = Math.floor(start / 86400) * 86400; d <= now; d += 86400) days.push({ day: d, holders: people.filter((r) => r.since < d + 86400).length })
  return {
    chain: ch.name, token: VERDEX, supply: SUPPLY, readAt: new Date(now * 1000).toISOString(),
    holders: people.length, contracts: rows.length - people.length,
    inPool: share(rows.find((r) => r.kind === 'pool')?.verdex ?? 0),
    earlyAccessBps: 50, earlyAccess: people.filter((r) => share(r.verdex) >= 0.5).length,
    newHolders: { day: people.filter((r) => r.since >= now - 86400).length, week: people.filter((r) => r.since >= now - 7 * 86400).length },
    transfers: { day: scanState.transfers.filter((b) => when(b) >= now - 86400).length, total: scanState.transfers.length },
    buckets: [{ label: '1% or more', count: bucket(1, 101) }, { label: '0.5% to 1%', count: bucket(0.5, 1) }, { label: '0.1% to 0.5%', count: bucket(0.1, 0.5) }, { label: '0.01% to 0.1%', count: bucket(0.01, 0.1) }, { label: 'Under 0.01%', count: bucket(0, 0.01) }],
    top10Share: people.slice(0, 10).reduce((s, r) => s + share(r.verdex), 0),
    series: days,
    list: rows.map((r) => ({ address: r.address, verdex: Math.round(r.verdex * 100) / 100, share: Math.round(share(r.verdex) * 10000) / 10000, kind: r.kind, since: r.since })),
  }
}

// ---- Candles: daily OHLCV of one pool from GeckoTerminal's public API, kept for thirty minutes per pool so the
// site's charts and backtests never hit its rate limit. [unix, open, high, low, close, volumeUsd], oldest first.
const GT_NETWORK = { robinhood: 'robinhood', base: 'base' }
// One call to GeckoTerminal at a time, a little over two seconds apart, to stay under its public limit.
let gtChain = Promise.resolve()
const gtFetch = (url) => { const run = gtChain.then(async () => { let r = await fetch(url, { headers: { accept: 'application/json' } }); if (r.status === 429) { await new Promise((ok) => setTimeout(ok, 61_000)); r = await fetch(url, { headers: { accept: 'application/json' } }) } await new Promise((ok) => setTimeout(ok, 2600)); return r }); gtChain = run.catch(() => {}); return run }
export async function candles(chainKey, pool) {
  const r = await gtFetch(`https://api.geckoterminal.com/api/v2/networks/${GT_NETWORK[chainKey]}/pools/${pool}/ohlcv/day?limit=180&currency=usd`)
  if (!r.ok) throw new Error(`candles ${r.status}`)
  const j = await r.json()
  const list = (j?.data?.attributes?.ohlcv_list ?? []).map((x) => x.map(Number)).sort((a, b) => a[0] - b[0])
  return { chain: chainKey, pool, interval: 'day', candles: list }
}
const CANDLES = /^\/api\/candles\/(robinhood|base)\/(0x[0-9a-fA-F]{40})$/
const TTL_OF = (path) => (CANDLES.test(path) ? 30 * 60_000 : path === '/api/holders' ? 60_000 : 60_000)
const readerFor = (path) => { if (READERS[path]) return READERS[path]; const m = path.match(CANDLES); return m ? () => candles(m[1], m[2]) : null }

// ---- the routes, with a sixty-second cache and one in-flight read per key ----
const TTL = 60_000
const cache = new Map()
const READERS = {
  '/api': async () => ({ name: 'Verdex API', docs: 'https://useverdex.xyz/docs#api', cache: 'sixty seconds', endpoints: ['/api/numbers', '/api/indexes', '/api/indexes/base', '/api/without-you', '/api/treasury', '/api/volume', '/api/pools', '/api/pools/base', '/api/assets', '/api/holders', '/api/candles/{robinhood|base}/{pool}'] }),
  '/api/numbers': numbers,
  '/api/indexes': () => Promise.all([indexes('robinhood'), indexes('base')]).then(([a, b]) => [...a, ...b]),
  '/api/indexes/base': () => indexes('base'),
  '/api/without-you': withoutYou,
  '/api/treasury': treasury,
  '/api/volume': volume,
  '/api/pools': () => pools('robinhood'),
  '/api/pools/base': () => pools('base'),
  '/api/assets': async () => assets(),
  '/api/holders': holders,
}
export function isApiPath(path) { return Object.prototype.hasOwnProperty.call(READERS, path) || CANDLES.test(path) }
export async function apiRead(path) {
  const hit = cache.get(path)
  const now = Date.now()
  if (hit && now - hit.at < TTL_OF(path)) return { status: 200, body: hit.body, age: Math.round((now - hit.at) / 1000) }
  if (hit?.inflight) return hit.inflight
  const inflight = readerFor(path)().then((v) => { const body = JSON.stringify({ ok: true, readAt: new Date().toISOString(), data: json(v) }); cache.set(path, { at: Date.now(), body }); return { status: 200, body, age: 0 } }).catch((e) => { if (hit?.body) { cache.set(path, { at: Date.now() - TTL_OF(path) + 300_000, body: hit.body }); return { status: 200, body: hit.body, age: Math.round((Date.now() - hit.at) / 1000) } } cache.delete(path); return { status: 502, body: JSON.stringify({ ok: false, error: String(e?.shortMessage ?? e?.message ?? e).slice(0, 200) }), age: 0 } })
  cache.set(path, { ...(hit ?? {}), inflight })
  return inflight
}
