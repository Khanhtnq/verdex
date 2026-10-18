// Agent without you: a budget and rules for the agent, kept by a contract on Robinhood Chain and worked while the
// owner is away. The page creates mandates, approves what they may spend, lists them with their limits and their
// trades, and pauses, tops up, closes or revokes them.
import { useMemo, useState } from 'react'
import { Avatar, Box, Button, InputBase, Typography } from '@mui/material'
import { Link, useSearchParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { formatUnits, parseUnits } from 'viem'
import { BRAND, t, z } from '../theme/tokens'
import { Bt, Lt, Vg } from '../theme/styles'
import { ROBINHOOD, fmtCompact, useAssets, useChains } from '../lib/api'
import { earlyFeature, useClock, useHolding } from '../lib/holding'
import { describeError, explorerTx, type ChainX } from '../lib/lifi'
import { PHASE_LABEL, USDG, stockTokens, usePools, type Phase, type Pool, type StockToken } from '../lib/pools'
import { BUDGETS, CONTRACT, COOLDOWNS, DEFAULT_SLIPPAGE_BPS, DEFAULT_TIP, DEPLOYED, EXPIRIES, PARAMS, PER_TRADES, RULES, WEEK_X, decodeRule, windowPhrase, approveHoldings, approveUsdg, budgetAllowance, closeMandate, cooldownPhrase, createMandate, deepEnough, explorerAddress, fmtUsdg, fmtWhen, pct, poolFor, revokeAll, ruleFor, setPaused, topUp, useAgentTotals, useOnchainMandates, useTrades, type OnchainMandate, type Pick, type Rule } from '../lib/agentOnchain'
import { resolveImg } from '../lib/img'
import { useWallet } from '../components/wallet/WalletProvider'
import { CheckIcon, ExternalIcon, LockIcon, PauseIcon, RefreshIcon, ShieldIcon, SparkIcon, WalletIcon } from '../components/icons'
import { MarkIcon } from '../components/Logo'
import { Page, PageHero, Panel, Stats } from './common'

type Ctx = ReturnType<typeof useWallet>
type Tx = { phase: Phase; error?: string; hash?: string }
const txCtx = (w: Ctx, chain: ChainX | undefined, onPhase: (p: Phase) => void) => ({ walletClient: w.walletClient!, account: w.account!, chain, switchChain: w.switchChain, onPhase })

function Label({ children }: { children: React.ReactNode }) {
  return <Typography sx={{ ...t.type.overline, color: t.color.textLabel, mb: 1.25 }}>{children}</Typography>
}
function Choice({ on, onClick, children, disabled }: { on: boolean; onClick: () => void; children: React.ReactNode; disabled?: boolean }) {
  return (
    <Box component="button" type="button" onClick={onClick} disabled={disabled} aria-pressed={on} sx={{ all: 'unset', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.4 : 1, display: 'inline-flex', alignItems: 'center', gap: '8px', height: 34, px: '12px', borderRadius: t.radius.input, fontSize: 13, fontWeight: 500, background: on ? t.color.text : t.color.chip, color: on ? t.color.page : t.color.text, '&:hover': { background: on ? t.color.text : t.color.hover } }}>
      {children}
    </Box>
  )
}
function Step({ n, icon, title, text }: { n: number; icon: React.ReactNode; title: string; text: string }) {
  return (
    <Panel sx={{ p: 3 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Box sx={{ width: 44, height: 44, borderRadius: '12px', background: t.color.hover, display: 'grid', placeItems: 'center', color: t.color.mark }}>{icon}</Box>
        <Typography sx={{ ...t.type.caption, color: t.color.textFaint }}>0{n}</Typography>
      </Box>
      <Typography sx={{ ...t.type.cardTitle, color: t.color.text, mt: 2.5 }}>{title}</Typography>
      <Typography sx={{ ...t.type.small, color: t.color.textMuted, mt: 1 }}>{text}</Typography>
    </Panel>
  )
}
function Row({ k, v, strong }: { k: string; v: React.ReactNode; strong?: boolean }) {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 2, fontSize: 13 }}>
      <Typography sx={{ fontSize: 13, color: t.color.textMuted }}>{k}</Typography>
      <Typography sx={{ fontSize: 13, fontWeight: strong ? 500 : 400, textAlign: 'right' }}>{v}</Typography>
    </Box>
  )
}
const usd = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}`)
const units = (v: bigint, d = 18) => { const n = Number(formatUnits(v, d)); return n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n.toFixed(4) }
// What a mandate does, in one sentence, for the summary row and the card.
const cap = (s: string) => s[0].toUpperCase() + s.slice(1)
function describeMandate(rule: Rule, paramBps: number, tickers: string[], perTrade: number, hourly = false) {
  const w = windowPhrase(hourly)
  if (rule.side === 'both') return `Buys ${usd(perTrade)} of ${list(tickers)} whenever one is ${pct(paramBps)} or more down ${w}, sells up to ${usd(perTrade)} of it whenever one is ${pct(paramBps)} or more up ${w}`
  const move = `${pct(paramBps)} or more ${rule.id === 0 || rule.id === 3 ? 'down' : 'up'} ${w}`
  return rule.side === 'buy' ? `${cap(rule.verb)} ${usd(perTrade)} of ${list(tickers)} whenever one is ${move}` : `${cap(rule.verb)} up to ${usd(perTrade)} of ${list(tickers)} whenever one is ${move}`
}

// Rules v2 (both ways, the hourly window, weekly caps) open on their date; holders at the threshold have them now.
function useRulesV2(owner: `0x${string}` | undefined) {
  const f = earlyFeature('/agent/without-you/rules')
  const now = useClock(!!f)
  const holding = useHolding(f ? owner : undefined)
  return !f || now + 30_000 > f.opensAtMs || !!holding.data?.early
}

// The composer. A proposal from the Agent page arrives in the query string and fills it in.
function Composer({ stocks, pools, loading, wallet, chain, onDone }: { stocks: StockToken[]; pools: Pool[]; loading: boolean; wallet: Ctx; chain: ChainX | undefined; onDone: () => void }) {
  const [params] = useSearchParams()
  const q = (k: string) => params.get(k) ?? ''
  const [rule, setRule] = useState<Rule>(() => RULES.find((r) => r.key === q('rule')) ?? RULES[0])
  const [param, setParam] = useState(() => (PARAMS.includes(Number(q('param'))) ? Number(q('param')) : 300))
  const [hourly, setHourly] = useState(() => q('window') === 'hour')
  const [weekX, setWeekX] = useState(() => { const n = Number(q('perWeek')) / (Number(q('perDay')) || 1); return n > 0 && WEEK_X.includes(n) ? n : 0 })
  const v2 = useRulesV2(wallet.account?.address)
  const [wanted] = useState(() => q('tokens').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean))
  const [custom, setCustom] = useState<Pick[] | null>(null)
  const [perTrade, setPerTrade] = useState(() => (PER_TRADES.includes(Number(q('perTrade'))) ? Number(q('perTrade')) : 100))
  const [perDayX, setPerDayX] = useState(() => { const n = Number(q('perDay')) / Number(q('perTrade') || 100); return [1, 2, 3, 5].includes(n) ? n : 2 })
  const [budget, setBudget] = useState(() => (BUDGETS.includes(Number(q('budget'))) ? Number(q('budget')) : 500))
  const [cooldown, setCooldown] = useState(() => COOLDOWNS.find((c) => c.seconds === Number(q('cooldown'))) ?? COOLDOWNS[1])
  const [expiry, setExpiry] = useState(() => EXPIRIES.find((e) => e.seconds === Number(q('expires'))) ?? EXPIRIES[0])
  const [tx, setTx] = useState<Tx>({ phase: 'idle' })
  const [more, setMore] = useState(false)
  // The picks are derived: the tickers the proposal named (or NVDA to start), until the user touches the list.
  const picks = useMemo<Pick[]>(() => {
    if (custom) return custom
    const want = wanted.length ? wanted : ['NVDA']
    return want.map((tk) => { const stock = stocks.find((s) => s.ticker === tk); const pool = stock ? poolFor(stock, pools) : undefined; return stock && pool && deepEnough(pool) ? { stock, pool } : undefined }).filter((x): x is Pick => !!x)
  }, [custom, wanted, stocks, pools])
  const toggle = (s: StockToken) => {
    const pool = poolFor(s, pools)
    if (!pool) return
    setCustom(picks.some((x) => x.stock.address === s.address) ? picks.filter((x) => x.stock.address !== s.address) : [...picks, { stock: s, pool }])
  }
  const perDay = perTrade * perDayX
  const busy = tx.phase !== 'idle' && tx.phase !== 'done' && tx.phase !== 'failed'
  const ok = picks.length >= 1 && picks.length <= 12 && perTrade > 0 && (rule.side === 'sell' || budget >= perTrade) && (v2 || (rule.id < 4 && !hourly && !weekX))
  const ready = !!wallet.account && ok && !busy
  const tickers = picks.map((p) => p.stock.ticker)
  const budgetRaw = rule.side !== 'sell' ? parseUnits(String(budget), USDG.decimals) : 0n
  const allowance = budgetAllowance({ budget: budgetRaw, perTrade: parseUnits(String(perTrade), USDG.decimals), tip: DEFAULT_TIP })
  const go = async () => {
    if (!wallet.walletClient || !wallet.account) return
    setTx({ phase: 'switching' })
    try {
      const ctx = txCtx(wallet, chain, (p) => setTx((x) => ({ ...x, phase: p })))
      const hash = await createMandate(ctx, { picks, rule, hourly: v2 && hourly, weekX: v2 ? weekX : 0, paramBps: param, budget: budgetRaw, perTrade: parseUnits(String(perTrade), USDG.decimals), perDay: parseUnits(String(perDay), USDG.decimals), slippageBps: DEFAULT_SLIPPAGE_BPS, cooldown: cooldown.seconds, expiresIn: expiry.seconds, tip: DEFAULT_TIP })
      if (rule.side !== 'sell') await approveUsdg(ctx, allowance)
      if (rule.side !== 'buy') await approveHoldings(ctx, picks.map((p) => p.stock.address))
      setTx({ phase: 'done', hash })
      onDone()
    } catch (e) {
      setTx({ phase: 'failed', error: describeError(e) })
    }
  }
  const shown = useMemo(() => (more ? stocks : stocks.filter((s) => picks.some((x) => x.stock.address === s.address) || ['NVDA', 'TSLA', 'SPY', 'AAPL', 'GOOGL', 'META', 'MSFT', 'AMZN', 'QQQ', 'SPCX', 'MU', 'AMD', 'TSM', 'PLTR'].includes(s.ticker))), [stocks, picks, more])
  return (
    <Panel sx={{ p: { xs: 2.5, md: 3 } }}>
      <Label>The rule</Label>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>{(v2 ? RULES : RULES.filter((r) => r.id < 4)).map((r) => <Choice key={r.id} on={r.id === rule.id} onClick={() => setRule(r)}>{r.name}</Choice>)}</Box>
      <Typography sx={{ fontSize: 12, color: t.color.textLabel, mt: 1.25 }}>{rule.blurb}</Typography>
      <Box sx={{ mt: 2.5 }}>
        <Label>When a stock is {rule.side === 'both' ? 'down or up' : rule.id === 0 || rule.id === 3 ? 'down' : 'up'} {windowPhrase(hourly)} by</Label>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>{PARAMS.map((b) => <Choice key={b} on={param === b} onClick={() => setParam(b)}>{pct(b)} or more</Choice>)}</Box>
        {v2 && (
          <Box sx={{ mt: 2.5 }}>
            <Label>The move, measured</Label>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}><Choice on={!hourly} onClick={() => setHourly(false)}>On the day</Choice><Choice on={hourly} onClick={() => setHourly(true)}>In the last hour</Choice></Box>
            <Typography sx={{ fontSize: 12, color: t.color.textLabel, mt: 1.25 }}>{hourly ? 'The executor reads each stock\'s move over the last hour, every ten minutes. Faster to fire; mind the cooldown.' : 'The executor reads each stock\'s move on the day, every ten minutes.'}</Typography>
          </Box>
        )}
      </Box>
      <Box sx={{ mt: 2.5 }}>
        <Label>In</Label>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
          {shown.map((s) => (
            <Choice key={s.address} on={picks.some((x) => x.stock.address === s.address)} onClick={() => toggle(s)} disabled={!deepEnough(poolFor(s, pools))}>
              <Avatar src={resolveImg(s.logo)} sx={{ width: 16, height: 16, background: z.surface2, fontSize: 8 }}>{s.ticker[0]}</Avatar>
              {s.ticker}
            </Choice>
          ))}
          {stocks.length > 0 && <Choice on={false} onClick={() => setMore((m) => !m)}>{more ? 'Fewer' : `All ${stocks.length}`}</Choice>}
        </Box>
        {loading && stocks.length === 0 && <Typography sx={{ fontSize: 12, color: t.color.textLabel, mt: 1.25 }}>Reading the stock pools on Robinhood Chain…</Typography>}
        {picks.length > 0 && <Typography sx={{ fontSize: 12, color: t.color.textLabel, mt: 1.25 }}>{picks.map((p) => `${p.stock.ticker} ${p.pool.fee / 10_000}% pool · ${fmtCompact(p.pool.liquidityUsd)}`).join(' · ')}</Typography>}
      </Box>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 2.5, mt: 3 }}>
        <Box>
          <Label>Per trade</Label>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>{PER_TRADES.map((v) => <Choice key={v} on={perTrade === v} onClick={() => setPerTrade(v)}>{usd(v)}</Choice>)}</Box>
        </Box>
        <Box>
          <Label>Per day, at most</Label>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>{[1, 2, 3, 5].map((n) => <Choice key={n} on={perDayX === n} onClick={() => setPerDayX(n)}>{usd(perTrade * n)}</Choice>)}</Box>
        </Box>
        {v2 && (
          <Box>
            <Label>Per week, at most</Label>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>{WEEK_X.map((n) => <Choice key={n} on={weekX === n} onClick={() => setWeekX(n)}>{n ? usd(perDay * n) : 'No weekly cap'}</Choice>)}</Box>
          </Box>
        )}
        {rule.side !== 'sell' && (
          <Box>
            <Label>Budget, in all</Label>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>{BUDGETS.map((v) => <Choice key={v} on={budget === v} onClick={() => setBudget(v)} disabled={v < perTrade}>{usd(v)}</Choice>)}</Box>
          </Box>
        )}
        <Box>
          <Label>Same stock at most every</Label>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>{COOLDOWNS.map((c) => <Choice key={c.key} on={c.key === cooldown.key} onClick={() => setCooldown(c)}>{c.label}</Choice>)}</Box>
        </Box>
        <Box>
          <Label>For</Label>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>{EXPIRIES.map((e) => <Choice key={e.key} on={e.key === expiry.key} onClick={() => setExpiry(e)}>{e.label}</Choice>)}</Box>
        </Box>
      </Box>
      <Box sx={{ mt: 3, p: 2, borderRadius: t.radius.panel, background: t.color.raised, display: 'grid', gap: 1 }}>
        <Row k="The mandate" v={ok ? describeMandate(rule, param, tickers, perTrade, hourly) : '…'} strong />
        <Row k="Caps" v={`${usd(perTrade)} a trade, ${usd(perDay)} a day${weekX ? `, ${usd(perDay * weekX)} a week` : ''}${rule.side !== 'sell' ? `, ${usd(budget)} in all` : ''}, the same stock ${cooldownPhrase(cooldown.seconds)}`} />
        <Row k="Price floor" v={`${DEFAULT_SLIPPAGE_BPS / 100}% below spot, read at trade time`} />
        <Row k="Tip to whoever runs it" v={`${fmtUsdg(DEFAULT_TIP)} per trade${rule.side === 'buy' ? ', pulled with the buy' : rule.side === 'sell' ? ', from the sale proceeds' : ', pulled with a buy or from a sale'}`} />
        <Row k="Allowance" v={rule.side === 'buy' ? `USDG, exactly ${fmtUsdg(allowance)}: the budget plus the tips` : rule.side === 'sell' ? 'each stock, exactly what you hold today' : `USDG, exactly ${fmtUsdg(allowance)}, and each stock for what you hold today`} />
        <Row k="Ends" v={expiry.seconds ? `in ${expiry.label}, or when you close it` : 'when you close it'} />
        <Row k={`${BRAND.name} fee`} v="None" />
      </Box>
      <Button onClick={() => (wallet.account ? void go() : wallet.openWalletMenu())} disabled={!!wallet.account && !ready} sx={{ ...Bt, width: '100%', mt: 2.5, height: 44 }}>
        {!wallet.account ? 'Connect wallet' : busy ? PHASE_LABEL[tx.phase] : rule.side === 'buy' ? 'Create the mandate and approve the USDG' : rule.side === 'sell' ? 'Create the mandate and approve the holdings' : 'Create the mandate and approve USDG and the holdings'}
      </Button>
      {tx.phase === 'failed' && <Typography sx={{ fontSize: 12, color: t.color.red, mt: 1.5 }}>{tx.error}</Typography>}
      {tx.phase === 'done' && tx.hash && chain && (
        <Box sx={{ mt: 2, p: 2, borderRadius: t.radius.panel, background: 'rgba(194,234,138,.10)', border: '1px solid rgba(194,234,138,.3)' }}>
          <Typography sx={{ fontSize: 14, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 1 }}><CheckIcon size={16} /> The mandate is on the chain.</Typography>
          <Typography sx={{ fontSize: 13, color: t.color.textMuted, mt: 0.5 }}>The agent checks the stocks every ten minutes and trades only inside the limits you set, from the allowance you approved. Close the tab; it does not need you.</Typography>
          <Box component="a" href={explorerTx(chain, ROBINHOOD, tx.hash)} target="_blank" rel="noopener noreferrer" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, mt: 1, fontSize: 13, color: t.color.text, textDecoration: 'none' }}>Transaction <ExternalIcon size={12} /></Box>
        </Box>
      )}
    </Panel>
  )
}

function MandateCard({ m, wallet, chain, onChanged }: { m: OnchainMandate; wallet: Ctx; chain: ChainX | undefined; onChanged: () => void }) {
  const [tx, setTx] = useState<Tx>({ phase: 'idle' })
  const [extra, setExtra] = useState('100')
  const now = useClock(m.state === 'active')
  const rule = ruleFor(m.rule) ?? RULES[0]
  const { hourly, weekX } = decodeRule(m.rule)
  const busy = tx.phase !== 'idle' && tx.phase !== 'done' && tx.phase !== 'failed'
  const act = async (fn: (ctx: ReturnType<typeof txCtx>) => Promise<unknown>) => {
    if (!wallet.walletClient || !wallet.account) return
    setTx({ phase: 'switching' })
    try { await fn(txCtx(wallet, chain, (ph) => setTx((x) => ({ ...x, phase: ph })))); setTx({ phase: 'done' }); onChanged() } catch (e) { setTx({ phase: 'failed', error: describeError(e) }) }
  }
  const tickers = m.legs.map((l) => l.stock?.ticker ?? l.token.slice(0, 6))
  const needUsdg = rule.side !== 'sell' ? budgetAllowance(m) : 0n
  const usdgShort = m.state === 'active' && rule.side !== 'sell' && m.budget >= 1_000_000n && m.usdgAllowance < (needUsdg < m.perTrade + m.tip ? needUsdg : m.perTrade + m.tip)
  const stocksShort = m.state === 'active' && rule.side !== 'buy' ? m.legs.filter((l) => l.balance > 0n && l.allowance === 0n) : []
  const dot = m.state === 'active' ? t.color.mark : m.state === 'paused' ? '#FFE866' : t.color.textFaint
  const label = m.state === 'active' ? 'Watching, checks every ten minutes' : m.state === 'paused' ? 'Paused' : m.state === 'closed' ? 'Closed' : m.state === 'expired' ? 'Expired' : 'Budget spent'
  const open = m.state === 'active' || m.state === 'paused' || m.state === 'spent'
  const extraRaw = (() => { try { return parseUnits(extra.replace(/[^0-9.]/g, '') || '0', USDG.decimals) } catch { return 0n } })()
  return (
    <Panel sx={{ p: 2.5 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
        <Box sx={{ width: 44, height: 44, borderRadius: '12px', background: t.color.hover, display: 'grid', placeItems: 'center', color: t.color.mark, flexShrink: 0 }}><SparkIcon size={20} /></Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography sx={{ fontSize: 15, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
            {rule.name} · {tickers.join(' · ')}
            <Box component="span" sx={{ width: 8, height: 8, borderRadius: '50%', background: dot }} />
            <Box component="span" sx={{ fontSize: 12, color: t.color.textMuted, fontWeight: 400 }}>{label}</Box>
          </Typography>
          <Typography sx={{ fontSize: 12, color: t.color.textMuted }}>
            {describeMandate(rule, m.param, tickers, Number(formatUnits(m.perTrade, USDG.decimals)), hourly)} · {fmtUsdg(m.perDay, 0)} a day{weekX ? ` · ${fmtUsdg(m.perDay * BigInt(weekX), 0)} a week` : ''}{rule.side !== 'sell' ? ` · ${fmtUsdg(m.budget)} left to spend` : ''} · same stock {cooldownPhrase(m.cooldown)}{m.expiresAt ? ` · until ${fmtWhen(m.expiresAt)}` : ''} · mandate #{String(m.id)}
          </Typography>
        </Box>
      </Box>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 2 }}>
        {m.legs.map((l) => {
          const cool = l.lastTradeAt && now > 0 && now / 1000 < l.lastTradeAt + m.cooldown
          return (
            <Box key={l.token} sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75, height: 30, px: 1.25, borderRadius: t.radius.input, background: t.color.raised, fontSize: 12 }}>
              <Avatar src={resolveImg(l.stock?.logo)} sx={{ width: 16, height: 16, background: z.surface2, fontSize: 8 }}>{(l.stock?.ticker ?? '?')[0]}</Avatar>
              <b style={{ fontWeight: 500 }}>{l.stock?.ticker ?? l.token.slice(0, 6)}</b>
              <span style={{ color: t.color.textMuted }}>{rule.side === 'sell' ? `${units(l.balance)} held${l.allowance === 0n && l.balance > 0n ? ' · approve' : ''}` : l.lastTradeAt ? `last ${fmtWhen(l.lastTradeAt)}${cool ? ', cooling' : ''}` : 'no trade yet'}</span>
            </Box>
          )
        })}
      </Box>
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 1, mt: 2 }}>
        {[['Today', `${fmtUsdg(m.perDay - m.leftToday, 0)} of ${fmtUsdg(m.perDay, 0)}`], ['Trades', String(m.trades)], rule.side === 'sell' ? ['Sold in all', fmtUsdg(m.sold)] : ['Spent in all', fmtUsdg(m.spent)], ['Last trade', m.lastTrade ? fmtWhen(m.lastTrade) : 'none yet']].map(([k, v]) => (
          <Box key={k} sx={{ p: 1.25, borderRadius: t.radius.input, background: t.color.raised }}>
            <Typography sx={{ fontSize: 11, color: t.color.textLabel }}>{k}</Typography>
            <Typography sx={{ fontSize: 14, fontWeight: 500 }}>{v}</Typography>
          </Box>
        ))}
      </Box>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 2, alignItems: 'center' }}>
        {usdgShort && <Button disabled={busy} onClick={() => void act((c) => approveUsdg(c, needUsdg, false))} sx={{ ...Bt, height: 34, px: 1.75 }}>Approve {fmtUsdg(needUsdg)} USDG</Button>}
        {stocksShort.length > 0 && <Button disabled={busy} onClick={() => void act((c) => approveHoldings(c, stocksShort.map((l) => l.token)))} sx={{ ...Bt, height: 34, px: 1.75 }}>Approve {stocksShort.map((l) => l.stock?.ticker ?? '?').join(', ')}</Button>}
        {open && <Button disabled={busy} onClick={() => void act((c) => setPaused(c, m.id, m.state !== 'paused'))} sx={{ ...Lt, backdropFilter: 'none', height: 34, px: 1.75, gap: 0.75 }}>{m.state !== 'paused' ? <><PauseIcon size={13} /> Pause</> : <><RefreshIcon size={13} /> Resume</>}</Button>}
        {open && rule.side !== 'sell' && (
          <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
            <InputBase value={extra} onChange={(e) => setExtra(e.target.value)} inputProps={{ 'aria-label': 'Top-up amount', inputMode: 'decimal' }} startAdornment={<span style={{ fontSize: 13, color: t.color.textMuted, marginRight: 4 }}>$</span>} sx={{ width: 90, height: 34, px: 1, borderRadius: t.radius.input, background: t.color.hover, fontSize: 13 }} />
            <Button disabled={busy || extraRaw === 0n} onClick={() => void act(async (c) => { const nextNeed = budgetAllowance({ budget: m.budget + extraRaw, perTrade: m.perTrade, tip: m.tip }); const delta = nextNeed > needUsdg ? nextNeed - needUsdg : 0n; const add = m.usdgAllowance + delta >= nextNeed; await topUp(c, m.id, extraRaw); await approveUsdg(c, add ? delta : nextNeed, add) })} sx={{ ...Lt, backdropFilter: 'none', height: 34, px: 1.75 }}>Top up</Button>
          </Box>
        )}
        {open && <Button disabled={busy} onClick={() => void act((c) => closeMandate(c, m.id))} sx={{ ...Lt, backdropFilter: 'none', height: 34, px: 1.75 }}>Close</Button>}
        <Button disabled={busy} onClick={() => void act((c) => revokeAll(c, m.legs.map((l) => l.token)))} sx={{ ...Lt, backdropFilter: 'none', height: 34, px: 1.75, color: t.color.red }}>Revoke allowances</Button>
        {busy && <Typography sx={{ fontSize: 12, color: t.color.textMuted }}>{PHASE_LABEL[tx.phase]}</Typography>}
      </Box>
      {tx.phase === 'failed' && <Typography sx={{ fontSize: 12, color: t.color.red, mt: 1 }}>{tx.error}</Typography>}
    </Panel>
  )
}

function TradeList({ ids, mandates, chain }: { ids: bigint[]; mandates: OnchainMandate[]; chain: ChainX | undefined }) {
  const trades = useTrades(ids)
  if (!trades.data?.length) return null
  return (
    <Panel sx={{ p: 2.5 }}>
      <Typography sx={{ fontSize: 14, fontWeight: 500, mb: 1.5 }}>Trades</Typography>
      <Box sx={{ display: 'grid', gap: 0.75 }}>
        {trades.data.slice(0, 20).map((x) => {
          const leg = mandates.find((m) => m.id === x.id)?.legs.find((l) => l.token.toLowerCase() === x.token.toLowerCase())
          const tk = leg?.stock?.ticker ?? x.token.slice(0, 6)
          return (
            <Box key={x.hash + String(x.id)} sx={{ display: 'flex', alignItems: 'center', gap: 1.5, fontSize: 13 }}>
              <Avatar src={resolveImg(leg?.stock?.logo)} sx={{ width: 18, height: 18, background: z.surface2, fontSize: 8 }}>{tk[0]}</Avatar>
              <span style={{ flex: 1 }}>{x.sell ? `Sold ${units(x.amountIn)} ${tk} for ${fmtUsdg(x.amountOut)}` : `Bought ${units(x.amountOut)} ${tk} for ${fmtUsdg(x.amountIn)}`} <span style={{ color: t.color.textMuted }}>· tip {fmtUsdg(x.tip)} · mandate #{String(x.id)}</span></span>
              {chain && <Box component="a" href={explorerTx(chain, ROBINHOOD, x.hash)} target="_blank" rel="noopener noreferrer" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, color: t.color.text, textDecoration: 'none', fontSize: 12 }}>tx <ExternalIcon size={11} /></Box>}
            </Box>
          )
        })}
      </Box>
    </Panel>
  )
}

export default function AgentWithoutYouPage() {
  const wallet = useWallet()
  const { account, openWalletMenu } = wallet
  const { data: chains } = useChains()
  const chain = chains?.find((c) => c.id === ROBINHOOD) as ChainX | undefined
  const assets = useAssets()
  const pools = usePools(assets.data?.assets)
  const stocks = useMemo(() => (assets.data ? stockTokens(assets.data.assets).filter((s) => deepEnough(poolFor(s, pools.data ?? []))) : []), [assets.data, pools.data])
  const mandates = useOnchainMandates(account?.address, assets.data?.assets)
  const totals = useAgentTotals()
  const qc = useQueryClient()
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['agent-onchain'] }); void qc.invalidateQueries({ queryKey: ['agent-onchain-totals'] }); void qc.invalidateQueries({ queryKey: ['agent-onchain-trades'] }) }
  const mine = useMemo(() => mandates.data ?? [], [mandates.data])
  const ids = useMemo(() => mine.map((m) => m.id), [mine])

  return (
    <Page>
      <PageHero
        label="Agent without you"
        badges={<Box sx={{ ...Vg, ml: 0, background: 'rgba(194,234,138,.16)', color: t.color.mark }}>{DEPLOYED ? 'Live' : 'Contract not deployed'}</Box>}
        title={<>A budget and rules.<br />It works inside them.</>}
        lead="Give the agent a mandate on Robinhood Chain: the stocks it may trade, the rule it follows, how much USDG per trade, per day and in all, how often, with what floor, until when. The contract enforces every limit; the agent applies the rule to each stock's move on the day, every ten minutes, and trades from your allowance with the stock landing in your wallet. Nothing held between trades. No fee."
        action={
          <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
            <Button onClick={() => (account ? document.getElementById('agent-composer')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) : openWalletMenu())} sx={{ ...Bt, gap: 1 }}>
              <SparkIcon size={15} /> {account ? 'Create a mandate' : 'Connect wallet'}
            </Button>
            <Button component={Link} to="/agent" sx={{ ...Lt, backdropFilter: 'none', gap: 1 }}>
              <WalletIcon size={14} /> Ask the agent to draft one
            </Button>
          </Box>
        }
      />

      <Stats items={[{ label: 'Mandates', value: totals.data ? totals.data.mandates : DEPLOYED ? '…' : '0' }, { label: 'Active', value: totals.data ? totals.data.active : DEPLOYED ? '…' : '0' }, { label: 'Trades', value: totals.data ? totals.data.trades : DEPLOYED ? '…' : '0' }, { label: `${BRAND.name} fee`, value: '0%' }]} />
      <Typography sx={{ fontSize: 13, color: t.color.textLabel, mt: 1.5 }}>
        Read from the {BRAND.name} Agent contract on Robinhood Chain{DEPLOYED ? <>, <Box component="a" href={explorerAddress(CONTRACT)} target="_blank" rel="noopener noreferrer" sx={{ color: t.color.text }}>{CONTRACT.slice(0, 6)}…{CONTRACT.slice(-4)}</Box></> : ''}. The limits live in the contract; the executor checks every mandate every ten minutes.
      </Typography>

      {!DEPLOYED && (
        <Panel sx={{ mt: 5, p: { xs: 3, md: 4 } }}>
          <Typography sx={{ fontSize: 16, fontWeight: 500 }}>The contract is not on the chain yet.</Typography>
          <Typography sx={{ fontSize: 14, color: t.color.textMuted, mt: 0.75 }}>The code is in the repository and tested on a fork of Robinhood Chain. Mandates open here the moment it is deployed.</Typography>
        </Panel>
      )}

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0,1fr)', md: 'minmax(0,1fr) 460px' }, gap: 2.5, mt: { xs: 5, md: 7 }, alignItems: 'start' }}>
        <Box sx={{ minWidth: 0 }}>
          <Typography component="h2" sx={{ ...t.type.h3, color: t.color.text, mb: 2 }}>Your mandates</Typography>
          {!account ? (
            <Panel sx={{ p: { xs: 3, md: 4 }, display: 'flex', alignItems: 'center', gap: 2.5, flexWrap: 'wrap' }}>
              <Box sx={{ flex: 1, minWidth: 240 }}>
                <Typography sx={{ fontSize: 16, fontWeight: 500 }}>Connect to see your mandates.</Typography>
                <Typography sx={{ fontSize: 14, color: t.color.textMuted, mt: 0.75 }}>Mandates live in the contract, under your address. Any device, any wallet app, the same mandates.</Typography>
              </Box>
              <Button onClick={openWalletMenu} sx={{ ...Bt, gap: 1 }}><WalletIcon size={14} /> Connect</Button>
            </Panel>
          ) : (
            <Box sx={{ display: 'grid', gap: 1.5 }}>
              {mine.map((m) => <MandateCard key={String(m.id)} m={m} wallet={wallet} chain={chain} onChanged={refresh} />)}
              {mandates.data && mine.length === 0 && <Panel sx={{ p: 3 }}><Typography sx={{ fontSize: 14, color: t.color.textMuted }}>{DEPLOYED ? 'No mandate yet. Create one on the right, or ask the agent to draft one.' : 'Mandates open once the contract is deployed.'}</Typography></Panel>}
              {ids.length > 0 && <TradeList ids={ids} mandates={mine} chain={chain} />}
            </Box>
          )}
        </Box>
        <Box id="agent-composer" sx={{ minWidth: 0, scrollMarginTop: 96 }}>
          {DEPLOYED ? <Composer stocks={stocks} pools={pools.data ?? []} loading={pools.isLoading || assets.isLoading} wallet={wallet} chain={chain} onDone={refresh} /> : null}
        </Box>
      </Box>

      <Box sx={{ mt: { xs: 8, md: 12 } }}>
        <Typography component="h2" sx={{ ...t.type.h3, color: t.color.text }}>How it works</Typography>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(3, minmax(0,1fr))' }, gap: 2.5, mt: 4 }}>
          <Step n={1} icon={<LockIcon size={20} />} title="You set the limits" text="The stocks, the rule and its size, the USDG per trade, per day and in all, the least time between two trades on the same stock, the floor and the expiry go into the contract. You approve USDG for the budget plus the tips, or each stock for what you hold. Revoke and the mandate stops, whatever anyone does." />
          <Step n={2} icon={<SparkIcon size={20} />} title="The agent works inside them" text={`${BRAND.name}'s executor reads each stock's move on the day, or in the last hour, every ten minutes and applies your rule. When it fires, the agent calls the contract: the USDG leaves your wallet, the stock lands in it, the executor takes a ten-cent tip. One trade per stock per cooldown, never more than the caps.`} />
          <Step n={3} icon={<ShieldIcon size={20} />} title="The contract refuses the rest" text="Every trade must fit the budget, the per-trade and per-day caps, the cooldown and the expiry, and return at least the pool's spot less 1%, read in the same transaction. A trade outside the limits reverts. The contract holds nothing between trades and no admin can touch a mandate." />
        </Box>
      </Box>

      <Panel sx={{ mt: { xs: 8, md: 12 }, p: { xs: 3, md: 5 }, display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 4, alignItems: 'center' }}>
        <Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <Box sx={{ width: 40, height: 40, borderRadius: '10px', background: '#000', border: `1px solid ${t.color.borderStrong}`, display: 'grid', placeItems: 'center' }}><MarkIcon size={22} /></Box>
            <Box sx={{ ...Vg, ml: 0 }}>Phase 2, box 9</Box>
          </Box>
          <Typography component="h2" sx={{ ...t.type.h3, color: t.color.text, mt: 2.5 }}>The agent that proposed, now with limits the chain enforces.</Typography>
          <Typography sx={{ ...t.type.body, color: t.color.textMuted, mt: 2 }}>
            The Agent page drafts and you approve, one card at a time, with your tab open. A mandate moves the limits into a contract and the work to the executor that already runs Auto-Invest, Orders and Vaults without you: it can trade inside your budget, your caps and your cooldown, at spot less your floor, and it cannot do anything else. The contract holds no balance, takes no fee, and its admin can only keep the executor list. The rule is the executor's judgement; the limits are the contract's. Unaudited; read it before you trust it with more than you would lose.
          </Typography>
          <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', mt: 2 }}>
            {DEPLOYED && <Box component="a" href={explorerAddress(CONTRACT)} target="_blank" rel="noopener noreferrer" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, fontSize: 13, color: t.color.text, textDecoration: 'none' }}>Contract on the explorer <ExternalIcon size={12} /></Box>}
            <Box component="a" href="https://github.com/useverdex/verdex/blob/main/contracts/VerdexAgent.sol" target="_blank" rel="noopener noreferrer" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, fontSize: 13, color: t.color.text, textDecoration: 'none' }}>Source <ExternalIcon size={12} /></Box>
            <Box component={Link} to="/docs#agent-without-you" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, fontSize: 13, color: t.color.text, textDecoration: 'none' }}>Docs</Box>
          </Box>
        </Box>
        <Box sx={{ display: 'grid', gap: 1.5 }}>
          {[
            [<LockIcon key="a" size={18} />, 'The limits are the contract’s', 'Budget, per trade, per day, cooldown, floor, expiry: every trade is checked against them onchain. The executor cannot widen them; only you can.'],
            [<ShieldIcon key="b" size={18} />, 'The rule is the executor’s', 'When to trade is read from the pools’ market data by the executor, not proven onchain. The worst a rogue executor could do is trade inside your limits at spot less your floor. Pause or revoke and it stops.'],
            [<CheckIcon key="c" size={18} />, 'Unaudited, and small', 'No third party has audited this contract. It is short, tested on a fork of the chain, and the source is in the repository with the compiled bytecode.'],
          ].map(([icon, title, text]) => (
            <Box key={title as string} sx={{ display: 'flex', gap: 1.5, p: 2, borderRadius: t.radius.panel, background: t.color.raised }}>
              <Box sx={{ color: t.color.mark, mt: 0.25, flexShrink: 0 }}>{icon}</Box>
              <Box>
                <Typography sx={{ fontSize: 14, fontWeight: 500 }}>{title}</Typography>
                <Typography sx={{ fontSize: 13, color: t.color.textMuted, mt: 0.25 }}>{text}</Typography>
              </Box>
            </Box>
          ))}
        </Box>
      </Panel>
    </Page>
  )
}
