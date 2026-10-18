import { useEffect, useMemo, useRef, useState } from 'react'
import { Avatar, Box, Button, InputBase, Typography } from '@mui/material'
import { useNavigate } from 'react-router-dom'
import { BRAND, t, z } from '../theme/tokens'
import { Bt, Lt, Vg } from '../theme/styles'
import { CHAIN_NAME_LOGOS, fmtUsd, useAssets, useChains } from '../lib/api'
import type { ChainX } from '../lib/lifi'
import { VERDEX_FEE, isHolder } from '../lib/autoInvest'
import { EXPIRIES } from '../lib/orders'
import { RULES } from '../lib/vaults'
import { PROVIDERS, SUGGESTIONS, Session, approve, loadConfig, mandateUrl, modelFor, ready, saveConfig, type AgentConfig, type AgentEvent, type Proposal } from '../lib/agent'
import { resolveImg } from '../lib/img'
import { useWallet, shortAddress } from '../components/wallet/WalletProvider'
import { AllocBar, AllocLegend } from '../components/alloc'
import { ArrowRightIcon, CheckIcon, LockIcon, SearchIcon, SparkIcon, WalletIcon } from '../components/icons'
import { MarkIcon } from '../components/Logo'
import { Page, PageHero, Panel } from './common'

type Item = { id: string; role: 'user' | 'agent'; text?: string; tools: string[]; proposals: string[]; error?: string; pending?: boolean }
const iid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
const fmtDate = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
const fmtUnits = (u: number) => (u >= 100 ? u.toFixed(0) : u >= 1 ? u.toFixed(2) : u.toFixed(4))

function Label({ children }: { children: React.ReactNode }) {
  return <Typography sx={{ ...t.type.overline, color: t.color.textLabel, mb: 1.25 }}>{children}</Typography>
}
function Choice({ on, onClick, children, disabled }: { on: boolean; onClick: () => void; children: React.ReactNode; disabled?: boolean }) {
  return (
    <Box component="button" type="button" onClick={onClick} disabled={disabled} aria-pressed={on} sx={{ all: 'unset', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1, display: 'inline-flex', alignItems: 'center', gap: '8px', height: 34, px: '12px', borderRadius: t.radius.input, fontSize: 13, fontWeight: 500, letterSpacing: '-0.02em', color: on ? t.color.onAccent : t.color.textSecondary, background: on ? t.color.accent : t.color.chip, transition: `background ${t.motion.base}, color ${t.motion.base}`, '&:hover': { background: on ? t.color.cream : '#2A2A2A' } }}>
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

// A proposal card: what the agent wants to do, complete, with the two buttons that decide it.
function ProposalCard({ p, connected, onApprove, onDismiss }: { p: Proposal; connected: boolean; onApprove: (p: Proposal) => void; onDismiss: (p: Proposal) => void }) {
  const navigate = useNavigate()
  const kind = p.kind === 'order' ? 'Order' : p.kind === 'plan' ? 'Auto-Invest plan' : p.kind === 'mandate' ? 'Mandate, Agent without you' : 'Vault'
  const done = p.status !== 'pending'
  const where = p.kind === 'order' ? '/orders#orders' : p.kind === 'plan' ? '/auto-invest#plans' : p.kind === 'mandate' ? mandateUrl(p) : '/vaults#vaults'
  const whereLabel = p.kind === 'order' ? 'Orders' : p.kind === 'plan' ? 'Auto-Invest' : p.kind === 'mandate' ? 'Agent without you' : 'Vaults'
  return (
    <Box sx={{ mt: 1.5, p: 2.5, borderRadius: t.radius.card, background: t.color.tile, border: `1px solid ${p.status === 'approved' ? 'rgba(194,234,138,.35)' : t.color.border}`, opacity: p.status === 'dismissed' ? 0.55 : 1 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
        {p.kind === 'vault' || p.kind === 'mandate' ? (
          <Box sx={{ width: 36, height: 36, borderRadius: '10px', background: z.surface2, display: 'grid', placeItems: 'center', color: t.color.mark }}>
            <SparkIcon size={18} />
          </Box>
        ) : (
          <Avatar src={resolveImg(p.logo)} alt="" sx={{ width: 36, height: 36, background: z.surface2, fontSize: 12 }}>
            {p.ticker[0]}
          </Avatar>
        )}
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography sx={{ fontSize: 12, color: t.color.textLabel, letterSpacing: '.04em', textTransform: 'uppercase' }}>{kind} · needs your approval</Typography>
          <Typography sx={{ fontSize: 16, fontWeight: 500, lineHeight: 1.25, mt: 0.25 }}>{p.summary}</Typography>
        </Box>
        <Box sx={{ ...Vg, ml: 0, ...(p.status === 'approved' && { background: 'rgba(194,234,138,.16)', color: t.color.mark }) }}>{p.status === 'pending' ? 'Proposed' : p.status === 'approved' ? 'Approved' : 'Dismissed'}</Box>
      </Box>
      {p.kind === 'order' && (
        <Typography sx={{ fontSize: 13, color: t.color.textMuted, mt: 1.5, display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}>
          <Avatar src={CHAIN_NAME_LOGOS[p.chain]} alt="" sx={{ width: 14, height: 14, background: 'transparent' }} /> {p.asset.symbol} on {p.chain} · {p.side === 'buy' ? `paid in ${p.quote.symbol}` : `into ${p.quote.symbol}`} · {EXPIRIES.find((e) => e.key === p.expiry)?.label.toLowerCase() ?? 'until cancelled'}
          {p.current ? ` · now ${fmtUsd(p.current)}` : ''}
        </Typography>
      )}
      {p.kind === 'plan' && (
        <Typography sx={{ fontSize: 13, color: t.color.textMuted, mt: 1.5, display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}>
          <Avatar src={CHAIN_NAME_LOGOS[p.chain]} alt="" sx={{ width: 14, height: 14, background: 'transparent' }} /> {p.target.symbol} on {p.chain} · paid in {p.pay.symbol} · {p.buyNow ? 'first buy right after approval' : `first buy ${fmtDate(p.firstAt)}`}
          {p.current ? ` · now ${fmtUsd(p.current)}, about ${fmtUnits(p.amountUsd / p.current)} ${p.ticker} per buy` : ''}
        </Typography>
      )}
      {p.kind === 'mandate' && (
        <Typography sx={{ fontSize: 13, color: t.color.textMuted, mt: 1.5, display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}>
          <Avatar src={CHAIN_NAME_LOGOS[p.chain]} alt="" sx={{ width: 14, height: 14, background: 'transparent' }} /> {p.chain} · {p.hourly ? 'the last hour' : 'the day'} · {fmtUsd(p.perTrade)} a trade · {fmtUsd(p.perDay)} a day{p.weekX ? ` · ${fmtUsd(p.perDay * p.weekX)} a week` : ''}{p.budget ? ` · ${fmtUsd(p.budget)} in all` : ''} · same stock at most every {p.cooldown === 21_600 ? '6 hours' : p.cooldown === 86_400 ? 'day' : p.cooldown === 259_200 ? '3 days' : 'week'} · {p.expires ? `${Math.round(p.expires / 86_400)} days` : 'until closed'} · floor spot less 1%
        </Typography>
      )}
      {p.kind === 'vault' && (
        <Box sx={{ mt: 1.5 }}>
          <AllocBar assets={p.assets} />
          <Box sx={{ mt: 1 }}>
            <AllocLegend assets={p.assets} />
          </Box>
          <Typography sx={{ fontSize: 13, color: t.color.textMuted, mt: 1, display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}>
            <Avatar src={CHAIN_NAME_LOGOS[p.chain]} alt="" sx={{ width: 14, height: 14, background: 'transparent' }} /> {p.chain} · funded in {p.quote.symbol} · {RULES.find((r) => r.key === p.rule)?.label.toLowerCase()} · {p.threshold}% drift
          </Typography>
        </Box>
      )}
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mt: 2, alignItems: 'center' }}>
        {!done ? (
          <>
            <Button onClick={() => onApprove(p)} sx={{ ...Bt, height: 38, px: '16px', fontSize: 14, gap: 1 }}>
              {connected ? <CheckIcon size={15} /> : <WalletIcon size={15} />} {connected ? 'Approve' : 'Connect to approve'}
            </Button>
            <Button onClick={() => onDismiss(p)} sx={{ ...Lt, height: 38, px: '16px', fontSize: 14, backdropFilter: 'none', background: 'transparent', color: t.color.textMuted }}>
              Dismiss
            </Button>
          </>
        ) : p.status === 'approved' ? (
          <Button onClick={() => { navigate(where); window.scrollTo({ top: 0 }) }} sx={{ ...Lt, height: 38, px: '16px', fontSize: 14, gap: 1, backdropFilter: 'none' }}>
            Open {whereLabel} <ArrowRightIcon size={14} />
          </Button>
        ) : null}
        {!done && <Typography sx={{ fontSize: 12, color: t.color.textLabel }}>{p.kind === 'order' ? 'Approving saves the order; the fill is still confirmed in your wallet.' : p.kind === 'plan' ? 'Approving schedules it; each buy is still confirmed in your wallet.' : p.kind === 'mandate' ? 'Approving opens the mandate for your wallet to sign; the contract keeps the limits, the executor trades inside them.' : 'Approving creates it; funding and every trade are confirmed in your wallet.'}</Typography>}
      </Box>
    </Box>
  )
}

export default function AgentPage() {
  const { data } = useAssets()
  const { data: chainList } = useChains()
  const chains = chainList as ChainX[] | undefined
  const { account, openWalletMenu } = useWallet()
  const navigate = useNavigate()
  const [config, setConfig] = useState<AgentConfig>(loadConfig)
  const [draft, setDraft] = useState<AgentConfig>(config)
  const [setupOpen, setSetupOpen] = useState(() => !ready(loadConfig()) || loadConfig().provider === 'demo')
  const [items, setItems] = useState<Item[]>([])
  const [proposals, setProposals] = useState<Record<string, Proposal>>({})
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [holderFor, setHolderFor] = useState<{ address: string; holder: boolean } | null>(null)
  const holder = !!account && holderFor?.address === account.address.toLowerCase() && holderFor.holder
  const session = useRef<Session | null>(null)
  const scroller = useRef<HTMLDivElement | null>(null)
  const assets = useMemo(() => data?.assets ?? [], [data])
  const provider = PROVIDERS.find((p) => p.key === config.provider) ?? PROVIDERS[2]

  useEffect(() => {
    if (!account) return
    let alive = true
    const address = account.address.toLowerCase()
    isHolder(chainList, account.address).then((v) => alive && setHolderFor({ address, holder: v }))
    return () => {
      alive = false
    }
  }, [account, chainList])
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' })
  }, [items, proposals])

  const getSession = () => {
    if (!session.current || session.current.config !== config) session.current = new Session(config)
    return session.current
  }
  const patch = (id: string, f: (i: Item) => Item) => setItems((list) => list.map((i) => (i.id === id ? f(i) : i)))
  const send = async (raw?: string) => {
    const q = (raw ?? text).trim()
    if (!q || busy) return
    if (!ready(config)) {
      setSetupOpen(true)
      return
    }
    setText('')
    const id = iid()
    setItems((list) => [...list, { id: iid(), role: 'user', text: q, tools: [], proposals: [] }, { id, role: 'agent', tools: [], proposals: [], pending: true }])
    setBusy(true)
    const onEvent = (e: AgentEvent) => {
      if (e.type === 'text') patch(id, (i) => ({ ...i, text: i.text ? `${i.text}\n\n${e.text}` : e.text }))
      else if (e.type === 'tool') patch(id, (i) => ({ ...i, tools: [...i.tools, e.label] }))
      else if (e.type === 'proposal') {
        setProposals((m) => ({ ...m, [e.proposal.id]: e.proposal }))
        patch(id, (i) => ({ ...i, proposals: [...i.proposals, e.proposal.id] }))
      } else patch(id, (i) => ({ ...i, error: e.message }))
    }
    await getSession().send(q, { assets, chains, account: account ? { address: account.address, chainId: account.chainId } : undefined, holder }, onEvent)
    patch(id, (i) => ({ ...i, pending: false }))
    setBusy(false)
  }
  const onApprove = (p: Proposal) => {
    if (!account) return openWalletMenu()
    const where = approve(p, account.address)
    setProposals((m) => ({ ...m, [p.id]: { ...p, status: 'approved' } }))
    if (p.kind === 'mandate') { navigate(where); window.scrollTo({ top: 0 }) }
  }
  const onDismiss = (p: Proposal) => setProposals((m) => ({ ...m, [p.id]: { ...p, status: 'dismissed' } }))
  const save = () => {
    const next: AgentConfig = { provider: draft.provider, key: draft.provider === 'demo' ? '' : draft.key.trim(), model: draft.provider === 'demo' ? '' : draft.model.trim() }
    saveConfig(next)
    setConfig(next)
    session.current = null
    setSetupOpen(false)
  }
  const clearChat = () => {
    setItems([])
    setProposals({})
    session.current?.reset()
  }

  return (
    <Page>
      <PageHero
        label="Agent"
        badges={<Box sx={{ ...Vg, ml: 0, background: 'rgba(194,234,138,.16)', color: t.color.mark }}>New</Box>}
        title={
          <>
            Say it.
            <br />
            Approve it.
          </>
        }
        lead={`Tell ${BRAND.name} what you want in plain words: a limit order, a weekly buy, a whole vault. The agent reads the market and your wallet, drafts the action as a card, and nothing happens until you approve it and your wallet confirms. Bring your own Anthropic or OpenAI key; it stays in this browser.`}
      />

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1.35fr 1fr' }, gap: 2.5, alignItems: 'start' }}>
        <Panel sx={{ p: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', minHeight: 560 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, px: { xs: 2.5, md: 3 }, py: 2, borderBottom: `1px solid ${t.color.border}` }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, minWidth: 0 }}>
              <Box sx={{ width: 32, height: 32, borderRadius: '9px', background: '#000', border: `1px solid ${t.color.borderStrong}`, display: 'grid', placeItems: 'center', flexShrink: 0 }}>
                <MarkIcon size={16} />
              </Box>
              <Box sx={{ minWidth: 0 }}>
                <Typography sx={{ fontSize: 14, fontWeight: 500, lineHeight: 1.2 }}>{BRAND.name} Agent</Typography>
                <Typography sx={{ fontSize: 12, color: t.color.textMuted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{config.provider === 'demo' ? 'No key: built-in helper, same proposals' : `${provider.label} · ${modelFor(config)}`}{account ? ` · ${shortAddress(account.address)}` : ' · no wallet'}</Typography>
              </Box>
            </Box>
            <Box sx={{ display: 'flex', gap: 1 }}>
              {items.length > 0 && (
                <Button onClick={clearChat} sx={{ ...Lt, height: 32, px: '12px', fontSize: 13, backdropFilter: 'none', background: 'transparent', color: t.color.textMuted }}>
                  Clear
                </Button>
              )}
              <Button onClick={() => setSetupOpen((v) => !v)} sx={{ ...Lt, height: 32, px: '12px', fontSize: 13, backdropFilter: 'none' }}>
                Setup
              </Button>
            </Box>
          </Box>

          <Box ref={scroller} sx={{ flex: 1, overflowY: 'auto', px: { xs: 2.5, md: 3 }, py: 2.5, maxHeight: 640, display: 'flex', flexDirection: 'column', gap: 2 }}>
            {items.length === 0 && (
              <Box sx={{ my: 'auto' }}>
                <Typography sx={{ ...t.type.body, color: t.color.textMuted }}>Ask for an order, a recurring buy or a vault, or ask what you hold. Every action comes back as a card you approve.</Typography>
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 2 }}>
                  {SUGGESTIONS.map((s) => (
                    <Choice key={s} on={false} onClick={() => send(s)}>
                      {s}
                    </Choice>
                  ))}
                </Box>
              </Box>
            )}
            {items.map((i) =>
              i.role === 'user' ? (
                <Box key={i.id} sx={{ alignSelf: 'flex-end', maxWidth: '85%', px: 2, py: 1.25, borderRadius: '16px 16px 4px 16px', background: t.color.accent, color: t.color.onAccent, fontSize: 15, lineHeight: 1.4 }}>
                  {i.text}
                </Box>
              ) : (
                <Box key={i.id} sx={{ alignSelf: 'stretch', maxWidth: '100%' }}>
                  {i.tools.map((tl, k) => (
                    <Typography key={k} sx={{ fontSize: 12, color: t.color.textLabel, display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
                      <Box component="span" sx={{ width: 6, height: 6, borderRadius: '50%', background: t.color.mark, flexShrink: 0 }} /> {tl}
                    </Typography>
                  ))}
                  {i.proposals.map((pidd) => proposals[pidd] && <ProposalCard key={pidd} p={proposals[pidd]} connected={!!account} onApprove={onApprove} onDismiss={onDismiss} />)}
                  {i.text && <Typography sx={{ fontSize: 15, lineHeight: 1.5, color: t.color.text, mt: i.tools.length || i.proposals.length ? 1.5 : 0, whiteSpace: 'pre-wrap' }}>{i.text}</Typography>}
                  {i.error && <Typography sx={{ fontSize: 13, color: t.color.red, mt: 1 }}>{i.error}</Typography>}
                  {i.pending && !i.text && (
                    <Typography sx={{ fontSize: 13, color: t.color.textMuted, mt: i.tools.length ? 1 : 0, display: 'flex', alignItems: 'center', gap: 1 }}>
                      <Box component="span" sx={{ width: 8, height: 8, borderRadius: '50%', background: t.color.mark, animation: 'vxpulse 1s ease-in-out infinite', '@keyframes vxpulse': { '0%,100%': { opacity: 0.3 }, '50%': { opacity: 1 } } }} /> {i.tools.length ? 'Working…' : 'Thinking…'}
                    </Typography>
                  )}
                </Box>
              ),
            )}
          </Box>

          <Box component="form" onSubmit={(e) => { e.preventDefault(); send() }} sx={{ display: 'flex', alignItems: 'center', gap: 1, px: { xs: 2, md: 2.5 }, py: 2, borderTop: `1px solid ${t.color.border}` }}>
            <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', gap: 1.5, px: 2, height: 48, borderRadius: t.radius.input, background: t.color.tile }}>
              <Box sx={{ display: 'flex', color: t.color.textLabel }}>
                <SearchIcon size={16} />
              </Box>
              <InputBase value={text} onChange={(e) => setText(e.target.value)} placeholder={ready(config) ? 'Buy $250 of NVDA below $200' : 'Add a key in Setup, or pick No key to try it'} inputProps={{ 'aria-label': 'Ask the agent' }} disabled={busy} sx={{ flex: 1, fontSize: 15, color: t.color.text, '& input::placeholder': { color: t.color.textLabel, opacity: 1 } }} />
            </Box>
            <Button type="submit" disabled={busy || !text.trim()} sx={{ ...Bt, height: 48, px: '18px', gap: 1 }}>
              Send
            </Button>
          </Box>
        </Panel>

        <Box sx={{ display: 'grid', gap: 2.5 }}>
          {setupOpen && (
            <Panel sx={{ p: { xs: 2.5, md: 3 } }}>
              <Label>Model</Label>
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                {PROVIDERS.map((p) => (
                  <Choice key={p.key} on={draft.provider === p.key} onClick={() => setDraft((d) => ({ ...d, provider: p.key, model: d.provider === p.key ? d.model : '' }))}>
                    {p.label}
                  </Choice>
                ))}
              </Box>
              {draft.provider !== 'demo' ? (
                <>
                  <Box sx={{ mt: 3 }}>
                    <Label>API key</Label>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, px: 2, height: 48, borderRadius: t.radius.input, background: t.color.tile }}>
                      <Box sx={{ display: 'flex', color: t.color.textLabel }}>
                        <LockIcon size={15} />
                      </Box>
                      <InputBase type="password" value={draft.key} onChange={(e) => setDraft((d) => ({ ...d, key: e.target.value }))} placeholder={PROVIDERS.find((p) => p.key === draft.provider)?.hint} autoComplete="off" inputProps={{ 'aria-label': 'API key' }} sx={{ flex: 1, fontSize: 14, color: t.color.text, '& input::placeholder': { color: t.color.textLabel, opacity: 1 } }} />
                    </Box>
                    <Typography sx={{ fontSize: 12, color: t.color.textLabel, mt: 1 }}>
                      Saved in this browser only and sent only to {PROVIDERS.find((p) => p.key === draft.provider)?.label}. {BRAND.name} has no server in the loop. Get a key at{' '}
                      <Box component="a" href={PROVIDERS.find((p) => p.key === draft.provider)?.keysUrl} target="_blank" rel="noopener noreferrer" sx={{ color: t.color.textMuted }}>
                        {PROVIDERS.find((p) => p.key === draft.provider)?.keysUrl?.replace('https://', '')}
                      </Box>
                      .
                    </Typography>
                  </Box>
                  <Box sx={{ mt: 3 }}>
                    <Label>Model name</Label>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, px: 2, height: 42, borderRadius: t.radius.input, background: t.color.tile }}>
                      <InputBase value={draft.model} onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value }))} placeholder={PROVIDERS.find((p) => p.key === draft.provider)?.model} inputProps={{ 'aria-label': 'Model name' }} sx={{ flex: 1, fontSize: 14, color: t.color.text, '& input::placeholder': { color: t.color.textLabel, opacity: 1 } }} />
                    </Box>
                  </Box>
                </>
              ) : (
                <Typography sx={{ fontSize: 13, color: t.color.textMuted, mt: 2 }}>Without a key, a small built-in helper understands the common requests (orders, recurring buys, vaults, holdings, prices) and drafts the same cards. Add a key for open conversation.</Typography>
              )}
              <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', mt: 3, alignItems: 'center' }}>
                <Button onClick={save} disabled={draft.provider !== 'demo' && draft.key.trim().length < 10} sx={{ ...Bt, height: 40, px: '16px', fontSize: 14 }}>
                  Save
                </Button>
                {config.key && (
                  <Button onClick={() => { const empty: AgentConfig = { provider: 'demo', key: '', model: '' }; saveConfig(empty); setConfig(empty); setDraft(empty); session.current = null }} sx={{ ...Lt, height: 40, px: '16px', fontSize: 14, backdropFilter: 'none', background: 'transparent', color: t.color.textMuted }}>
                    Forget key
                  </Button>
                )}
              </Box>
            </Panel>
          )}

          <Panel sx={{ p: { xs: 2.5, md: 3 } }}>
            <Label>Wallet</Label>
            {account ? (
              <Typography sx={{ fontSize: 14, color: t.color.text }}>
                {shortAddress(account.address)} on {chains?.find((c) => c.id === account.chainId)?.name ?? `chain ${account.chainId}`}
                <Box component="span" sx={{ color: t.color.textMuted }}> · the agent can read its balances and you can approve cards</Box>
              </Typography>
            ) : (
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, flexWrap: 'wrap' }}>
                <Typography sx={{ fontSize: 14, color: t.color.textMuted }}>Not connected. You can ask and get cards now; connect to approve them.</Typography>
                <Button onClick={openWalletMenu} sx={{ ...Bt, height: 36, px: '14px', fontSize: 13 }}>
                  Connect
                </Button>
              </Box>
            )}
            <Box sx={{ mt: 2.5, pt: 2.5, borderTop: `1px solid ${t.color.border}`, display: 'grid', gap: 0.5 }}>
              {[
                ['Reads', 'Prices from the live feed, what your wallet holds, and your existing plans, orders and vaults.'],
                ['Drafts', 'Limit and stop orders, Auto-Invest plans and vaults, as cards with every field filled in.'],
                ['Never', 'Places, signs or moves anything on its own. No keys, no custody, no allowance until you confirm a trade.'],
              ].map(([k, v], i) => (
                <Box key={k} sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.5, px: 1.5, py: 1.25, borderRadius: t.radius.panel, background: i === 2 ? t.color.tile : 'transparent' }}>
                  <Box sx={{ mt: '6px', width: 8, height: 8, borderRadius: '50%', background: i === 2 ? t.color.mark : t.color.borderStrong, flexShrink: 0 }} />
                  <Box>
                    <Typography sx={{ fontSize: 14, fontWeight: 500 }}>{k}</Typography>
                    <Typography sx={{ fontSize: 13, color: t.color.textMuted }}>{v}</Typography>
                  </Box>
                </Box>
              ))}
            </Box>
            <Box sx={{ mt: 2.5, pt: 2.5, borderTop: `1px solid ${t.color.border}`, display: 'flex', justifyContent: 'space-between', gap: 2, alignItems: 'center' }}>
              <Typography sx={{ fontSize: 14, color: t.color.textMuted }}>{BRAND.name} fee on the trades it drafts</Typography>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                {holder ? (
                  <Typography sx={{ fontSize: 14, fontWeight: 500, color: t.color.mark }}>0% · you hold VERDEX</Typography>
                ) : (
                  <>
                    <Typography sx={{ fontSize: 13, color: t.color.textFaint, textDecoration: 'line-through' }}>{(VERDEX_FEE * 100).toFixed(2)}%</Typography>
                    <Typography sx={{ fontSize: 14, fontWeight: 500, color: t.color.mark }}>0% with VERDEX</Typography>
                  </>
                )}
              </Box>
            </Box>
          </Panel>
        </Box>
      </Box>

      <Box sx={{ mt: { xs: 8, md: 12 } }}>
        <Typography component="h2" sx={{ ...t.type.h3, color: t.color.text }}>How it works</Typography>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(3, minmax(0,1fr))' }, gap: 2.5, mt: 4 }}>
          <Step n={1} icon={<SparkIcon size={20} />} title="Ask in plain words" text="Buy NVDA if it drops 5%. A hundred dollars of SPY every week. An AI vault with three names. The agent looks up the assets, reads the price and your balances, and asks when something is missing." />
          <Step n={2} icon={<CheckIcon size={20} />} title="Review the card" text="Every action comes back as a proposal with every field filled in: asset, chain, level, size, cadence, weights. Approve it or dismiss it. Nothing exists until you approve." />
          <Step n={3} icon={<LockIcon size={20} />} title="Your wallet confirms" text={`Approving saves the order, plan or vault on this device, exactly as if you had built it by hand. Each trade still runs through the best route and is confirmed in your wallet. ${BRAND.name} never holds keys or funds.`} />
        </Box>
      </Box>

      <Panel sx={{ mt: { xs: 8, md: 12 }, p: { xs: 3, md: 5 }, display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 4, alignItems: 'center' }}>
        <Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <Box sx={{ width: 40, height: 40, borderRadius: '10px', background: '#000', border: `1px solid ${t.color.borderStrong}`, display: 'grid', placeItems: 'center' }}>
              <MarkIcon size={22} />
            </Box>
            <Box sx={{ ...Vg, ml: 0 }}>Bring your own key</Box>
          </Box>
          <Typography component="h2" sx={{ ...t.type.h3, color: t.color.text, mt: 2.5 }}>Your model, your key, your wallet.</Typography>
          <Typography sx={{ ...t.type.body, color: t.color.textMuted, mt: 2 }}>{BRAND.name} does not run a model for you and does not see your conversations. The page talks to Anthropic or OpenAI directly from your browser with the key you paste, and the key never leaves this device. The tools the agent can call are fixed and open source: read the market, read your wallet, draft a card.</Typography>
        </Box>
        <Box sx={{ display: 'grid', gap: 1.25 }}>
          {[
            ['Approval by default', 'The agent proposes; you approve; the wallet confirms. Three separate steps, none of them skippable.'],
            ['Same engines as the buttons', 'An approved card becomes a normal order, plan or vault, with the same fees, routes and reminders.'],
            ['Zero fee for holders', `${(VERDEX_FEE * 100).toFixed(2)}% becomes 0% on every trade for wallets that hold VERDEX.`],
          ].map(([k, v]) => (
            <Box key={k} sx={{ display: 'flex', gap: 1.5, alignItems: 'flex-start', p: 2, borderRadius: t.radius.panel, background: t.color.tile }}>
              <Box sx={{ mt: '3px', color: t.color.mark, display: 'flex' }}>
                <CheckIcon size={16} />
              </Box>
              <Box>
                <Typography sx={{ fontSize: 15, fontWeight: 500 }}>{k}</Typography>
                <Typography sx={{ fontSize: 13, color: t.color.textMuted, mt: 0.25 }}>{v}</Typography>
              </Box>
            </Box>
          ))}
        </Box>
      </Panel>

      <Box sx={{ mt: { xs: 8, md: 12 }, maxWidth: 760 }}>
        <Typography component="h2" sx={{ ...t.type.h3, color: t.color.text }}>Questions</Typography>
        {[
          ['Can it trade on its own?', `No. Every action it drafts is a card you approve, and each trade is then confirmed in your wallet like any other. There is no mode that skips either step. Session permissions (ERC-7715) will let approved plans and orders run while you are away; that is next.`],
          ['Where does my key go?', `Into localStorage on this device and, on each request, straight to the provider you chose over HTTPS. ${BRAND.name} has no backend in the loop and never sees it. Press Forget key in Setup to remove it.`],
          ['What does it cost?', 'Your provider bills the tokens each request uses, typically a fraction of a cent for a short exchange. Verdex charges nothing for the agent. The trades themselves carry the usual route fees, and the Verdex fee is zero for VERDEX holders.'],
          ['Which models work?', `Anthropic (default ${PROVIDERS[0].model}) and OpenAI (default ${PROVIDERS[1].model}) through their official APIs. You can type another model name in Setup. Without a key, a small built-in helper drafts the same cards from the common phrasings.`],
          ['Can it see my whole portfolio?', 'It reads the balances of the stablecoins Verdex pays with, the assets in your existing plans, orders and vaults, and any ticker you name. It reads nothing else, and only when you ask.'],
          ['Does it give investment advice?', 'No. It explains what an asset or an order type is and drafts what you ask for. It is told not to predict prices or recommend positions.'],
        ].map(([qq, a]) => (
          <Box key={qq} sx={{ py: 2.5, borderTop: `1px solid ${t.color.border}` }}>
            <Typography sx={{ ...t.type.body, color: t.color.text }}>{qq}</Typography>
            <Typography sx={{ ...t.type.small, color: t.color.textMuted, mt: 0.75 }}>{a}</Typography>
          </Box>
        ))}
      </Box>
    </Page>
  )
}
