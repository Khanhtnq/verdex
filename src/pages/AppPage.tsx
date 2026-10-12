// The Verdex app: install it on a phone or a computer, and what it does once installed.
import { useEffect, useState } from 'react'
import { Box, Button, Typography } from '@mui/material'
import { Link as RouterLink } from 'react-router-dom'
import { t } from '../theme/tokens'
import { Bt, Lt, Vg } from '../theme/styles'
import { canPromptInstall, isIOS, isStandalone, onInstallPromptChange, promptInstall } from '../lib/pwa'
import { pushSupported } from '../lib/push'
import { EarlyGate } from '../components/EarlyGate'
import { Page, PageHero, Panel } from './common'

const FEATURES = [
  ['On your home screen', 'Opens full screen, like any app, straight into Verdex. The shell is cached, so it opens fast even on a bad connection.'],
  ['Notifications', 'A push when an order fills, a plan runs, a vault rebalances, your agent trades, or a loan or option of yours moves.'],
  ['Shortcuts', 'Long-press the icon for Portfolio, Notifications, Term loans and Options.'],
  ['Same wallet, same keys', 'Connect the wallet app you already use. Verdex never holds your keys or your funds.'],
]

export default function AppPage() {
  const [, bump] = useState(0)
  useEffect(() => onInstallPromptChange(() => bump((n) => n + 1)), [])
  const installed = isStandalone()
  const ios = isIOS()
  const [msg, setMsg] = useState('')
  const install = async () => { const r = await promptInstall(); setMsg(r === 'accepted' ? 'Installed. Open Verdex from your home screen.' : r === 'dismissed' ? 'Maybe later.' : 'Use your browser menu: Install app, or Add to Home Screen.') }
  return (
    <EarlyGate path="/app">
      <Page>
        <PageHero label="The Verdex app" badges={<Box sx={{ ...Vg, ml: 0, background: 'rgba(194,234,138,.16)', color: t.color.mark }}>New</Box>}
          title={<>Verdex,<br />in your pocket.</>}
          lead="Install Verdex on your phone in two taps: no app store, no account, nothing to download but the app itself. It opens full screen from your home screen and tells you when your orders fill, your plans run and your agent trades." />
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0,1fr)', md: 'minmax(0,1fr) minmax(0,1fr)' }, gap: 2.5, mt: 4, alignItems: 'start' }}>
          <Panel sx={{ p: { xs: 2.5, md: 3 } }}>
            <Typography sx={{ fontSize: 16, fontWeight: 500 }}>{installed ? 'You are in the app' : 'Install it'}</Typography>
            {installed ? (
              <Typography sx={{ fontSize: 13, color: t.color.textMuted, mt: 1 }}>Verdex is running from your home screen. Turn on notifications next.</Typography>
            ) : ios ? (
              <Box component="ol" sx={{ fontSize: 14, color: t.color.textMuted, pl: 2.5, mt: 1.5, display: 'grid', gap: 1 }}>
                <li>Open useverdex.xyz in Safari.</li>
                <li>Tap the Share button at the bottom.</li>
                <li>Tap Add to Home Screen, then Add.</li>
                <li>Open Verdex from the home screen and turn on notifications.</li>
              </Box>
            ) : (
              <>
                <Typography sx={{ fontSize: 13, color: t.color.textMuted, mt: 1 }}>{canPromptInstall() ? 'One tap and it is on your home screen or in your dock.' : 'On Android, open the browser menu and tap Install app. On a computer, use the install icon in the address bar.'}</Typography>
                {canPromptInstall() && <Button onClick={() => void install()} sx={{ ...Bt, height: 44, px: 2.5, mt: 2 }}>Install Verdex</Button>}
              </>
            )}
            {msg && <Typography sx={{ fontSize: 12, color: t.color.mark, mt: 1.5 }}>{msg}</Typography>}
            <Box sx={{ display: 'flex', gap: 1, mt: 2.5, flexWrap: 'wrap' }}>
              <Button component={RouterLink} to="/notifications" sx={{ ...(installed || !ios ? Bt : Lt), backdropFilter: 'none', height: 40, px: 2 }}>{pushSupported() ? 'Turn on notifications' : 'Notifications'}</Button>
              <Button component={RouterLink} to="/portfolio" sx={{ ...Lt, backdropFilter: 'none', height: 40, px: 2 }}>Portfolio</Button>
            </Box>
          </Panel>
          <Panel sx={{ p: { xs: 2.5, md: 3 } }}>
            <Typography sx={{ fontSize: 16, fontWeight: 500 }}>What you get</Typography>
            <Box sx={{ display: 'grid', gap: 0.75, mt: 2 }}>
              {FEATURES.map(([k, v]) => <Box key={k} sx={{ p: 1.25, borderRadius: t.radius.input, background: t.color.raised }}><Typography sx={{ fontSize: 13, fontWeight: 500 }}>{k}</Typography><Typography sx={{ fontSize: 12, color: t.color.textMuted }}>{v}</Typography></Box>)}
            </Box>
          </Panel>
        </Box>
      </Page>
    </EarlyGate>
  )
}
