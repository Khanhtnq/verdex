// Strategies: published target allocations with a change log, followed into the user's own vault.
// A manager publishes weights and a note for every change; a follower's vault remembers which version
// it adopted, shows when a newer one exists, and adopts it with one tap. The trades that follow are
// the vault's normal rebalance, confirmed in the wallet. A vault can also be shared as a link that
// carries its weights, so anyone can publish a strategy without touching the registry.
import { useQuery } from '@tanstack/react-query'
import type { Address } from 'viem'
import { pub } from './base'
import type { Asset } from './api'
import { addVault, defaultQuote, nextRunAfter, normalise, toVaultAsset, updateVault, type Rule, type Vault, type VaultAsset } from './vaults'

export type Change = { at: string; note: string; weights: [string, number][] }
export type Manager = { name: string; handle?: string; about?: string }
export type Strategy = { id: string; manager: Manager; name: string; tagline: string; about: string; chainId: number; rule: Rule; threshold: number; history: Change[] }
export type StrategiesFile = { updatedAt: string; about: string; strategies: Strategy[] }

export const SITE = 'https://useverdex.xyz'
export const REPO = 'https://github.com/useverdex/verdex'
export const versionOf = (s: Strategy) => s.history.length
export const current = (s: Strategy) => s.history[s.history.length - 1]

export function useStrategies() {
  return useQuery({
    queryKey: ['strategies'],
    queryFn: async () => {
      const r = await fetch(pub('/data/strategies.json'))
      if (!r.ok) throw new Error('strategies')
      return (await r.json()) as StrategiesFile
    },
    staleTime: 5 * 60_000,
  })
}

// Weights become vault assets using the chain's version of each ticker; tickers the chain lacks are dropped.
export function weightsToAssets(weights: [string, number][], assets: Asset[], chainId: number): VaultAsset[] {
  const out: VaultAsset[] = []
  for (const [ticker, w] of weights) {
    const a = assets.find((x) => x.ticker === ticker)
    const v = a && toVaultAsset(a, chainId, w)
    if (v) out.push(v)
  }
  return normalise(out)
}

export function followStrategy(s: Strategy, assets: Asset[], owner: Address) {
  const built = weightsToAssets(current(s).weights, assets, s.chainId)
  if (built.length < 2) throw new Error('This strategy needs assets that are not issued on its chain yet.')
  const q = defaultQuote(s.chainId)
  return addVault({ owner, name: s.name, chainId: s.chainId, quote: { chainId: q.chainId, address: q.address, symbol: q.symbol, decimals: q.decimals }, assets: built, rule: s.rule, threshold: s.threshold, nextRunAt: nextRunAfter(Date.now(), s.rule), follow: { id: s.id, version: versionOf(s), manager: s.manager.name, name: s.name } })
}

// The newer published version of the strategy a vault follows, if there is one.
export function pendingUpdate(v: Vault, list: Strategy[] | undefined): Strategy | undefined {
  if (!v.follow || !list) return undefined
  const s = list.find((x) => x.id === v.follow!.id)
  return s && versionOf(s) > v.follow.version ? s : undefined
}
export function adoptUpdate(v: Vault, s: Strategy, assets: Asset[]) {
  const built = weightsToAssets(current(s).weights, assets, v.chainId)
  if (built.length < 2) throw new Error('The new weights need assets that are not issued on this chain yet.')
  updateVault(v.id, { assets: built, rule: s.rule, threshold: s.threshold, follow: { ...v.follow!, version: versionOf(s) } })
}
export function unfollow(v: Vault) {
  updateVault(v.id, { follow: undefined })
}

// Share links carry a vault's targets in the URL, nothing else.
export type Share = { n: string; c: number; w: [string, number][]; r: Rule; t: number; m?: string }
const b64 = (s: string) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const unb64 = (s: string) => decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4))))
export function encodeShare(v: Pick<Vault, 'name' | 'chainId' | 'assets' | 'rule' | 'threshold'>, manager?: string) {
  const share: Share = { n: v.name, c: v.chainId, w: v.assets.map((a) => [a.ticker, Math.round(a.weight * 10) / 10]), r: v.rule, t: v.threshold, ...(manager ? { m: manager } : {}) }
  return b64(JSON.stringify(share))
}
const cleanText = (s: string) => s.replace(/\p{Cc}+/gu, ' ').replace(/\s+/g, ' ').trim()
export function decodeShare(code: string): Share | null {
  try {
    const s = JSON.parse(unb64(code)) as Share
    if (!s || typeof s.n !== 'string' || !Array.isArray(s.w) || !s.w.length || typeof s.c !== 'number') return null
    const n = cleanText(s.n).slice(0, 40)
    const m = typeof s.m === 'string' ? cleanText(s.m).slice(0, 40) || undefined : undefined
    const w = s.w.filter((x) => Array.isArray(x) && typeof x[0] === 'string' && typeof x[1] === 'number' && Number.isFinite(x[1]) && x[1] > 0).slice(0, 12) as [string, number][]
    if (!n || !w.length) return null
    return { n, c: s.c, w, r: (['week', 'month', 'quarter', 'drift'] as Rule[]).includes(s.r) ? s.r : 'month', t: [2, 5, 10].includes(s.t) ? s.t : 5, m }
  } catch {
    return null
  }
}
export const shareUrl = (code: string) => `${SITE}/strategies?s=${code}`
export function followShare(sh: Share, assets: Asset[], owner: Address) {
  const built = weightsToAssets(sh.w, assets, sh.c)
  if (built.length < 2) throw new Error('This link needs assets that are not issued on its chain yet.')
  const q = defaultQuote(sh.c)
  return addVault({ owner, name: sh.n, chainId: sh.c, quote: { chainId: q.chainId, address: q.address, symbol: q.symbol, decimals: q.decimals }, assets: built, rule: sh.r, threshold: sh.t, nextRunAt: nextRunAfter(Date.now(), sh.r), sharedBy: sh.m })
}
