// Notifications: turn on push for this device and pick the wallets it follows.
import { useEffect, useState } from 'react'
import { Box, Button, InputBase, Typography } from '@mui/material'
import { isAddress } from 'viem'
import { t } from '../theme/tokens'
import { Bt, Lt, Vg } from '../theme/styles'
import { current, disable, enable, followed, pushSupported, sendTest } from '../lib/push'
import { isIOS, isStandalone } from '../lib/pwa'
import { useWallet } from '../components/wallet/WalletProvider'
import { EarlyGate } from '../components/EarlyGate'
import { Page, PageHero, Panel } from './common'

const WHAT = [
  ['Orders', 'a limit or stop order fills, on Robinhood Chain or Base'],
  ['Auto-Invest', 'a recurring buy runs, into a stock or into any index'],
  ['Vaults', 'a vault rebalances back to its targets'],
  ['Agent', 'your agent trades within its mandate'],
  ['Term loans', 'a loan of yours starts, is repaid, or its collateral is claimed'],
  ['Options', 'an option you wrote is bought, or an option is exercised'],
]
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

export default function NotificationsPage() {
  const wallet = useWallet()
  const me = wallet.account?.address
  const [on, setOn] = useState<boolean | null>(null)
  const [list, setList] = useState<string[]>(followed)
  const [extra, setExtra] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>()
  useEffect(() => { void current().then((s) => setOn(!!s)) }, [])
  const wanted = [...new Set([...(me ? [me.toLowerCase()] : []), ...list])].slice(0, 5)
  const apply = async (addrs: string[]) => {
    setBusy(true); setMsg(undefined)
    try { await enable(addrs); setList(followed()); setOn(true); setMsg({ ok: true, text: 'On. This device will get a notification when something happens to these wallets.' }) } catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }) }
    setBusy(false)
  }
  const off = async () => { setBusy(true); await disable(); setList([]); setOn(false); setBusy(false); setMsg({ ok: true, text: 'Off.' }) }
  const iosNeedsApp = isIOS() && !isStandalone()
  return (
    <EarlyGate path="/notifications">
      <Page>
        <PageHero label="Notifications" badges={<Box sx={{ ...Vg, ml: 0, background: 'rgba(194,234,138,.16)', color: t.color.mark }}>New</Box>}
          title={<>Know when<br />it runs.</>}
          lead="Everything that runs without you can now tell you when it ran. Turn on notifications and this phone or computer gets one when an order fills, a plan buys, a vault rebalances, your agent trades, or a loan or an option of yours moves. No account and no email: the device follows wallet addresses, nothing else." />
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0,1fr)', md: 'minmax(0,1fr) minmax(0,1fr)' }, gap: 2.5, mt: 4, alignItems: 'start' }}>
          <Panel sx={{ p: { xs: 2.5, md: 3 } }}>
            <Typography sx={{ fontSize: 16, fontWeight: 500 }}>This device</Typography>
            <Typography sx={{ fontSize: 13, color: t.color.textMuted, mt: 1 }}>{on === null ? 'Checking…' : on ? `On, following ${list.length ? list.map(short).join(', ') : 'no wallet yet'}.` : 'Off.'}</Typography>
            {iosNeedsApp && <Typography sx={{ fontSize: 13, color: t.color.textMuted, mt: 1.5 }}>On iPhone, notifications work from the Verdex app: tap Share, then Add to Home Screen, and open Verdex from there.</Typography>}
            {!pushSupported() && !iosNeedsApp && <Typography sx={{ fontSize: 13, color: t.color.red, mt: 1.5 }}>This browser has no push notifications.</Typography>}
            <Typography sx={{ ...t.type.overline, color: t.color.textLabel, mt: 2.5, mb: 1 }}>Wallets to follow (up to 5)</Typography>
            <Box sx={{ display: 'grid', gap: 0.75 }}>
              {wanted.map((a) => <Box key={a} sx={{ display: 'flex', alignItems: 'center', gap: 1, p: 1, borderRadius: t.radius.input, background: t.color.raised }}><Typography sx={{ fontSize: 13, flex: 1 }}>{short(a)}{a === me?.toLowerCase() ? ' · connected' : ''}</Typography>{a !== me?.toLowerCase() && <Box component="button" type="button" onClick={() => setList((l) => l.filter((x) => x !== a))} sx={{ all: 'unset', cursor: 'pointer', fontSize: 12, color: t.color.textMuted }}>Remove</Box>}</Box>)}
              {!me && wanted.length === 0 && <Typography sx={{ fontSize: 13, color: t.color.textMuted }}>Connect a wallet, or paste an address below.</Typography>}
            </Box>
            <Box sx={{ display: 'flex', gap: 1, mt: 1 }}>
              <InputBase value={extra} onChange={(e) => setExtra(e.target.value.trim())} placeholder="0x… another wallet" inputProps={{ 'aria-label': 'Wallet address' }} sx={{ flex: 1, height: 40, px: 1.5, borderRadius: t.radius.input, background: t.color.hover, fontSize: 13 }} />
              <Button disabled={!isAddress(extra)} onClick={() => { setList((l) => [...new Set([...l, extra.toLowerCase()])]); setExtra('') }} sx={{ ...Lt, backdropFilter: 'none', height: 40, px: 2 }}>Add</Button>
            </Box>
            <Box sx={{ display: 'flex', gap: 1, mt: 2.5, flexWrap: 'wrap' }}>
              <Button disabled={busy || wanted.length === 0 || !pushSupported()} onClick={() => void apply(wanted)} sx={{ ...Bt, height: 44, px: 2.5 }}>{on ? 'Save' : 'Turn on notifications'}</Button>
              {on && <Button onClick={() => void sendTest()} sx={{ ...Lt, backdropFilter: 'none', height: 44, px: 2 }}>Send a test</Button>}
              {on && <Button disabled={busy} onClick={() => void off()} sx={{ ...Lt, backdropFilter: 'none', height: 44, px: 2 }}>Turn off</Button>}
            </Box>
            {msg && <Typography sx={{ fontSize: 12, color: msg.ok ? t.color.mark : t.color.red, mt: 1.5 }}>{msg.text}</Typography>}
          </Panel>
          <Panel sx={{ p: { xs: 2.5, md: 3 } }}>
            <Typography sx={{ fontSize: 16, fontWeight: 500 }}>What you hear about</Typography>
            <Box sx={{ display: 'grid', gap: 0.75, mt: 2 }}>
              {WHAT.map(([k, v]) => <Box key={k} sx={{ p: 1.25, borderRadius: t.radius.input, background: t.color.raised }}><Typography sx={{ fontSize: 13, fontWeight: 500 }}>{k}</Typography><Typography sx={{ fontSize: 12, color: t.color.textMuted }}>When {v}.</Typography></Box>)}
            </Box>
            <Typography sx={{ fontSize: 12, color: t.color.textLabel, mt: 2.5 }}>The Verdex server watches the contracts and sends the push through your browser's own push service. It knows this device's push address and the wallets you chose, nothing more. Turn it off here any time.</Typography>
          </Panel>
        </Box>
      </Page>
    </EarlyGate>
  )
}
