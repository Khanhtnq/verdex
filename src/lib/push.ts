// Push notifications: this device subscribes with the wallets it follows; the server pushes when one of them has an
// order fill, a plan run, a vault rebalance, an agent trade, a term loan or an option event (scripts/push-lib.mjs).
const KEY = 'verdex-push-follow'
export const pushSupported = () => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
export function followed(): string[] {
  try { const v = JSON.parse(localStorage.getItem(KEY) ?? '[]'); return Array.isArray(v) ? v.filter((a) => typeof a === 'string') : [] } catch { return [] }
}
function setFollowed(a: string[]) { try { localStorage.setItem(KEY, JSON.stringify(a)) } catch { /* private mode */ } }
const b64 = (s: string) => { const p = '='.repeat((4 - (s.length % 4)) % 4); const raw = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(raw, (c) => c.charCodeAt(0)) }
async function registration() {
  const reg = (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.register('/sw.js'))
  await navigator.serviceWorker.ready
  return reg
}
async function send(sub: PushSubscription, addresses: string[]) {
  const r = await fetch('/api/push/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subscription: sub.toJSON(), addresses }) })
  const j = await r.json().catch(() => ({ ok: false }))
  if (!j.ok) throw new Error(j.error ?? 'The server did not take the subscription')
}
export async function current() {
  if (!pushSupported()) return null
  const reg = await navigator.serviceWorker.getRegistration()
  return (await reg?.pushManager.getSubscription()) ?? null
}
export async function enable(addresses: string[]) {
  if (!pushSupported()) throw new Error('This browser has no push notifications. On iPhone, add Verdex to the home screen first.')
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notifications are blocked for this site in the browser settings')
  const { key } = await (await fetch('/api/push/key')).json()
  if (!key) throw new Error('Notifications are not set up on the server yet')
  const reg = await registration()
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(key) }))
  const list = [...new Set(addresses.map((a) => a.toLowerCase()))].slice(0, 5)
  await send(sub, list)
  setFollowed(list)
}
export async function disable() {
  const sub = await current()
  if (sub) { await fetch('/api/push/unsubscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => null); await sub.unsubscribe() }
  setFollowed([])
}
export async function sendTest() {
  const sub = await current()
  if (sub) await fetch('/api/push/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) })
}
// On every app open: re-send the subscription, so the server always has it.
export async function refreshPush() {
  if (!pushSupported() || Notification.permission !== 'granted' || followed().length === 0) return
  const sub = await current()
  if (sub) await send(sub, followed()).catch(() => null)
}
