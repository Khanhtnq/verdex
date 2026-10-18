// The Auto-Invest executor: one pass over every plan on the contract, running the ones that are due.
// Used by scripts/autoinvest-executor.mjs (one-off) and by server.mjs (every ten minutes).
import { createPublicClient, createWalletClient, http, formatUnits, parseAbi, encodeFunctionData, erc20Abi } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

export const DEFAULT_RPC = 'https://rpc.mainnet.chain.robinhood.com/'
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11'
const abi = parseAbi([
  'function planCount() view returns (uint256)',
  'function isDue(uint256 id) view returns (bool)',
  'function floorOut(uint256 id) view returns (uint256)',
  'function execute(uint256 id,uint256 minOut) returns (uint256)',
])
const chain = (rpc, id = 4663) => ({ id, name: id === 8453 ? 'Base' : 'Robinhood Chain', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } })

/** Runs every due plan once. Returns { count, due, sent, skipped }. Never throws for a single plan's failure. */
// chainId 8453 runs the Base contract (VerdexAutoInvestCL, the same functions) over a Base RPC.
export async function runOnce({ rpc = DEFAULT_RPC, address, key, log = console.log, chainId = 4663 }) {
  const account = privateKeyToAccount(key)
  const pub = createPublicClient({ chain: chain(rpc, chainId), transport: http(rpc, { retryCount: 3, retryDelay: 1500, timeout: 30_000 }) })
  const wallet = createWalletClient({ account, chain: chain(rpc, chainId), transport: http(rpc) })
  const c = { address, abi }
  const count = Number(await pub.readContract({ ...c, functionName: 'planCount' }))
  if (!count) return { count, due: 0, sent: 0, skipped: 0 }
  const ids = Array.from({ length: count }, (_, i) => BigInt(i + 1))
  const due = await pub.multicall({ multicallAddress: MULTICALL3, contracts: ids.map((id) => ({ ...c, functionName: 'isDue', args: [id] })) })
  const todo = ids.filter((_, i) => due[i].status === 'success' && due[i].result === true)
  let sent = 0, skipped = 0
  for (const id of todo) {
    try {
      const floor = await pub.readContract({ ...c, functionName: 'floorOut', args: [id] })
      const sim = await pub.simulateContract({ ...c, functionName: 'execute', args: [id, floor], account })
      const hash = await wallet.writeContract(sim.request)
      const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 })
      log(`plan ${id}${chainId === 8453 ? ' (Base)' : ''}: ${r.status} ${hash} out ${formatUnits(sim.result, 18)} gas ${r.gasUsed}`)
      if (r.status === 'success') sent++
      else skipped++
    } catch (e) {
      // Balance or allowance short, or the pool moved past the floor: the plan waits for the next pass.
      skipped++
      log(`plan ${id}: skipped, ${(e.shortMessage ?? e.message ?? String(e)).split('\n')[0].slice(0, 140)}`)
    }
  }
  return { count, due: todo.length, sent, skipped }
}

// ---- Orders without you: one pass over every order on the VerdexOrders contract, filling the triggered ones.
const ordersAbi = parseAbi([
  'function orderCount() view returns (uint256)',
  'function isDue(uint256 id) view returns (bool)',
  'function floorOut(uint256 id) view returns (uint256)',
  'function execute(uint256 id,uint256 minOut) returns (uint256)',
])
// chainId 8453 runs the Base contract (VerdexOrdersCL, the same functions) over a Base RPC.
export async function runOrdersOnce({ rpc = DEFAULT_RPC, address, key, log = console.log, chainId = 4663 }) {
  const account = privateKeyToAccount(key)
  const pub = createPublicClient({ chain: chain(rpc, chainId), transport: http(rpc, { retryCount: 3, retryDelay: 1500, timeout: 30_000 }) })
  const wallet = createWalletClient({ account, chain: chain(rpc, chainId), transport: http(rpc) })
  const c = { address, abi: ordersAbi }
  const count = Number(await pub.readContract({ ...c, functionName: 'orderCount' }))
  if (!count) return { count, due: 0, sent: 0, skipped: 0 }
  const ids = Array.from({ length: count }, (_, i) => BigInt(i + 1))
  const due = await pub.multicall({ multicallAddress: MULTICALL3, contracts: ids.map((id) => ({ ...c, functionName: 'isDue', args: [id] })) })
  const todo = ids.filter((_, i) => due[i].status === 'success' && due[i].result === true)
  let sent = 0, skipped = 0
  for (const id of todo) {
    try {
      const floor = await pub.readContract({ ...c, functionName: 'floorOut', args: [id] })
      const sim = await pub.simulateContract({ ...c, functionName: 'execute', args: [id, floor], account })
      const hash = await wallet.writeContract(sim.request)
      const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 })
      log(`order ${id}${chainId === 8453 ? ' (Base)' : ''}: ${r.status} ${hash} out ${sim.result} gas ${r.gasUsed}`)
      if (r.status === 'success') sent++
      else skipped++
    } catch (e) {
      // Balance or allowance short, or the pool moved past the floor: the order waits for the next pass.
      skipped++
      log(`order ${id}: skipped, ${(e.shortMessage ?? e.message ?? String(e)).split('\n')[0].slice(0, 140)}`)
    }
  }
  return { count, due: todo.length, sent, skipped }
}

// ---- Vaults without you: one pass over every vault on the VerdexVaults contract, rebalancing the due ones.
const vaultsAbi = parseAbi([
  'function vaultCount() view returns (uint256)',
  'function isDue(uint256 id) view returns (bool)',
  'function execute(uint256 id) returns (uint256 soldUsdg,uint256 boughtUsdg)',
])
// chainId 8453 runs the Base contract (VerdexVaultsCL, the same functions, USDC amounts) over a Base RPC.
export async function runVaultsOnce({ rpc = DEFAULT_RPC, address, key, log = console.log, chainId = 4663 }) {
  const account = privateKeyToAccount(key)
  const pub = createPublicClient({ chain: chain(rpc, chainId), transport: http(rpc, { retryCount: 3, retryDelay: 1500, timeout: 30_000 }) })
  const wallet = createWalletClient({ account, chain: chain(rpc, chainId), transport: http(rpc) })
  const c = { address, abi: vaultsAbi }
  const count = Number(await pub.readContract({ ...c, functionName: 'vaultCount' }))
  if (!count) return { count, due: 0, sent: 0, skipped: 0 }
  const ids = Array.from({ length: count }, (_, i) => BigInt(i + 1))
  const due = await pub.multicall({ multicallAddress: MULTICALL3, contracts: ids.map((id) => ({ ...c, functionName: 'isDue', args: [id] })) })
  const todo = ids.filter((_, i) => due[i].status === 'success' && due[i].result === true)
  let sent = 0, skipped = 0
  for (const id of todo) {
    try {
      const sim = await pub.simulateContract({ ...c, functionName: 'execute', args: [id], account })
      const hash = await wallet.writeContract(sim.request)
      const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 })
      log(`vault ${id}${chainId === 8453 ? ' (Base)' : ''}: ${r.status} ${hash} sold ${formatUnits(sim.result[0], 6)} bought ${formatUnits(sim.result[1], 6)} ${chainId === 8453 ? 'USDC' : 'USDG'} gas ${r.gasUsed}`)
      if (r.status === 'success') sent++
      else skipped++
    } catch (e) {
      // An allowance short, or a pool past a floor: the vault waits for the next pass.
      skipped++
      log(`vault ${id}: skipped, ${(e.shortMessage ?? e.message ?? String(e)).split('\n')[0].slice(0, 140)}`)
    }
  }
  return { count, due: todo.length, sent, skipped }
}

// ---- Agent without you: one pass over every mandate on the VerdexAgent contract. The contract keeps the limits
// (budget, per trade, per day, cooldown, floor, expiry); this is the agent's judgement inside them: the rule the
// owner chose, applied to each stock's move on the day, read from the pools' market data. One trade per mandate
// per pass at most, always checked against the contract first and simulated before it is sent.
const agentAbi = parseAbi([
  'function mandateCount() view returns (uint256)',
  'function mandates(uint256) view returns (address owner,uint8 rule,uint16 param,uint16 maxSlippageBps,uint32 cooldown,bool paused,bool closed,uint40 expiresAt,uint96 budget,uint96 perTrade,uint96 perDay,uint96 tip,uint40 dayStart,uint96 spentToday,uint96 spent,uint40 lastTrade,uint96 sold,uint32 trades)',
  'function tokensOf(uint256 id) view returns (address[] tokens,uint24[] fees)',
  'function check(uint256 id,uint256 i,bool sell,uint256 amountIn) view returns (uint8)',
  'function quoteSpot(uint256 id,uint256 i,bool sell,uint256 amountIn) view returns (uint256)',
  'function floorOut(uint256 id,uint256 i,bool sell,uint256 amountIn) view returns (uint256)',
  'function leftToday(uint256 id) view returns (uint256)',
  'function execute(uint256 id,uint256 i,bool sell,uint256 amountIn,uint256 minOut) returns (uint256)',
  'event Traded(uint256 indexed id,address indexed executor,address indexed token,bool sell,uint256 amountIn,uint256 amountOut,uint256 tip)',
])
const FACTORY = '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA'
const factoryAbi = parseAbi(['function getPool(address,address,uint24) view returns (address)'])
export const AGENT_RULES = { 0: 'buys the dips', 1: 'buys strength', 2: 'takes profits', 3: 'cuts losses', 4: 'trades both ways' }
// Rules v2 live in the same uint8 the contract stores and never reads: bits 0-2 the base rule (0 dips, 1 strength,
// 2 profits, 3 losses, 4 both ways: buy the dips and take the profits), bit 3 the window (set: the last hour instead
// of the day), bits 4-5 a weekly cap as a multiple of the day cap (0 none, then 2x, 3x, 5x), kept by the executor
// from the contract's own Traded events of the last seven days.
export const WEEK_X = [0, 2, 3, 5]
export const decodeRule = (code) => ({ base: code & 7, hourly: (code & 8) !== 0, weekX: WEEK_X[(code >> 4) & 3] })
export const encodeRule = (base, hourly, weekX) => (base & 7) | (hourly ? 8 : 0) | (Math.max(0, WEEK_X.indexOf(weekX)) << 4)
const WEEK_BLOCKS = 6_100_000n // seven days of Robinhood Chain blocks, with a margin
const CHECK_CODES = { 1: 'closed', 2: 'paused', 3: 'expired', 4: 'no such stock', 5: 'cooling down', 6: 'under a dollar', 7: 'over the per-trade cap', 8: 'over the day cap', 9: 'over the budget' }

// The day's move of each pool, in percent, from the public market data the site also reads. Pools it does not
// know get no move, so the agent leaves them alone.
// Each pool's move on the day and in the last hour, in percent, from the pools' market data.
export async function readMoves(pools, fetchImpl = fetch) {
  const out = new Map()
  const list = [...new Set(pools.map((p) => p.toLowerCase()))]
  for (let i = 0; i < list.length; i += 30) {
    const batch = list.slice(i, i + 30)
    try {
      const r = await fetchImpl(`https://api.dexscreener.com/latest/dex/pairs/robinhood/${batch.join(',')}`, { headers: { accept: 'application/json' } })
      if (!r.ok) continue
      const j = await r.json()
      for (const pair of j.pairs ?? []) { const h24 = Number(pair.priceChange?.h24), h1 = Number(pair.priceChange?.h1); if (pair.pairAddress && isFinite(h24)) out.set(pair.pairAddress.toLowerCase(), { h24, h1: isFinite(h1) ? h1 : undefined }) }
    } catch { /* no data for this batch */ }
  }
  return out
}
export async function readDayMoves(pools, fetchImpl = fetch) { return new Map([...(await readMoves(pools, fetchImpl))].map(([k, v]) => [k, v.h24])) }

// What the rule asks for on a stock that moved `movePct` on the day: 'buy', 'sell' or nothing.
export function agentDecision(rule, paramBps, movePct) {
  const size = paramBps / 100
  const { base } = decodeRule(rule)
  if (base === 0) return movePct <= -size ? 'buy' : null
  if (base === 1) return movePct >= size ? 'buy' : null
  if (base === 2) return movePct >= size ? 'sell' : null
  if (base === 3) return movePct <= -size ? 'sell' : null
  if (base === 4) return movePct <= -size ? 'buy' : movePct >= size ? 'sell' : null
  return null
}
/** USDG traded by a mandate in the last seven days, from its Traded events: a buy's amount in, a sale's amount out. */
export async function readWeekSpent(pub, address, id) {
  const head = await pub.getBlockNumber()
  const event = agentAbi.find((x) => x.type === 'event' && x.name === 'Traded')
  const from = head > WEEK_BLOCKS ? head - WEEK_BLOCKS : 0n
  let logs
  try { logs = await pub.getLogs({ address, event, args: { id }, fromBlock: from, toBlock: head }) }
  catch { const mid = from + (head - from) / 2n; logs = [...(await pub.getLogs({ address, event, args: { id }, fromBlock: from, toBlock: mid })), ...(await pub.getLogs({ address, event, args: { id }, fromBlock: mid + 1n, toBlock: head }))] }
  return logs.reduce((acc, l) => acc + (l.args.sell ? l.args.amountOut : l.args.amountIn), 0n)
}

export async function runAgentOnce({ rpc = DEFAULT_RPC, address, key, log = console.log, moves }) {
  const account = privateKeyToAccount(key)
  const pub = createPublicClient({ chain: chain(rpc), transport: http(rpc, { retryCount: 3, retryDelay: 1500, timeout: 30_000 }) })
  const wallet = createWalletClient({ account, chain: chain(rpc), transport: http(rpc) })
  const c = { address, abi: agentAbi }
  const count = Number(await pub.readContract({ ...c, functionName: 'mandateCount' }))
  const out = { count, open: 0, candidates: 0, sent: 0, skipped: 0 }
  if (!count) return out
  const ids = Array.from({ length: count }, (_, i) => BigInt(i + 1))
  const raw = await pub.multicall({ multicallAddress: MULTICALL3, contracts: ids.map((id) => ({ ...c, functionName: 'mandates', args: [id] })) })
  const now = Math.floor(Date.now() / 1000)
  const open = []
  ids.forEach((id, k) => {
    if (raw[k].status !== 'success') return
    const m = raw[k].result
    const [owner, rule, param, , , paused, closed, expiresAt, budget, perTrade, perDay, tip, , , , , ,] = m
    if (closed || paused || (Number(expiresAt) !== 0 && now > Number(expiresAt))) return
    open.push({ id, owner, rule: Number(rule), param: Number(param), budget, perTrade, perDay, tip, ...decodeRule(Number(rule)) })
  })
  out.open = open.length
  if (!open.length) return out
  const toks = await pub.multicall({ multicallAddress: MULTICALL3, contracts: open.map((m) => ({ ...c, functionName: 'tokensOf', args: [m.id] })) })
  open.forEach((m, k) => { const t = toks[k].status === 'success' ? toks[k].result : [[], []]; m.tokens = [...t[0]]; m.fees = [...t[1]] })
  const legs = open.flatMap((m) => m.tokens.map((token, i) => ({ token, fee: m.fees[i] })))
  const poolRes = await pub.multicall({ multicallAddress: MULTICALL3, contracts: legs.map((l) => ({ address: FACTORY, abi: factoryAbi, functionName: 'getPool', args: [l.token, USDG, l.fee] })) })
  const poolOf = new Map()
  legs.forEach((l, k) => { if (poolRes[k].status === 'success') poolOf.set(`${l.token.toLowerCase()}:${l.fee}`, poolRes[k].result) })
  const allMoves = moves ?? (await readMoves([...poolOf.values()]))
  for (const m of open) {
    let traded = false
    for (let i = 0; i < m.tokens.length && !traded; i++) {
      const pool = poolOf.get(`${m.tokens[i].toLowerCase()}:${m.fees[i]}`)
      const mv = pool ? allMoves.get(pool.toLowerCase()) : undefined
      const move = mv === undefined ? undefined : typeof mv === 'number' ? mv : m.hourly ? mv.h1 : mv.h24
      if (move === undefined) continue
      const side = agentDecision(m.rule, m.param, move)
      if (!side) continue
      out.candidates++
      const sell = side === 'sell'
      try {
        let left = await pub.readContract({ ...c, functionName: 'leftToday', args: [m.id] })
        if (m.weekX) {
          const weekCap = m.perDay * BigInt(m.weekX)
          const weekSpent = await readWeekSpent(pub, address, m.id)
          const leftWeek = weekSpent >= weekCap ? 0n : weekCap - weekSpent
          if (leftWeek < left) left = leftWeek
          if (left < 1_000_000n) { out.skipped++; log(`mandate ${m.id}: ${AGENT_RULES[m.base]}, ${m.tokens[i].slice(0, 8)} moved ${move}%: over the week cap`); continue }
        }
        let amount
        if (!sell) {
          const [bal, allowance] = await Promise.all([
            pub.readContract({ address: USDG, abi: erc20Abi, functionName: 'balanceOf', args: [m.owner] }),
            pub.readContract({ address: USDG, abi: erc20Abi, functionName: 'allowance', args: [m.owner, address] }),
          ])
          const avail = bal < allowance ? bal : allowance
          const tip = m.tip ?? 0n
          const spendable = avail > tip ? avail - tip : 0n
          amount = [m.perTrade, m.budget, left, spendable].reduce((a, b) => (a < b ? a : b))
          if (amount < 1_000_000n) { out.skipped++; log(`mandate ${m.id}: ${AGENT_RULES[m.base]}, ${m.tokens[i].slice(0, 8)} moved ${move}%: USDG balance or allowance short`); continue }
        } else {
          const [bal, allowance] = await Promise.all([
            pub.readContract({ address: m.tokens[i], abi: erc20Abi, functionName: 'balanceOf', args: [m.owner] }),
            pub.readContract({ address: m.tokens[i], abi: erc20Abi, functionName: 'allowance', args: [m.owner, address] }),
          ])
          amount = bal < allowance ? bal : allowance
          if (amount === 0n) { out.skipped++; log(`mandate ${m.id}: ${AGENT_RULES[m.base]}, ${m.tokens[i].slice(0, 8)} moved ${move}%: nothing approved to sell`); continue }
          const value = await pub.readContract({ ...c, functionName: 'quoteSpot', args: [m.id, BigInt(i), true, amount] })
          const cap = m.perTrade < left ? m.perTrade : left
          if (value > cap) amount = (amount * cap * 999n) / (value * 1000n)
        }
        const code = Number(await pub.readContract({ ...c, functionName: 'check', args: [m.id, BigInt(i), sell, amount] }))
        if (code !== 0) { out.skipped++; log(`mandate ${m.id}: ${AGENT_RULES[m.base]}, ${m.tokens[i].slice(0, 8)} moved ${move}%: ${CHECK_CODES[code] ?? code}`); continue }
        const floor = await pub.readContract({ ...c, functionName: 'floorOut', args: [m.id, BigInt(i), sell, amount] })
        const sim = await pub.simulateContract({ ...c, functionName: 'execute', args: [m.id, BigInt(i), sell, amount, floor], account })
        const hash = await wallet.writeContract(sim.request)
        const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 })
        log(`mandate ${m.id}: ${r.status} ${hash} ${sell ? 'sold' : 'bought'} ${m.tokens[i].slice(0, 8)} ${m.hourly ? 'in a' : 'on a'} ${move}% ${m.hourly ? 'hour' : 'day'}, in ${sell ? formatUnits(amount, 18) : formatUnits(amount, 6) + ' USDG'}, out ${sell ? formatUnits(sim.result, 6) + ' USDG' : formatUnits(sim.result, 18)} gas ${r.gasUsed}`)
        if (r.status === 'success') { out.sent++; traded = true } else out.skipped++
      } catch (e) {
        // Balance or allowance short, or the pool moved past the floor: the mandate waits for the next pass.
        out.skipped++
        log(`mandate ${m.id}: skipped, ${(e.shortMessage ?? e.message ?? String(e)).split('\n')[0].slice(0, 140)}`)
      }
    }
  }
  return out
}

export async function executorBalance({ rpc = DEFAULT_RPC, key }) {
  const account = privateKeyToAccount(key)
  const pub = createPublicClient({ chain: chain(rpc), transport: http(rpc) })
  return { address: account.address, eth: Number(formatUnits(await pub.getBalance({ address: account.address }), 18)) }
}

// ---- refuel: the tips arrive in USDG, the gas is paid in ETH. When the ETH runs low, the executor sells its
// USDG for ETH through LI.FI on Robinhood Chain, so one small top-up at the start is the only ETH it ever needs.
const LIFI = 'https://li.quest/v1'
export const REFUEL_BELOW_ETH = 0.00015
export const REFUEL_MIN_USDG = 1

export async function refuelIfNeeded({ rpc = DEFAULT_RPC, key, log = console.log, force = false }) {
  const account = privateKeyToAccount(key)
  const pub = createPublicClient({ chain: chain(rpc), transport: http(rpc, { retryCount: 3, retryDelay: 1500, timeout: 30_000 }) })
  const wallet = createWalletClient({ account, chain: chain(rpc), transport: http(rpc) })
  const eth = Number(formatUnits(await pub.getBalance({ address: account.address }), 18))
  const usdgRaw = await pub.readContract({ address: USDG, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] })
  const usdg = Number(formatUnits(usdgRaw, 6))
  if (!force && (eth >= REFUEL_BELOW_ETH || usdg < REFUEL_MIN_USDG)) return { refueled: false, eth, usdg }
  if (usdg < REFUEL_MIN_USDG) return { refueled: false, eth, usdg, reason: 'not enough USDG' }
  const q = new URLSearchParams({ fromChain: '4663', toChain: '4663', fromToken: USDG, toToken: '0x0000000000000000000000000000000000000000', fromAmount: usdgRaw.toString(), fromAddress: account.address, integrator: 'verdex', slippage: '0.01' })
  const r = await fetch(`${LIFI}/quote?${q}`, { headers: process.env.LIFI_API_KEY ? { 'x-lifi-api-key': process.env.LIFI_API_KEY } : {} })
  if (!r.ok) throw new Error(`lifi quote ${r.status}`)
  const quote = await r.json()
  const spender = quote.estimate?.approvalAddress
  const tx = quote.transactionRequest
  if (!spender || !tx) throw new Error('lifi quote without a transaction')
  const allowance = await pub.readContract({ address: USDG, abi: erc20Abi, functionName: 'allowance', args: [account.address, spender] })
  if (allowance < usdgRaw) {
    const h = await wallet.sendTransaction({ to: USDG, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, usdgRaw] }) })
    await pub.waitForTransactionReceipt({ hash: h, timeout: 120_000 })
  }
  const hash = await wallet.sendTransaction({ to: tx.to, data: tx.data, value: BigInt(tx.value ?? 0), gas: tx.gasLimit ? BigInt(tx.gasLimit) : undefined })
  const rc = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 })
  const after = Number(formatUnits(await pub.getBalance({ address: account.address }), 18))
  log(`refuel: ${rc.status} ${hash} sold ${usdg.toFixed(2)} USDG via ${quote.tool}, ETH ${eth.toFixed(6)} → ${after.toFixed(6)}`)
  return { refueled: rc.status === 'success', eth: after, usdg: 0, hash }
}

// ---- treasury: every protocol fee lands in the treasury contract; the executor sweeps balances into VERDEX
// through a LI.FI route the contract checks against its own floor, and once a week pays the kept half back
// to the wallets that paid the fees, pro rata to the fees in the period.
const TREASURY_ABI = parseAbi([
  'function sweep(address tokenIn,uint256 amountIn,address router,address spender,bytes data,uint256 minOut) returns (uint256)',
  'function distribute(address[] to,uint256[] amounts)',
  'function rewardsAvailable() view returns (uint256)',
  'function isRouter(address) view returns (bool)',
  'function floorOut(address tokenIn,uint256 amountIn) view returns (uint256)',
  'event Distributed(uint256 indexed epoch,uint256 total,uint256 recipients)',
])
const ROUTER_FEE_EVENTS = parseAbi([
  'event Bought(address indexed index,address indexed buyer,address indexed to,uint256 shares,uint256 usdgIn,uint256 fee)',
  'event Sold(address indexed index,address indexed seller,address indexed to,uint256 shares,uint256 usdgOut,uint256 fee)',
])
const VERDEX = '0x96f455a90a80dcf0c2df6703ea4ba3bedf286e43'
export const SWEEP_MIN_USDG = 5
export const SWEEP_MIN_ETH = 0.002
export const DISTRIBUTE_EVERY_S = 7 * 24 * 3600

async function lifiRoute(from, fromToken, amount) {
  const q = new URLSearchParams({ fromChain: '4663', toChain: '4663', fromToken, toToken: VERDEX, fromAmount: amount.toString(), fromAddress: from, toAddress: from, integrator: 'verdex', slippage: '0.01', fee: '0' })
  const r = await fetch(`${LIFI}/quote?${q}`, { headers: process.env.LIFI_API_KEY ? { 'x-lifi-api-key': process.env.LIFI_API_KEY } : {} })
  if (!r.ok) throw new Error(`lifi quote ${r.status}`)
  const quote = await r.json()
  if (!quote.transactionRequest) throw new Error('lifi quote without a transaction')
  return quote
}

// Sweeps the treasury's USDG and ETH into VERDEX when either is worth doing. Each sweep is one call the
// contract guards with its floor; minOut is LI.FI's own minimum, which is tighter.
export async function treasurySweep({ rpc = DEFAULT_RPC, key, treasury, log = console.log, minUsdg = SWEEP_MIN_USDG, minEth = SWEEP_MIN_ETH }) {
  const account = privateKeyToAccount(key)
  const pub = createPublicClient({ chain: chain(rpc), transport: http(rpc, { retryCount: 3, retryDelay: 1500, timeout: 30_000 }) })
  const wallet = createWalletClient({ account, chain: chain(rpc), transport: http(rpc) })
  const out = { swept: [] }
  const usdg = await pub.readContract({ address: USDG, abi: erc20Abi, functionName: 'balanceOf', args: [treasury] })
  const eth = await pub.getBalance({ address: treasury })
  const legs = []
  if (Number(formatUnits(usdg, 6)) >= minUsdg) legs.push({ token: USDG, amount: usdg, label: `${formatUnits(usdg, 6)} USDG` })
  if (Number(formatUnits(eth, 18)) >= minEth) legs.push({ token: '0x0000000000000000000000000000000000000000', amount: eth, label: `${formatUnits(eth, 18)} ETH` })
  for (const leg of legs) {
    const quote = await lifiRoute(treasury, leg.token, leg.amount)
    const router = quote.transactionRequest.to
    if (!(await pub.readContract({ address: treasury, abi: TREASURY_ABI, functionName: 'isRouter', args: [router] }))) { log(`treasury: router ${router} not allowlisted, skipping ${leg.label}`); continue }
    const floor = await pub.readContract({ address: treasury, abi: TREASURY_ABI, functionName: 'floorOut', args: [leg.token, leg.amount] })
    const minOut = BigInt(quote.estimate.toAmountMin)
    if (minOut < floor) { log(`treasury: route for ${leg.label} returns ${formatUnits(minOut, 18)} VERDEX, under the floor ${formatUnits(floor, 18)}; waiting`); continue }
    const hash = await wallet.writeContract({ address: treasury, abi: TREASURY_ABI, functionName: 'sweep', args: [leg.token, leg.amount, router, quote.estimate.approvalAddress ?? router, quote.transactionRequest.data, minOut] })
    const rc = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 })
    log(`treasury: ${rc.status} ${hash} swept ${leg.label} via ${quote.tool}`)
    out.swept.push({ leg: leg.label, hash, status: rc.status })
  }
  return out
}

// Fee payers of the period: everyone who paid a fee through the Index router since the last payout.
export async function feePayersSince({ rpc = DEFAULT_RPC, routers = [], fromBlock, toBlock }) {
  const pub = createPublicClient({ chain: chain(rpc), transport: http(rpc, { retryCount: 3, retryDelay: 1500, timeout: 30_000 }) })
  const paid = new Map()
  for (const router of routers) {
    for (const ev of ROUTER_FEE_EVENTS) {
      const logs = await pub.getLogs({ address: router, event: ev, fromBlock, toBlock })
      for (const l of logs) { const who = (l.args.buyer ?? l.args.seller).toLowerCase(); const fee = l.args.fee ?? 0n; if (fee > 0n) paid.set(who, (paid.get(who) ?? 0n) + fee) }
    }
  }
  return paid
}

// Pays the kept VERDEX to the period's fee payers, pro rata to the USDG fees they paid. Runs when a week
// has passed since the last payout (or since the first fee, for the first one) and there is something to pay.
export async function treasuryDistribute({ rpc = DEFAULT_RPC, key, treasury, routers = [], fromBlockDefault, log = console.log, force = false }) {
  const account = privateKeyToAccount(key)
  const pub = createPublicClient({ chain: chain(rpc), transport: http(rpc, { retryCount: 3, retryDelay: 1500, timeout: 30_000 }) })
  const wallet = createWalletClient({ account, chain: chain(rpc), transport: http(rpc) })
  const available = await pub.readContract({ address: treasury, abi: TREASURY_ABI, functionName: 'rewardsAvailable' })
  if (available === 0n) return { paid: false, reason: 'nothing to pay' }
  const head = await pub.getBlockNumber()
  const since = head - 6_048_000n > 0n ? head - 6_048_000n : 0n // about a week of 0.1 s blocks
  const last = (await pub.getLogs({ address: treasury, event: TREASURY_ABI.find((x) => x.type === 'event' && x.name === 'Distributed'), fromBlock: since, toBlock: head })).at(-1)
  const lastBlock = last ? last.blockNumber : (fromBlockDefault ?? since)
  if (!force && last) {
    const at = Number((await pub.getBlock({ blockNumber: last.blockNumber })).timestamp)
    if (Date.now() / 1000 - at < DISTRIBUTE_EVERY_S) return { paid: false, reason: 'not a week yet' }
  }
  const payers = await feePayersSince({ rpc, routers, fromBlock: lastBlock + 1n, toBlock: head })
  const total = [...payers.values()].reduce((s, v) => s + v, 0n)
  if (total === 0n) return { paid: false, reason: 'no fee payers in the period' }
  const to = [...payers.keys()], amounts = to.map((a) => (available * payers.get(a)) / total)
  const hash = await wallet.writeContract({ address: treasury, abi: TREASURY_ABI, functionName: 'distribute', args: [to, amounts] })
  const rc = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 })
  log(`treasury: ${rc.status} ${hash} paid ${formatUnits(amounts.reduce((s, v) => s + v, 0n), 18)} VERDEX to ${to.length} wallets`)
  return { paid: rc.status === 'success', hash, recipients: to.length }
}

// ---- Auto-Invest into any index: one pass over VerdexIndexPlans, buying the due plans. The executor only picks the
// number of shares: as many as one buy's USDG covers at the contract's own cap (spot plus slippage), with room for the
// router's 0.25% fee. The contract re-checks every leg and the total.
const indexPlansAbi = parseAbi([
  'function planCount() view returns (uint256)',
  'function isDue(uint256 id) view returns (bool)',
  'function plan(uint256 id) view returns ((address owner,address index,uint96 amount,uint96 tip,uint32 interval,uint40 nextAt,uint32 buysLeft,uint32 buysDone,uint16 maxSlippageBps,bool paused,bool cancelled,uint128 spent,uint128 shares))',
  'function capFor(uint256 id,uint256 shares) view returns (uint256 total,uint256[] perLeg)',
  'function execute(uint256 id,uint256 shares) returns (uint256)',
])
export async function runIndexPlansOnce({ rpc = DEFAULT_RPC, address, key, log = console.log }) {
  const account = privateKeyToAccount(key)
  const pub = createPublicClient({ chain: chain(rpc), transport: http(rpc, { retryCount: 3, retryDelay: 1500, timeout: 30_000 }) })
  const wallet = createWalletClient({ account, chain: chain(rpc), transport: http(rpc) })
  const c = { address, abi: indexPlansAbi }
  const count = Number(await pub.readContract({ ...c, functionName: 'planCount' }))
  if (!count) return { count, due: 0, sent: 0, skipped: 0 }
  const ids = Array.from({ length: count }, (_, i) => BigInt(i))
  const due = await pub.multicall({ multicallAddress: MULTICALL3, contracts: ids.map((id) => ({ ...c, functionName: 'isDue', args: [id] })) })
  const todo = ids.filter((_, i) => due[i].status === 'success' && due[i].result === true)
  let sent = 0, skipped = 0
  for (const id of todo) {
    try {
      const p = await pub.readContract({ ...c, functionName: 'plan', args: [id] })
      const [capOne] = await pub.readContract({ ...c, functionName: 'capFor', args: [id, 10n ** 18n] })
      const shares = (BigInt(p.amount) * 10n ** 18n * 10_000n) / (capOne * 10_035n)
      const sim = await pub.simulateContract({ ...c, functionName: 'execute', args: [id, shares], account })
      const hash = await wallet.writeContract({ ...sim.request, gas: 3_500_000n })
      const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 })
      log(`index plan ${id}: ${r.status} ${hash} ${formatUnits(shares, 18)} shares for ${formatUnits(sim.result, 6)} USDG gas ${r.gasUsed}`)
      if (r.status === 'success') sent++
      else skipped++
    } catch (e) {
      skipped++
      log(`index plan ${id}: skipped, ${(e.shortMessage ?? e.message ?? String(e)).split('\n')[0].slice(0, 140)}`)
    }
  }
  return { count, due: todo.length, sent, skipped }
}
