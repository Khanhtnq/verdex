// Checks every active price alert against the pools each minute while the site is open.
import { useEffect } from 'react'
import { useAssets } from '../lib/api'
import { stockTokens, usePools } from '../lib/pools'
import { poolFor } from '../lib/autopilot'
import { notify, useWatch, watch } from '../lib/watch'

function Checker() {
  const s = useWatch()
  const assets = useAssets()
  const pools = usePools(assets.data?.assets)
  useEffect(() => {
    if (!assets.data || !pools.data) return
    const stocks = stockTokens(assets.data.assets)
    for (const a of s.alerts) {
      if (a.firedAt) continue
      const st = stocks.find((x) => x.ticker === a.ticker)
      const p = st ? poolFor(st, pools.data) : undefined
      if (!p) continue
      if ((a.dir === 'above' && p.priceUsd >= a.level) || (a.dir === 'below' && p.priceUsd <= a.level)) {
        watch.fire(a.id)
        notify(`${a.ticker} is ${a.dir} $${a.level}`, `${a.ticker} is at $${p.priceUsd.toFixed(2)} in its pool on Robinhood Chain.`, `/assets/${a.ticker}`)
      }
    }
  }, [s.alerts, assets.data, pools.data])
  return null
}
export function AlertWatcher() {
  const s = useWatch()
  return s.alerts.some((a) => !a.firedAt) ? <Checker /> : null
}
