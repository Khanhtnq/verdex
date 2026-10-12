// Holders vote: rounds of ranked votes on what ships next, where a holder's VERDEX balance is their vote. The
// page shows the open round and its live tally, lets a holder rank the candidates with taps, and keeps the
// closed rounds with their results.
import { useEffect, useState } from 'react'
import { Box, Button, Typography } from '@mui/material'
import { Link } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { BRAND, t } from '../theme/tokens'
import { Bt, Lt, Vg } from '../theme/styles'
import { ROBINHOOD, useChains } from '../lib/api'
import { useClock } from '../lib/holding'
import { describeError, explorerTx, type ChainX } from '../lib/lifi'
import { PHASE_LABEL, type Phase } from '../lib/pools'
import { CONTRACT, DEPLOYED, castVote, explorerAddress, fmtVerdex, fmtWhen, useRounds, type Round } from '../lib/voteOnchain'
import { useWallet } from '../components/wallet/WalletProvider'
import { CheckIcon, CoinIcon, ExternalIcon, ShieldIcon, UsersIcon, WalletIcon } from '../components/icons'
import { MarkIcon } from '../components/Logo'
import { Page, PageHero, Panel, Stats } from './common'

type Ctx = ReturnType<typeof useWallet>
type Tx = { phase: Phase; error?: string; hash?: string }
const txCtx = (w: Ctx, chain: ChainX | undefined, onPhase: (p: Phase) => void) => ({ walletClient: w.walletClient!, account: w.account!, chain, switchChain: w.switchChain, onPhase })
const ordinal = (n: number) => `${n}${['th', 'st', 'nd', 'rd'][n % 100 > 10 && n % 100 < 14 ? 0 : n % 10 < 4 ? n % 10 : 0]}`
const pct = (n: number) => `${n.toFixed(n >= 10 ? 0 : 1)}%`

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

// The tally: candidates best first, with their share of the points and the weight that put them first.
function Tally({ r }: { r: Round }) {
  return (
    <Box sx={{ display: 'grid', gap: 0.75 }}>
      {r.candidates.map((c) => (
        <Box key={c.index} sx={{ display: 'grid', gridTemplateColumns: '28px minmax(0,1fr) auto', alignItems: 'center', gap: 1.5, fontSize: 13 }}>
          <Typography sx={{ fontSize: 13, fontWeight: 500, color: c.rank === 1 ? t.color.mark : t.color.textMuted }}>{c.rank}</Typography>
          <Box sx={{ minWidth: 0 }}>
            <Typography sx={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.label}</Typography>
            <Box sx={{ mt: 0.5, height: 6, borderRadius: 3, background: t.color.hover, overflow: 'hidden' }}><Box sx={{ width: `${Math.min(100, c.share)}%`, height: '100%', background: c.rank === 1 ? t.color.mark : t.color.textFaint, borderRadius: 3 }} /></Box>
          </Box>
          <Typography sx={{ fontSize: 12, color: t.color.textMuted, textAlign: 'right', whiteSpace: 'nowrap' }}>{pct(c.share)}{c.firsts > 0n ? ` · ${fmtVerdex(c.firsts)} put it first` : ''}</Typography>
        </Box>
      ))}
    </Box>
  )
}

// A holder's ballot: tap candidates in order of preference; tap again to remove; submit.
function Ballot({ r, wallet, chain, onDone }: { r: Round; wallet: Ctx; chain: ChainX | undefined; onDone: () => void }) {
  const keep = (xs: number[]) => xs.filter((i) => !r.shipped.includes(r.options[i]))
  const [picked, setPicked] = useState<number[]>(keep(r.mine ?? []))
  const [touched, setTouched] = useState(false)
  const [tx, setTx] = useState<Tx>({ phase: 'idle' })
  useEffect(() => { if (!touched && r.mine) setPicked(keep(r.mine)) }, [r.mine, touched]) // eslint-disable-line react-hooks/exhaustive-deps
  const busy = tx.phase !== 'idle' && tx.phase !== 'done' && tx.phase !== 'failed'
  const toggle = (i: number) => { setTouched(true); setPicked((p) => (p.includes(i) ? p.filter((x) => x !== i) : [...p, i])) }
  const same = r.mine && r.mine.length === picked.length && r.mine.every((x, k) => x === picked[k])
  const go = async () => {
    if (!wallet.walletClient || !wallet.account) return
    setTx({ phase: 'switching' })
    try { const hash = await castVote(txCtx(wallet, chain, (p) => setTx((x) => ({ ...x, phase: p }))), r.id, picked); setTx({ phase: 'done', hash }); setTouched(false); onDone() } catch (e) { setTx({ phase: 'failed', error: describeError(e) }) }
  }
  return (
    <Box>
      <Typography sx={{ ...t.type.overline, color: t.color.textLabel, mb: 1.25 }}>Your ranking{r.mine?.length ? ' (on the chain)' : ''}</Typography>
      <Box sx={{ display: 'grid', gap: 0.75 }}>
        {r.options.map((label, i) => {
          if (r.shipped.includes(label)) return null
          const pos = picked.indexOf(i)
          return (
            <Box key={i} component="button" type="button" onClick={() => toggle(i)} disabled={!r.open || busy} aria-pressed={pos >= 0} sx={{ all: 'unset', cursor: r.open ? 'pointer' : 'default', display: 'grid', gridTemplateColumns: '36px minmax(0,1fr)', alignItems: 'center', gap: 1.5, p: 1.25, borderRadius: t.radius.input, background: pos >= 0 ? t.color.text : t.color.raised, color: pos >= 0 ? t.color.page : t.color.text, fontSize: 13, '&:hover': { background: pos >= 0 ? t.color.text : t.color.hover } }}>
              <Box sx={{ width: 28, height: 28, borderRadius: '8px', background: pos >= 0 ? 'rgba(0,0,0,.12)' : t.color.hover, display: 'grid', placeItems: 'center', fontSize: 12, fontWeight: 500 }}>{pos >= 0 ? ordinal(pos + 1) : '·'}</Box>
              <span>{label}</span>
            </Box>
          )
        })}
      </Box>
      <Typography sx={{ fontSize: 12, color: t.color.textLabel, mt: 1 }}>Tap in order of preference; tap again to remove. A partial ranking counts. Your weight: {fmtVerdex(r.myWeight)}{r.myWeight === 0n ? ' (hold VERDEX to count)' : ''}.</Typography>
      <Button onClick={() => (wallet.account ? void go() : wallet.openWalletMenu())} disabled={!!wallet.account && (!r.open || picked.length === 0 || busy || !!same)} sx={{ ...Bt, width: '100%', mt: 2, height: 44 }}>
        {!wallet.account ? 'Connect wallet' : busy ? PHASE_LABEL[tx.phase] : !r.open ? 'The round is closed' : same ? 'This ranking is on the chain' : r.mine?.length ? 'Replace my ranking' : 'Submit my ranking'}
      </Button>
      {tx.phase === 'failed' && <Typography sx={{ fontSize: 12, color: t.color.red, mt: 1 }}>{tx.error}</Typography>}
      {tx.phase === 'done' && tx.hash && chain && (
        <Typography sx={{ fontSize: 13, mt: 1.5, display: 'flex', alignItems: 'center', gap: 1 }}><CheckIcon size={15} /> Counted. Your balance is weighed when the round is tallied.
          <Box component="a" href={explorerTx(chain, ROBINHOOD, tx.hash)} target="_blank" rel="noopener noreferrer" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, color: t.color.text, textDecoration: 'none' }}>Transaction <ExternalIcon size={12} /></Box>
        </Typography>
      )}
    </Box>
  )
}

function RoundCard({ r, wallet, chain, onDone }: { r: Round; wallet: Ctx; chain: ChainX | undefined; onDone: () => void }) {
  const now = useClock(r.open)
  const left = Math.max(0, r.closesAt - Math.floor(now / 1000))
  const days = Math.floor(left / 86_400), hours = Math.floor((left % 86_400) / 3600)
  const turnout = r.supply > 0n ? Number((r.weightVoting * 10_000n) / r.supply) / 100 : 0
  return (
    <Panel sx={{ p: { xs: 2.5, md: 3 } }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
        <Typography sx={{ fontSize: 18, fontWeight: 500, flex: 1, minWidth: 200 }}>{r.title}</Typography>
        <Box sx={{ ...Vg, ml: 0, ...(r.open && { background: 'rgba(194,234,138,.16)', color: t.color.mark }) }}>{r.open ? (now > 0 ? `Open · ${days ? `${days}d ${hours}h` : `${hours}h`} left` : 'Open') : 'Closed'}</Box>
      </Box>
      <Typography sx={{ fontSize: 12, color: t.color.textMuted, mt: 0.5 }}>Round {String(r.id)} · opened {fmtWhen(r.opensAt)} · {r.open ? 'closes' : 'closed'} {fmtWhen(r.closesAt)} · {r.voterCount} voter{r.voterCount === 1 ? '' : 's'} · {fmtVerdex(r.weightVoting)} voting, {pct(turnout)} of the supply</Typography>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'minmax(0,1fr) minmax(0,1fr)' }, gap: 3, mt: 2.5 }}>
        <Box>
          <Typography sx={{ ...t.type.overline, color: t.color.textLabel, mb: 1.25 }}>{r.open ? 'Live tally' : 'Result'}</Typography>
          {r.voterCount === 0 ? <Typography sx={{ fontSize: 13, color: t.color.textMuted }}>No ranking yet. The first one decides the order until the next.</Typography> : <Tally r={r} />}
          {r.shipped.length > 0 && <Box sx={{ mt: 2, p: 1.5, borderRadius: t.radius.input, background: t.color.raised }}><Typography sx={{ fontSize: 12, color: t.color.textLabel }}>Already shipped, taken out of the tally</Typography>{r.shipped.map((x) => <Typography key={x} sx={{ fontSize: 13, mt: 0.5, display: 'flex', gap: 1, alignItems: 'center' }}><CheckIcon size={13} /> {x}</Typography>)}</Box>}
        </Box>
        <Ballot r={r} wallet={wallet} chain={chain} onDone={onDone} />
      </Box>
    </Panel>
  )
}

export default function VotePage() {
  const wallet = useWallet()
  const { account, openWalletMenu } = wallet
  const { data: chains } = useChains()
  const chain = chains?.find((c) => c.id === ROBINHOOD) as ChainX | undefined
  const rounds = useRounds(account?.address)
  const qc = useQueryClient()
  const refresh = () => void qc.invalidateQueries({ queryKey: ['vote-rounds'] })
  const list = rounds.data ?? []
  const open = list.filter((r) => r.open), closed = list.filter((r) => !r.open)
  const latest = list[0]

  return (
    <Page>
      <PageHero
        label="Holders vote"
        badges={<Box sx={{ ...Vg, ml: 0, background: 'rgba(194,234,138,.16)', color: t.color.mark }}>{DEPLOYED ? 'Live' : 'Contract not deployed'}</Box>}
        title={<>Nothing to register.<br />Your balance is your vote.</>}
        lead={`Rank what ${BRAND.name} ships next. Your VERDEX balance is your vote, read from the token when the round is tallied: no sign-up, no snapshot, no token to lock. Tap the candidates in order, sign once, change your mind any time the round is open. A new round every two weeks; the results stay on this page. Selling is leaving the vote.`}
        action={
          <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
            <Button onClick={() => (account ? document.getElementById('vote-rounds')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) : openWalletMenu())} sx={{ ...Bt, gap: 1 }}>
              <CoinIcon size={15} /> {account ? 'Rank the candidates' : 'Connect wallet'}
            </Button>
            <Button component={Link} to="/verdex" sx={{ ...Lt, backdropFilter: 'none', gap: 1 }}><WalletIcon size={14} /> Get VERDEX</Button>
          </Box>
        }
      />

      <Stats items={[{ label: 'Rounds', value: rounds.data ? list.length : DEPLOYED ? '…' : '0' }, { label: 'Open now', value: rounds.data ? open.length : DEPLOYED ? '…' : '0' }, { label: 'Voters, latest round', value: latest ? latest.voterCount : rounds.data ? '0' : DEPLOYED ? '…' : '0' }, { label: 'Voting weight', value: latest ? fmtVerdex(latest.weightVoting).replace(' VERDEX', '') : rounds.data ? '0' : DEPLOYED ? '…' : '0' }]} />
      <Typography sx={{ fontSize: 13, color: t.color.textLabel, mt: 1.5 }}>
        Read from the {BRAND.name} Vote contract on Robinhood Chain{DEPLOYED ? <>, <Box component="a" href={explorerAddress(CONTRACT)} target="_blank" rel="noopener noreferrer" sx={{ color: t.color.text }}>{CONTRACT.slice(0, 6)}…{CONTRACT.slice(-4)}</Box></> : ''}, and from the VERDEX token for every voter's weight, right now. Borda count: with n candidates a first place is worth n times your balance, a second n minus one, and so on.
      </Typography>

      {!DEPLOYED && (
        <Panel sx={{ mt: 5, p: { xs: 3, md: 4 } }}>
          <Typography sx={{ fontSize: 16, fontWeight: 500 }}>The contract is not on the chain yet.</Typography>
          <Typography sx={{ fontSize: 14, color: t.color.textMuted, mt: 0.75 }}>The code is in the repository and tested on a fork of Robinhood Chain. The first round opens the moment it is deployed.</Typography>
        </Panel>
      )}

      <Box id="vote-rounds" sx={{ display: 'grid', gap: 2.5, mt: { xs: 5, md: 7 }, scrollMarginTop: 96 }}>
        {open.map((r) => <RoundCard key={String(r.id)} r={r} wallet={wallet} chain={chain} onDone={refresh} />)}
        {rounds.data && open.length === 0 && DEPLOYED && <Panel sx={{ p: 3 }}><Typography sx={{ fontSize: 14, color: t.color.textMuted }}>No round is open right now. The next one opens within two weeks of the last; the results below stay.</Typography></Panel>}
        {closed.length > 0 && <Typography component="h2" sx={{ ...t.type.h3, color: t.color.text, mt: 2 }}>Past rounds</Typography>}
        {closed.map((r) => <RoundCard key={String(r.id)} r={r} wallet={wallet} chain={chain} onDone={refresh} />)}
      </Box>

      <Box sx={{ mt: { xs: 8, md: 12 } }}>
        <Typography component="h2" sx={{ ...t.type.h3, color: t.color.text }}>How it works</Typography>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(3, minmax(0,1fr))' }, gap: 2.5, mt: 4 }}>
          <Step n={1} icon={<UsersIcon size={20} />} title="Rank, sign once" text="Tap the candidates in your order and sign one transaction. Your ranking lives in the contract under your address; replace it any time while the round is open. A partial ranking counts." />
          <Step n={2} icon={<CoinIcon size={20} />} title="Your balance is your weight" text="Nothing is locked or snapshotted. When the page tallies a round it reads every voter's ranking from the contract and their VERDEX balance from the token at that moment. Buy more and your vote grows; sell and it shrinks." />
          <Step n={3} icon={<ShieldIcon size={20} />} title="The admin only opens rounds" text="It cannot vote for anyone, remove a ranking or change a round once opened. A new round every two weeks; the closed ones keep their rankings onchain, so anyone can re-tally them." />
        </Box>
      </Box>

      <Panel sx={{ mt: { xs: 8, md: 12 }, p: { xs: 3, md: 5 }, display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 4, alignItems: 'center' }}>
        <Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <Box sx={{ width: 40, height: 40, borderRadius: '10px', background: '#000', border: `1px solid ${t.color.borderStrong}`, display: 'grid', placeItems: 'center' }}><MarkIcon size={22} /></Box>
            <Box sx={{ ...Vg, ml: 0 }}>Phase 2, box 11</Box>
          </Box>
          <Typography component="h2" sx={{ ...t.type.h3, color: t.color.text, mt: 2.5 }}>The next one is yours to choose.</Typography>
          <Typography sx={{ ...t.type.body, color: t.color.textMuted, mt: 2 }}>
            Eleven boxes were ours to pick. What comes after phase 2 is ranked here, by the wallets that hold the token that pays for it. The contract is short, holds nothing, and its admin can do one thing: open the next round. Unaudited; read it before you trust it, and remember a ranking is public under your address.
          </Typography>
          <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', mt: 2 }}>
            {DEPLOYED && <Box component="a" href={explorerAddress(CONTRACT)} target="_blank" rel="noopener noreferrer" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, fontSize: 13, color: t.color.text, textDecoration: 'none' }}>Contract on the explorer <ExternalIcon size={12} /></Box>}
            <Box component="a" href="https://github.com/useverdex/verdex/blob/main/contracts/VerdexVote.sol" target="_blank" rel="noopener noreferrer" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, fontSize: 13, color: t.color.text, textDecoration: 'none' }}>Source <ExternalIcon size={12} /></Box>
            <Box component={Link} to="/docs#holders-vote" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, fontSize: 13, color: t.color.text, textDecoration: 'none' }}>Docs</Box>
          </Box>
        </Box>
        <Box sx={{ display: 'grid', gap: 1.5 }}>
          {[
            [<CoinIcon key="a" size={18} />, 'Weight read live, never stored', 'A snapshot can be gamed the day before; a live balance is what you hold when the round is tallied. The page tallies; anyone can repeat it from the contract.'],
            [<UsersIcon key="b" size={18} />, 'Ranked, not one-click', 'Borda count rewards candidates that many holders put high, not just the one a whale puts first. A partial ranking gives points only to what you ranked.'],
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
