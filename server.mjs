// Serves the built site and runs the Auto-Invest, Orders, Vaults and Agent executors every ten minutes from the same process.
// Static files come from dist/ with long cache headers for hashed assets, gzip for text, and the SPA
// fallback to index.html. The executor only runs when an executor key and a contract address exist.
import http from 'node:http'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { runOnce, runOrdersOnce, runVaultsOnce, runAgentOnce, runIndexPlansOnce, executorBalance, refuelIfNeeded, treasurySweep, treasuryDistribute } from './scripts/executor-lib.mjs'
import { TREASURY_ADDRESS } from './scripts/treasury-address.mjs'
import { INDEX_ROUTER_ADDRESS } from './scripts/index-addresses.mjs'
import { AUTOINVEST_ADDRESS as BUILT_IN, BASE_AUTOINVEST_ADDRESS as BASE_AUTOINVEST_BUILT_IN } from './scripts/autoinvest-address.mjs'
import { ORDERS_ADDRESS as ORDERS_BUILT_IN, BASE_ORDERS_ADDRESS as BASE_ORDERS_BUILT_IN } from './scripts/orders-address.mjs'
import { VAULTS_ADDRESS as VAULTS_BUILT_IN, BASE_VAULTS_ADDRESS as BASE_VAULTS_BUILT_IN } from './scripts/vaults-address.mjs'
import { AGENT_ADDRESS as AGENT_BUILT_IN } from './scripts/agent-address.mjs'
import { apiRead, isApiPath } from './scripts/api-lib.mjs'
import { relayClaim } from './scripts/gift-relay.mjs'
import { pushKey, pushPass, subscribe as pushSubscribe, unsubscribe as pushUnsubscribe, test as pushTest } from './scripts/push-lib.mjs'
import { INDEX_PLANS_ADDRESS as INDEX_PLANS_BUILT_IN } from './scripts/index-plans-address.mjs'

const ROOT = resolve('dist')
const PORT = Number(process.env.PORT ?? 8080)
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.webmanifest': 'application/manifest+json', '.map': 'application/json', '.mp4': 'video/mp4' }
const COMPRESS = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.txt', '.xml', '.webmanifest', '.map'])
const gz = new Map()

function send(req, res, file, status = 200) {
  const ext = extname(file).toLowerCase()
  const type = TYPES[ext] ?? 'application/octet-stream'
  const immutable = /\/assets\//.test(file) || /\/img\//.test(file) || /\/logos\//.test(file) || /\.(woff2?|png|webp|svg|mp4)$/.test(file)
  const headers = { 'content-type': type, 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache', 'x-content-type-options': 'nosniff' }
  if (COMPRESS.has(ext) && /\bgzip\b/.test(req.headers['accept-encoding'] ?? '')) {
    let buf = gz.get(file)
    if (!buf) { buf = gzipSync(readFileSync(file)); if (gz.size > 500) gz.clear(); gz.set(file, buf) }
    res.writeHead(status, { ...headers, 'content-encoding': 'gzip', 'content-length': buf.length, vary: 'accept-encoding' })
    return req.method === 'HEAD' ? res.end() : res.end(buf)
  }
  res.writeHead(status, { ...headers, 'content-length': statSync(file).size })
  return req.method === 'HEAD' ? res.end() : createReadStream(file).pipe(res)
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400' }); return res.end() }
  if (req.method === 'POST' && req.url === '/api/gift/claim') {
    let raw = ''
    req.on('data', (d) => { raw += d; if (raw.length > 4096) req.destroy() })
    req.on('end', () => {
      let body; try { body = JSON.parse(raw) } catch { body = null }
      const xff = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
      const ip = xff.length > 0 ? xff[xff.length - 1] : String(req.socket.remoteAddress ?? '').trim()
      relayClaim(key, ip, body)
        .then((r) => { res.writeHead(r.status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(r.body)) })
        .catch(() => { res.writeHead(500, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end('{"ok":false,"error":"relay failed"}') })
    })
    return
  }
  const PUSH = { '/api/push/subscribe': pushSubscribe, '/api/push/unsubscribe': pushUnsubscribe, '/api/push/test': pushTest }
  if (req.method === 'POST' && PUSH[req.url]) {
    let raw = ''
    req.on('data', (d) => { raw += d; if (raw.length > 4096) req.destroy() })
    req.on('end', () => { let body; try { body = JSON.parse(raw) } catch { body = null } Promise.resolve(PUSH[req.url](body)).then((r) => { res.writeHead(r.ok ? 200 : 400, { 'content-type': 'application/json' }); res.end(JSON.stringify(r)) }).catch(() => { res.writeHead(500); res.end() }) })
    return
  }
  if (req.method === 'GET' && req.url === '/api/push/key') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ key: pushKey() })) }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end() }
  let path
  try { path = decodeURIComponent(new URL(req.url, 'http://x').pathname) } catch { res.writeHead(400); return res.end() }
  // The API: the same reads the site makes, as JSON, cached sixty seconds, open to anyone.
  // Static files under /api (the site's own data, e.g. /api/assets.json) are served as files, not as endpoints.
  const apiKey = path.replace(/\/+$/, '') || '/api'
  if ((path === '/api' || path.startsWith('/api/')) && (isApiPath(apiKey) || !extname(path))) {
    const key = apiKey
    if (!isApiPath(key)) { res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' }); return res.end('{"ok":false,"error":"no such endpoint; GET /api lists them"}') }
    return apiRead(key).then((r) => { res.writeHead(r.status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=60', age: String(r.age) }); req.method === 'HEAD' ? res.end() : res.end(r.body) }).catch(() => { res.writeHead(500); res.end() })
  }
  const file = normalize(join(ROOT, path))
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end() }
  if (existsSync(file) && statSync(file).isFile()) return send(req, res, file)
  const index = join(file, 'index.html')
  if (existsSync(index)) return send(req, res, index)
  // Anything with an extension that is not there is a real 404; everything else is a client route.
  if (extname(path) && !path.endsWith('.html')) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found') }
  return send(req, res, join(ROOT, 'index.html'))
})
server.listen(PORT, () => { console.log(`verdex serving ${ROOT} on :${PORT}`); apiRead('/api/holders').catch(() => {}); if (!process.env.NO_WARM) setTimeout(warmCandles, 20_000); setInterval(() => pushPass((m) => console.log(`[push] ${m}`)).catch(() => {}), 90_000) })
// Keep every stock pool's daily candles in the cache, so charts, backtests and the league load at once. The fetches
// are paced inside the API library; a full round takes a few minutes and runs every twenty-five.
async function warmCandles() {
  for (const chain of ['robinhood', 'base']) {
    try {
      const r = JSON.parse((await apiRead(chain === 'base' ? '/api/pools/base' : '/api/pools')).body)
      for (const p of r.data ?? []) await apiRead(`/api/candles/${chain}/${p.pool}`).catch(() => {})
    } catch { /* next round */ }
  }
  setTimeout(warmCandles, 25 * 60_000)
}

// ---- executor ----
const key = process.env.EXECUTOR_KEY ?? (existsSync('executor.key') ? readFileSync('executor.key', 'utf8').trim() : '')
const address = process.env.AUTOINVEST_ADDRESS || BUILT_IN
const ordersAddress = process.env.ORDERS_ADDRESS || ORDERS_BUILT_IN
const vaultsAddress = process.env.VAULTS_ADDRESS || VAULTS_BUILT_IN
const agentAddress = process.env.AGENT_ADDRESS || AGENT_BUILT_IN
const baseOrdersAddress = process.env.BASE_ORDERS_ADDRESS || BASE_ORDERS_BUILT_IN
const baseAutoInvestAddress = process.env.BASE_AUTOINVEST_ADDRESS || BASE_AUTOINVEST_BUILT_IN
const baseVaultsAddress = process.env.BASE_VAULTS_ADDRESS || BASE_VAULTS_BUILT_IN
const indexPlansAddress = process.env.INDEX_PLANS_ADDRESS || INDEX_PLANS_BUILT_IN
const BASE_RPC = process.env.BASE_RPC || 'https://mainnet.base.org'
const EVERY = Number(process.env.EXECUTOR_EVERY_MS ?? 10 * 60 * 1000)
if (key && address) {
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try {
      const r = await runOnce({ rpc: process.env.RPC, address, key, log: (m) => console.log(`[executor] ${m}`) })
      if (r.due) console.log(`[executor] plans ${r.count} · due ${r.due} · sent ${r.sent} · skipped ${r.skipped}`)
      if (ordersAddress) {
        const o = await runOrdersOnce({ rpc: process.env.RPC, address: ordersAddress, key, log: (m) => console.log(`[executor] ${m}`) }).catch((e) => { console.log(`[executor] orders pass failed: ${(e.shortMessage ?? e.message ?? String(e)).slice(0, 160)}`); return null })
        if (o?.due) console.log(`[executor] orders ${o.count} · due ${o.due} · sent ${o.sent} · skipped ${o.skipped}`)
      }
      if (vaultsAddress) {
        const v = await runVaultsOnce({ rpc: process.env.RPC, address: vaultsAddress, key, log: (m) => console.log(`[executor] ${m}`) }).catch((e) => { console.log(`[executor] vaults pass failed: ${(e.shortMessage ?? e.message ?? String(e)).slice(0, 160)}`); return null })
        if (v?.due) console.log(`[executor] vaults ${v.count} · due ${v.due} · sent ${v.sent} · skipped ${v.skipped}`)
      }
      if (baseOrdersAddress) {
        const ob = await runOrdersOnce({ rpc: BASE_RPC, chainId: 8453, address: baseOrdersAddress, key, log: (m) => console.log(`[executor] ${m}`) }).catch((e) => { console.log(`[executor] base orders pass failed: ${(e.shortMessage ?? e.message ?? String(e)).slice(0, 160)}`); return null })
        if (ob?.due) console.log(`[executor] base orders ${ob.count} · due ${ob.due} · sent ${ob.sent} · skipped ${ob.skipped}`)
      }
      if (baseAutoInvestAddress) {
        const ab = await runOnce({ rpc: BASE_RPC, chainId: 8453, address: baseAutoInvestAddress, key, log: (m) => console.log(`[executor] ${m}`) }).catch((e) => { console.log(`[executor] base plans pass failed: ${(e.shortMessage ?? e.message ?? String(e)).slice(0, 160)}`); return null })
        if (ab?.due) console.log(`[executor] base plans ${ab.count} · due ${ab.due} · sent ${ab.sent} · skipped ${ab.skipped}`)
      }
      if (baseVaultsAddress) {
        const vb = await runVaultsOnce({ rpc: BASE_RPC, chainId: 8453, address: baseVaultsAddress, key, log: (m) => console.log(`[executor] ${m}`) }).catch((e) => { console.log(`[executor] base vaults pass failed: ${(e.shortMessage ?? e.message ?? String(e)).slice(0, 160)}`); return null })
        if (vb?.due) console.log(`[executor] base vaults ${vb.count} · due ${vb.due} · sent ${vb.sent} · skipped ${vb.skipped}`)
      }
      if (indexPlansAddress) {
        const ip = await runIndexPlansOnce({ rpc: process.env.RPC, address: indexPlansAddress, key, log: (m) => console.log(`[executor] ${m}`) }).catch((e) => { console.log(`[executor] index plans pass failed: ${(e.shortMessage ?? e.message ?? String(e)).slice(0, 160)}`); return null })
        if (ip?.due) console.log(`[executor] index plans ${ip.count} · due ${ip.due} · sent ${ip.sent} · skipped ${ip.skipped}`)
      }
      if (agentAddress) {
        const a = await runAgentOnce({ rpc: process.env.RPC, address: agentAddress, key, log: (m) => console.log(`[executor] ${m}`) }).catch((e) => { console.log(`[executor] agent pass failed: ${(e.shortMessage ?? e.message ?? String(e)).slice(0, 160)}`); return null })
        if (a?.candidates) console.log(`[executor] mandates ${a.count} · open ${a.open} · candidates ${a.candidates} · sent ${a.sent} · skipped ${a.skipped}`)
      }
      await refuelIfNeeded({ rpc: process.env.RPC, key, log: (m) => console.log(`[executor] ${m}`) }).catch((e) => console.log(`[executor] refuel failed: ${(e.shortMessage ?? e.message ?? String(e)).slice(0, 160)}`))
    } catch (e) {
      console.log(`[executor] pass failed: ${(e.shortMessage ?? e.message ?? String(e)).slice(0, 160)}`)
    } finally { running = false }
  }
  executorBalance({ rpc: process.env.RPC, key }).then((b) => console.log(`[executor] ${b.address} · ${b.eth.toFixed(6)} ETH · contract ${address} · every ${EVERY / 60000} min`)).catch(() => {})
  setTimeout(tick, 15_000)
  setInterval(tick, EVERY)
} else {
  console.log('[executor] off: no key or contract address')
}

// ---- treasury: sweep fees into VERDEX every six hours, pay the kept half back once a week ----
const treasury = process.env.TREASURY_ADDRESS || TREASURY_ADDRESS
const router = process.env.INDEX_ROUTER_ADDRESS || INDEX_ROUTER_ADDRESS
if (key && treasury) {
  const tlog = (m) => console.log(`[treasury] ${m}`)
  let busy = false
  const sweepTick = async () => {
    if (busy) return
    busy = true
    try { const r = await treasurySweep({ rpc: process.env.RPC, key, treasury, log: tlog }); if (r.swept.length === 0) tlog('nothing to sweep') } catch (e) { tlog(`sweep failed: ${(e.shortMessage ?? e.message ?? String(e)).slice(0, 160)}`) } finally { busy = false }
  }
  const payTick = async () => {
    if (busy) return
    busy = true
    try { const r = await treasuryDistribute({ rpc: process.env.RPC, key, treasury, routers: router ? [router] : [], log: tlog }); if (!r.paid && r.reason) tlog(`payout: ${r.reason}`) } catch (e) { tlog(`payout failed: ${(e.shortMessage ?? e.message ?? String(e)).slice(0, 160)}`) } finally { busy = false }
  }
  tlog(`${treasury} · sweep every 6 h · payout weekly`)
  setTimeout(sweepTick, 60_000)
  setInterval(sweepTick, Number(process.env.TREASURY_SWEEP_EVERY_MS ?? 6 * 3600 * 1000))
  setTimeout(payTick, 120_000)
  setInterval(payTick, Number(process.env.TREASURY_PAY_CHECK_EVERY_MS ?? 3600 * 1000))
} else {
  console.log('[treasury] off: no key or treasury address')
}
