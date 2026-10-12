// Share cards, drawn on a canvas in the browser: nothing is uploaded, the image is made from numbers read from the chain.
export type CardRow = { label: string; value: string; share: number; logo?: string }
export type Card = { kicker: string; title: string; big: string; sub: string; rows: CardRow[]; series?: number[]; benchmark?: number[]; foot: string }

const W = 1200, H = 675
const LIME = '#C2EA8A', BG = '#050505', MUTED = 'rgba(255,255,255,.55)', TILE = '#141414'
const img = (src?: string) => new Promise<HTMLImageElement | null>((res) => { if (!src) return res(null); const i = new Image(); i.crossOrigin = 'anonymous'; i.onload = () => res(i); i.onerror = () => res(null); i.src = src })

export async function drawCard(canvas: HTMLCanvasElement, c: Card, mark?: string) {
  await document.fonts.ready
  canvas.width = W; canvas.height = H
  const g = canvas.getContext('2d')!
  g.fillStyle = BG; g.fillRect(0, 0, W, H)
  g.strokeStyle = 'rgba(255,255,255,.035)'; g.lineWidth = 1
  for (let x = 0; x < W; x += 60) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke() }
  for (let y = 0; y < H; y += 60) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke() }
  const glow = g.createRadialGradient(W * 0.3, H * 0.4, 10, W * 0.3, H * 0.4, 600); glow.addColorStop(0, 'rgba(194,234,138,.14)'); glow.addColorStop(1, 'rgba(194,234,138,0)'); g.fillStyle = glow; g.fillRect(0, 0, W, H)
  // header
  const m = await img(mark)
  if (m) g.drawImage(m, 60, 52, 34, 34)
  g.fillStyle = '#fff'; g.font = '500 26px Geist, sans-serif'; g.fillText('Verdex', m ? 104 : 60, 79)
  g.fillStyle = LIME; g.font = '600 15px Geist, sans-serif'; const kw = g.measureText(c.kicker.toUpperCase()).width
  g.fillStyle = 'rgba(194,234,138,.14)'; round(g, W - 60 - kw - 32, 52, kw + 32, 36, 10); g.fill(); g.fillStyle = LIME; g.fillText(c.kicker.toUpperCase(), W - 60 - kw - 16, 76)
  // title and big number
  g.fillStyle = MUTED; g.font = '500 22px Geist, sans-serif'; g.fillText(fit(g, c.title, 520), 60, 160)
  g.fillStyle = '#fff'; g.font = '400 88px "LT Remark", Georgia, serif'; g.fillText(fit(g, c.big, 540), 56, 252)
  g.fillStyle = 'rgba(255,255,255,.72)'; g.font = '500 22px Geist, sans-serif'; g.fillText(fit(g, c.sub, 540), 60, 296)
  // chart
  if (c.series && c.series.length > 1) {
    const x0 = 60, y0 = 340, w = 520, h = 210
    const all = [...c.series, ...(c.benchmark ?? [])], lo = Math.min(...all), hi = Math.max(...all)
    const path = (v: number[], col: string, lw: number) => { g.strokeStyle = col; g.lineWidth = lw; g.beginPath(); v.forEach((p, i) => { const x = x0 + (i / (v.length - 1)) * w, y = y0 + (1 - (p - lo) / (hi - lo || 1)) * h; if (i) g.lineTo(x, y); else g.moveTo(x, y) }); g.stroke() }
    if (c.benchmark) path(c.benchmark, 'rgba(255,255,255,.35)', 2)
    path(c.series, LIME, 4)
  }
  // rows
  const rx = 640, rw = 500
  let y = 130
  for (const r of c.rows.slice(0, 8)) {
    g.fillStyle = TILE; round(g, rx, y, rw, 50, 12); g.fill()
    const li = await img(r.logo)
    if (li) { g.save(); g.beginPath(); g.arc(rx + 30, y + 25, 13, 0, Math.PI * 2); g.clip(); g.drawImage(li, rx + 17, y + 12, 26, 26); g.restore() }
    g.fillStyle = '#fff'; g.font = '600 20px Geist, sans-serif'; g.fillText(r.label, rx + 56, y + 32)
    g.fillStyle = 'rgba(194,234,138,.22)'; round(g, rx + 180, y + 20, Math.max(4, 190 * Math.min(1, r.share)), 10, 5); g.fill()
    g.fillStyle = MUTED; g.font = '500 18px Geist, sans-serif'; const vw = g.measureText(r.value).width; g.fillText(r.value, rx + rw - 18 - vw, y + 32)
    y += 60
  }
  g.fillStyle = MUTED; g.font = '500 18px Geist, sans-serif'; g.fillText(fit(g, c.foot, 1080), 60, H - 50)
  g.fillStyle = '#fff'; g.font = '600 18px Geist, sans-serif'; const u = 'useverdex.xyz'; g.fillText(u, W - 60 - g.measureText(u).width, H - 50)
}
function round(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath() }
function fit(g: CanvasRenderingContext2D, s: string, max: number) { let t = s; while (t.length > 3 && g.measureText(t).width > max) t = t.slice(0, -2); return t === s ? s : `${t}…` }
