// Web push for the Verdex app: a browser subscribes with the wallets it follows, and the server watches the Verdex
// contracts and pushes a notification when something happens to one of them: an order fills, an Auto-Invest or
// index plan runs, a vault rebalances, the agent trades, a term loan starts, is repaid or claimed, an option is
// bought or exercised. Subscriptions live on this server (a file in the temp dir); the app re-sends its subscription
// every time it opens, so a redeploy only pauses pushes until each phone opens the app once.
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import webpush from 'web-push'
import { createPublicClient, http, keccak256, toHex, getAddress } from 'viem'
import { ORDERS_ADDRESS, BASE_ORDERS_ADDRESS } from './orders-address.mjs'
import { AUTOINVEST_ADDRESS, BASE_AUTOINVEST_ADDRESS } from './autoinvest-address.mjs'
import { VAULTS_ADDRESS, BASE_VAULTS_ADDRESS } from './vaults-address.mjs'
import { AGENT_ADDRESS } from './agent-address.mjs'
import { INDEX_PLANS_ADDRESS } from './index-plans-address.mjs'
import { TERM_ADDRESS, OPTIONS_ADDRESS } from './p2p-address.mjs'

const keys = (() => {
  if (process.env.VAPID_PUBLIC && process.env.VAPID_PRIVATE) return { publicKey: process.env.VAPID_PUBLIC, privateKey: process.env.VAPID_PRIVATE }
  try { return JSON.parse(readFileSync(new URL('../vapid.json', import.meta.url), 'utf8')) } catch { return null }
})()
if (keys) webpush.setVapidDetails('https://useverdex.xyz', keys.publicKey, keys.privateKey)
export const pushKey = () => keys?.publicKey ?? null

const FILE = join(tmpdir(), 'verdex-push.json')
const subs = new Map() // endpoint -> { sub, addrs: string[] }
try { for (const s of JSON.parse(readFileSync(FILE, 'utf8'))) subs.set(s.sub.endpoint, s) } catch { /* none yet */ }
const save = () => { try { writeFileSync(FILE, JSON.stringify([...subs.values()])) } catch { /* best effort */ } }
const MAX_SUBS = 20_000
const PUSH_HOST_ALLOWLIST = /(^|\.)((fcm|android)\.googleapis\.com|google\.com|push\.services\.mozilla\.com|notify\.windows\.com|push\.apple\.com)$/i
export function isValidPushEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length > 2048) return false
  try {
    const u = new URL(endpoint)
    if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false
    return PUSH_HOST_ALLOWLIST.test(u.hostname)
  } catch {
    return false
  }
}
export function subscribe(body) {
  const sub = body?.subscription
  const addrs = (Array.isArray(body?.addresses) ? body.addresses : []).filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a)).slice(0, 5).map((a) => a.toLowerCase())
  if (!sub || !isValidPushEndpoint(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) return { ok: false, error: 'bad subscription' }
  if (!subs.has(sub.endpoint) && subs.size >= MAX_SUBS) return { ok: false, error: 'full' }
  subs.set(sub.endpoint, { sub: { endpoint: sub.endpoint, keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) } }, addrs })
  save()
  return { ok: true }
}
export function unsubscribe(body) { subs.delete(String(body?.endpoint ?? '')); save(); return { ok: true } }
export async function sendTo(addr, payload) {
  const a = addr.toLowerCase()
  for (const [ep, s] of subs) {
    if (!s.addrs.includes(a)) continue
    try { await webpush.sendNotification(s.sub, JSON.stringify(payload), { TTL: 6 * 3600 }) } catch (e) { if (e.statusCode === 404 || e.statusCode === 410) { subs.delete(ep); save() } }
  }
}
export async function test(body) {
  const s = subs.get(String(body?.endpoint ?? ''))
  if (!s) return { ok: false, error: 'not subscribed' }
  await webpush.sendNotification(s.sub, JSON.stringify({ title: 'Verdex', body: 'Notifications are on. You will hear from us when something runs.', url: '/notifications' })).catch(() => null)
  return { ok: true }
}

const topic = (sig) => keccak256(toHex(sig))
const word = (data, i) => getAddress(`0x${data.slice(2 + i * 64 + 24, 2 + (i + 1) * 64)}`)
// Which of a struct's leading words are the people to tell: the getter selector and the word index of each.
const getter = (sig) => keccak256(toHex(sig)).slice(0, 10)
const WATCH = [
  { chain: 'rh', address: ORDERS_ADDRESS, events: { [topic('Filled(uint256,address,uint256,uint256,uint256)')]: { title: 'Order filled', body: 'One of your orders just filled.', url: '/orders/without-you' } }, read: getter('orders(uint256)'), who: [0] },
  { chain: 'base', address: BASE_ORDERS_ADDRESS, events: { [topic('Filled(uint256,address,uint256,uint256,uint256)')]: { title: 'Order filled on Base', body: 'One of your orders on Base just filled.', url: '/orders/without-you?chain=base' } }, read: getter('orders(uint256)'), who: [0] },
  { chain: 'rh', address: AUTOINVEST_ADDRESS, events: { [topic('Executed(uint256,address,uint256,uint256,uint256,uint40)')]: { title: 'Auto-Invest ran', body: 'Your recurring buy just ran.', url: '/auto-invest/without-you' } }, read: getter('plans(uint256)'), who: [0] },
  { chain: 'base', address: BASE_AUTOINVEST_ADDRESS, events: { [topic('Executed(uint256,address,uint256,uint256,uint256,uint40)')]: { title: 'Auto-Invest ran on Base', body: 'Your recurring buy on Base just ran.', url: '/auto-invest/without-you?chain=base' } }, read: getter('plans(uint256)'), who: [0] },
  { chain: 'rh', address: VAULTS_ADDRESS, events: { [topic('Rebalanced(uint256,address,uint256,uint256,uint256,uint256)')]: { title: 'Vault rebalanced', body: 'Your vault just rebalanced back to its targets.', url: '/vaults/without-you' } }, read: getter('vaults(uint256)'), who: [0] },
  { chain: 'base', address: BASE_VAULTS_ADDRESS, events: { [topic('Rebalanced(uint256,address,uint256,uint256,uint256,uint256)')]: { title: 'Vault rebalanced on Base', body: 'Your vault on Base just rebalanced.', url: '/vaults/without-you?chain=base' } }, read: getter('vaults(uint256)'), who: [0] },
  { chain: 'rh', address: AGENT_ADDRESS, events: { [topic('Traded(uint256,address,address,bool,uint256,uint256,uint256)')]: { title: 'Your agent traded', body: 'Your agent just made a trade within its mandate.', url: '/agent/without-you' } }, read: getter('mandates(uint256)'), who: [0] },
  { chain: 'rh', address: INDEX_PLANS_ADDRESS, events: { [topic('Bought(uint256,address,uint256,uint256,uint256,uint40)')]: { title: 'Index buy ran', body: 'Your index Auto-Invest just bought shares.', url: '/index/auto-invest' } }, read: getter('plan(uint256)'), who: [0] },
  { chain: 'rh', address: TERM_ADDRESS, events: {
    [topic('Started(uint256,uint256,address,address,uint256,uint256,uint256,uint40)')]: { title: 'Term loan started', body: 'A term loan of yours just started.', url: '/lend/term' },
    [topic('Repaid(uint256,address)')]: { title: 'Loan repaid', body: 'A term loan was repaid and the collateral released.', url: '/lend/term' },
    [topic('Claimed(uint256)')]: { title: 'Collateral claimed', body: 'An unpaid term loan ended and the lender took the collateral.', url: '/lend/term' },
  }, read: getter('loan(uint256)'), who: [1, 2] },
  { chain: 'rh', address: OPTIONS_ADDRESS, events: {
    [topic('Bought(uint256,address,uint256)')]: { title: 'Option sold', body: 'Someone bought an option you wrote. The premium is in your wallet.', url: '/options' },
    [topic('Exercised(uint256,address)')]: { title: 'Option exercised', body: 'An option you wrote or hold was just exercised.', url: '/options' },
  }, read: getter('option(uint256)'), who: [0, 1] },
]
const CHAINS = { rh: process.env.RPC || 'https://rpc.mainnet.chain.robinhood.com/', base: process.env.BASE_RPC || 'https://mainnet.base.org' }
const clients = Object.fromEntries(Object.entries(CHAINS).map(([k, url]) => [k, createPublicClient({ transport: http(url) })]))
const last = {}
export async function pushPass(log = () => {}) {
  if (!keys || subs.size === 0) return 0
  let sent = 0
  for (const [chain, c] of Object.entries(clients)) {
    const head = await c.getBlockNumber().catch(() => null)
    if (head === null) continue
    const from = last[chain] === undefined ? head - 50n : last[chain] + 1n
    if (from > head) continue
    const to = head - from > 4000n ? from + 4000n : head
    const watch = WATCH.filter((w) => w.chain === chain)
    const logs = await c.getLogs({ address: watch.map((w) => w.address), fromBlock: from, toBlock: to }).catch(() => null)
    if (!logs) continue
    last[chain] = to
    for (const l of logs) {
      const w = watch.find((x) => x.address.toLowerCase() === l.address.toLowerCase())
      const msg = w?.events[l.topics[0]]
      if (!msg) continue
      const r = await c.call({ to: w.address, data: `${w.read}${l.topics[1].slice(2)}` }).catch(() => null)
      if (!r?.data) continue
      for (const i of w.who) { await sendTo(word(r.data, i), msg); sent++ }
    }
  }
  if (sent) log(`push: ${sent} notifications`)
  return sent
}
