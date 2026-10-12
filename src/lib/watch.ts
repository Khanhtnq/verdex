// Watchlist and price alerts, kept in this browser only (localStorage). A watcher mounted by the app checks the pools
// every minute while Verdex is open and notifies when a stock crosses a level.
import { useSyncExternalStore } from 'react'

export type Alert = { id: string; ticker: string; dir: 'above' | 'below'; level: number; createdAt: number; firedAt?: number }
export type WatchState = { tickers: string[]; alerts: Alert[] }
const KEY = 'verdex-watch-v1'
const empty: WatchState = { tickers: [], alerts: [] }
let cache: WatchState | null = null
const subs = new Set<() => void>()
function load(): WatchState {
  if (cache) return cache
  try { const v = JSON.parse(localStorage.getItem(KEY) ?? 'null'); cache = v && Array.isArray(v.tickers) && Array.isArray(v.alerts) ? v : empty } catch { cache = empty }
  return cache!
}
function save(next: WatchState) { cache = next; try { localStorage.setItem(KEY, JSON.stringify(next)) } catch { /* private mode: kept for this tab */ } subs.forEach((f) => f()) }
export function useWatch() {
  return useSyncExternalStore((cb) => { subs.add(cb); const on = (e: StorageEvent) => { if (e.key === KEY) { cache = null; cb() } }; window.addEventListener('storage', on); return () => { subs.delete(cb); window.removeEventListener('storage', on) } }, load, () => empty)
}
export const watch = {
  toggle(ticker: string) { const s = load(); save({ ...s, tickers: s.tickers.includes(ticker) ? s.tickers.filter((x) => x !== ticker) : [...s.tickers, ticker] }) },
  addAlert(ticker: string, dir: Alert['dir'], level: number) { const s = load(); save({ tickers: s.tickers.includes(ticker) ? s.tickers : [...s.tickers, ticker], alerts: [...s.alerts, { id: Math.random().toString(36).slice(2), ticker, dir, level, createdAt: Date.now() }] }) },
  removeAlert(id: string) { const s = load(); save({ ...s, alerts: s.alerts.filter((a) => a.id !== id) }) },
  fire(id: string) { const s = load(); save({ ...s, alerts: s.alerts.map((a) => (a.id === id ? { ...a, firedAt: Date.now() } : a)) }) },
}
export async function askNotify() {
  if (!('Notification' in window)) return 'unsupported'
  if (Notification.permission === 'default') return Notification.requestPermission()
  return Notification.permission
}
export function notify(title: string, body: string, url: string) {
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      const n = new Notification(title, { body, icon: '/favicon-verdex.svg', tag: title })
      n.onclick = () => { window.focus(); location.assign(url) }
    }
  } catch { /* some mobile browsers only notify from a service worker */ }
}
