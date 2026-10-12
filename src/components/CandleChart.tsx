// A daily candle chart drawn as SVG: bodies and wicks, a hover readout, and the window's high and low.
import { useMemo, useState } from 'react'
import { Box, Typography } from '@mui/material'
import { t } from '../theme/tokens'
import type { Candle } from '../lib/candles'

const UP = '#C2EA8A', DOWN = '#F87171'
const money = (v: number) => (v >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 0 }) : v >= 1 ? v.toFixed(2) : v.toPrecision(3))
const day = (s: number) => new Date(s * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

export function CandleChart({ candles, height = 300 }: { candles: Candle[]; height?: number }) {
  const [hover, setHover] = useState<number | null>(null)
  const W = 1000, H = 300, padY = 12
  const { lo, hi } = useMemo(() => ({ lo: Math.min(...candles.map((c) => c.l)), hi: Math.max(...candles.map((c) => c.h)) }), [candles])
  if (!candles.length) return <Box sx={{ height }} />
  const n = candles.length, step = W / n, bw = Math.max(1.5, step * 0.62)
  const y = (v: number) => padY + (1 - (v - lo) / (hi - lo || 1)) * (H - padY * 2)
  const cur = candles[hover ?? n - 1]
  return (
    <Box>
      <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', fontSize: 12, color: t.color.textMuted, minHeight: 18 }}>
        <span>{day(cur.t)}</span><span>O {money(cur.o)}</span><span>H {money(cur.h)}</span><span>L {money(cur.l)}</span><span style={{ color: cur.c >= cur.o ? UP : DOWN }}>C {money(cur.c)}</span>
      </Box>
      <Box component="svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" sx={{ width: '100%', height, display: 'block', mt: 1, cursor: 'crosshair' }} role="img" aria-label={`Daily candles from ${day(candles[0].t)} to ${day(candles[n - 1].t)}, low ${money(lo)}, high ${money(hi)}`}
        onMouseMove={(e) => { const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect(); setHover(Math.min(n - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * n)))) }} onMouseLeave={() => setHover(null)}>
        {[0.25, 0.5, 0.75].map((f) => <line key={f} x1={0} x2={W} y1={padY + f * (H - padY * 2)} y2={padY + f * (H - padY * 2)} stroke="rgba(255,255,255,.06)" vectorEffect="non-scaling-stroke" />)}
        {candles.map((c, i) => {
          const x = i * step + step / 2, col = c.c >= c.o ? UP : DOWN
          const top = y(Math.max(c.o, c.c)), bot = y(Math.min(c.o, c.c))
          return (
            <g key={c.t} opacity={hover === null || hover === i ? 1 : 0.55}>
              <line x1={x} x2={x} y1={y(c.h)} y2={y(c.l)} stroke={col} strokeWidth={1} vectorEffect="non-scaling-stroke" />
              <rect x={x - bw / 2} y={top} width={bw} height={Math.max(1, bot - top)} fill={col} rx={0.5} />
            </g>
          )
        })}
      </Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', mt: 0.75 }}>
        <Typography sx={{ fontSize: 11, color: t.color.textLabel }}>{day(candles[0].t)}</Typography>
        <Typography sx={{ fontSize: 11, color: t.color.textLabel }}>low {money(lo)} · high {money(hi)}</Typography>
        <Typography sx={{ fontSize: 11, color: t.color.textLabel }}>{day(candles[n - 1].t)}</Typography>
      </Box>
    </Box>
  )
}
// A small close-price line for lists.
export function Spark({ candles, w = 96, h = 28 }: { candles: Candle[]; w?: number; h?: number }) {
  if (candles.length < 2) return <Box sx={{ width: w, height: h }} />
  const cs = candles.map((c) => c.c), lo = Math.min(...cs), hi = Math.max(...cs)
  const d = cs.map((v, i) => `${i ? 'L' : 'M'}${((i / (cs.length - 1)) * w).toFixed(1)},${(h - 2 - ((v - lo) / (hi - lo || 1)) * (h - 4)).toFixed(1)}`).join(' ')
  return <Box component="svg" viewBox={`0 0 ${w} ${h}`} sx={{ width: w, height: h, display: 'block' }} aria-hidden><path d={d} fill="none" stroke={cs[cs.length - 1] >= cs[0] ? UP : DOWN} strokeWidth={1.5} /></Box>
}
