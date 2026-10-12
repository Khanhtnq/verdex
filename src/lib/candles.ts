// Daily candles of one pool, through the Verdex API's thirty-minute cache (/api/candles/<chain>/<pool>), and the
// small amount of maths the charts and backtests need on top of them.
import { useQuery } from '@tanstack/react-query'

export type Candle = { t: number; o: number; h: number; l: number; c: number; v: number }
export type ChainKey = 'robinhood' | 'base'
export async function readCandles(chain: ChainKey, pool: string): Promise<Candle[]> {
  const r = await fetch(`/api/candles/${chain}/${pool}`)
  if (!r.ok) throw new Error(`candles ${r.status}`)
  const j = await r.json()
  if (!j.ok) throw new Error(j.error ?? 'candles')
  return (j.data.candles as number[][]).map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }))
}
export function useCandles(chain: ChainKey, pool: string | undefined) {
  return useQuery({ queryKey: ['candles', chain, pool?.toLowerCase()], queryFn: () => readCandles(chain, pool!), enabled: !!pool, staleTime: 15 * 60_000, retry: 1 })
}
// The move from the close `days` candles ago to the last close, in percent; undefined when history is shorter.
export function moveOver(cs: Candle[], days: number) {
  if (cs.length < 2) return undefined
  const last = cs[cs.length - 1].c
  const ref = cs.length > days ? cs[cs.length - 1 - days].c : undefined
  return ref ? (last / ref - 1) * 100 : undefined
}
