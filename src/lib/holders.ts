// VERDEX holders, from the Verdex API (/api/holders): every wallet holding VERDEX, read from the token's transfer
// history and each balance read from the token. The server keeps the scan; the browser only reads the result.
import { useQuery } from '@tanstack/react-query'

export type HolderRow = { address: string; verdex: number; share: number; kind: 'wallet' | 'contract' | 'pool'; since: number }
export type Holders = {
  chain: string; token: string; supply: number; readAt: string
  holders: number; contracts: number; inPool: number; earlyAccessBps: number; earlyAccess: number
  newHolders: { day: number; week: number }; transfers: { day: number; total: number }
  buckets: { label: string; count: number }[]; top10Share: number
  series: { day: number; holders: number }[]
  list: HolderRow[]
}
export async function readHolders(): Promise<Holders> {
  const r = await fetch('/api/holders')
  if (!r.ok) throw new Error(`holders ${r.status}`)
  const j = await r.json()
  if (!j.ok) throw new Error(j.error ?? 'holders')
  return j.data as Holders
}
export function useHolders() {
  return useQuery({ queryKey: ['holders'], queryFn: readHolders, staleTime: 60_000, refetchInterval: 120_000, retry: 2 })
}
// Where a wallet stands: its rank among wallets (pool and contracts left out), its share, and what it needs for early access.
export function standing(h: Holders, address: string | undefined) {
  if (!address) return null
  const people = h.list.filter((r) => r.kind === 'wallet')
  const i = people.findIndex((r) => r.address.toLowerCase() === address.toLowerCase())
  const me = i >= 0 ? people[i] : undefined
  const need = (h.supply * h.earlyAccessBps) / 10_000
  return { rank: i >= 0 ? i + 1 : null, of: people.length, verdex: me?.verdex ?? 0, share: me?.share ?? 0, since: me?.since, toEarly: Math.max(0, need - (me?.verdex ?? 0)), early: (me?.verdex ?? 0) >= need, topPct: i >= 0 ? Math.max(1, Math.ceil(((i + 1) / people.length) * 100)) : null }
}
