// What a wallet's VERDEX balance unlocks. Two tiers, both read from the token contract on Robinhood
// Chain and nothing else: any balance removes the Verdex fee on every trade, and a balance of at least
// EARLY_ACCESS_BPS of the supply opens each new feature before it opens to everyone.
import { useSyncExternalStore } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createPublicClient, erc20Abi, formatUnits, http, type Address } from 'viem'
import { BRAND } from '../theme/tokens'
import { ROBINHOOD } from './api'

export const VERDEX_TOKEN = { chainId: ROBINHOOD, address: BRAND.contract as Address, symbol: 'VERDEX', decimals: 18 }

export const EARLY_ACCESS_BPS = 50
export const RPC = 'https://rpc.mainnet.chain.robinhood.com/'

export type Holding = {
  balance: bigint
  supply: bigint
  verdex: number
  sharePct: number
  holder: boolean
  early: boolean
  earlyAt: number
  toEarly: number
}

export type EarlyFeature = { path: string; label: string; opensAt: string }
// Features in their early-access window: holders at the threshold use them now, everyone else from opensAt (UTC).
export const EARLY_FEATURES: EarlyFeature[] = [
  { path: '/launch', label: 'Launchpad', opensAt: '2026-10-01T20:00:00Z' },
  { path: '/private-markets', label: 'Private Markets', opensAt: '2026-10-02T10:00:00Z' },
  { path: '/auto-invest/without-you', label: 'Auto-Invest without you', opensAt: '2026-10-02T20:00:00Z' },
  { path: '/index', label: 'Verdex Index', opensAt: '2026-10-03T19:00:00Z' },
  { path: '/lend/verdex', label: 'Verdex Lend', opensAt: '2026-10-04T18:00:00Z' },
  { path: '/leverage', label: 'Leverage', opensAt: '2026-10-05T01:00:00Z' },
  { path: '/solana', label: 'Verdex on Solana', opensAt: '2026-10-05T23:00:00Z' },
  { path: '/orders/without-you', label: 'Orders without you', opensAt: '2026-10-06T15:00:00Z' },
  { path: '/vaults/without-you', label: 'Vaults without you', opensAt: '2026-10-06T23:00:00Z' },
  { path: '/agent/without-you', label: 'Agent without you', opensAt: '2026-10-08T15:00:00Z' },
  { path: '/copy', label: 'Copy a wallet', opensAt: '2026-10-09T15:00:00Z' },
  { path: '/orders/without-you/base', label: 'Orders without you on Base', opensAt: '2026-10-10T23:00:00Z' },
  { path: '/auto-invest/without-you/base', label: 'Auto-Invest without you on Base', opensAt: '2026-10-11T15:00:00Z' },
  { path: '/vaults/without-you/base', label: 'Vaults without you on Base', opensAt: '2026-10-11T23:00:00Z' },
  { path: '/agent/without-you/rules', label: 'Agent rules v2', opensAt: '2026-10-12T15:00:00Z' },
  { path: '/holders', label: 'Holders', opensAt: '2026-10-12T23:00:00Z' },
  { path: '/stock', label: 'Charts', opensAt: '2026-10-13T15:00:00Z' },
  { path: '/backtest', label: 'Backtest', opensAt: '2026-10-13T23:00:00Z' },
  { path: '/index/create', label: 'Make your own index', opensAt: '2026-10-14T15:00:00Z' },
  { path: '/index/community', label: 'Community indexes', opensAt: '2026-10-14T23:00:00Z' },
  { path: '/gift', label: 'Gift a stock', opensAt: '2026-10-15T15:00:00Z' },
  { path: '/share', label: 'Share cards', opensAt: '2026-10-15T23:00:00Z' },
  { path: '/watchlist', label: 'Watchlist', opensAt: '2026-10-16T15:00:00Z' },
  { path: '/index/auto-invest', label: 'Auto-Invest into any index', opensAt: '2026-10-16T23:00:00Z' },
  { path: '/league', label: 'Index league', opensAt: '2026-10-17T15:00:00Z' },
]

const client = () => createPublicClient({ transport: http(RPC, { retryCount: 3, retryDelay: 1200, timeout: 20_000 }) })

export async function readHolding(owner: Address): Promise<Holding> {
  const c = client()
  const [balance, supply] = await Promise.all([
    c.readContract({ address: VERDEX_TOKEN.address, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }),
    c.readContract({ address: VERDEX_TOKEN.address, abi: erc20Abi, functionName: 'totalSupply' }),
  ])
  const threshold = (supply * BigInt(EARLY_ACCESS_BPS)) / 10_000n
  const verdex = Number(formatUnits(balance, VERDEX_TOKEN.decimals))
  const earlyAt = Number(formatUnits(threshold, VERDEX_TOKEN.decimals))
  return {
    balance,
    supply,
    verdex,
    sharePct: supply > 0n ? Number((balance * 1_000_000n) / supply) / 10_000 : 0,
    holder: balance > 0n,
    early: balance >= threshold && threshold > 0n,
    earlyAt,
    toEarly: Math.max(0, earlyAt - verdex),
  }
}

export const holdingKey = (owner?: Address) => ['holding', owner?.toLowerCase()]

export function useHolding(owner?: Address) {
  return useQuery({
    queryKey: holdingKey(owner),
    queryFn: () => readHolding(owner!),
    enabled: !!owner,
    staleTime: 60_000,
    retry: 2,
  })
}

// Call after a transaction that may have changed the wallet's VERDEX balance.
export function useRefreshHolding() {
  const qc = useQueryClient()
  return (owner?: Address) => qc.invalidateQueries({ queryKey: holdingKey(owner) })
}

export function earlyFeature(path: string) {
  const f = EARLY_FEATURES.find((x) => x.path === path)
  if (!f) return null
  const opensAt = Date.parse(f.opensAt)
  return Number.isFinite(opensAt) ? { ...f, opensAtMs: opensAt } : null
}

export const fmtVerdex = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : n.toFixed(0))

// The current time in 30-second steps, so a gate can compare against its opening time during render
// without an impure clock read. Subscribes to an interval only while active.
const TICK = 30_000
const noop = () => {}
export function useClock(active: boolean) {
  const bucket = useSyncExternalStore(
    (cb) => {
      if (!active) return noop
      const id = setInterval(cb, TICK)
      return () => clearInterval(id)
    },
    () => Math.floor(Date.now() / TICK),
    () => 0,
  )
  return bucket * TICK
}

// Whether a feature inside a page is open for this wallet: past its date, or early access by holding.
export function useFeatureOpen(path: string, owner?: Address) {
  const f = earlyFeature(path)
  const now = useClock(!!f)
  const holding = useHolding(f ? owner : undefined)
  return !f || (now > 0 && now + 30_000 > f.opensAtMs) || !!holding.data?.early
}
