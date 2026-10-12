import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, HashRouter } from 'react-router-dom'
import { ThemeProvider } from '@mui/material/styles'
import CssBaseline from '@mui/material/CssBaseline'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { theme } from './theme/mui'
import { WalletProvider } from './components/wallet/WalletProvider'
import App from './App'
import { loadLogoPack } from './lib/logos'
import { registerServiceWorker } from './lib/pwa'
import { refreshPush } from './lib/push'
import './index.css'

// The hosted preview runs from a sub-path, so it uses hash routing; production uses clean URLs.
const Router = import.meta.env.VITE_HASH_ROUTER === '1' ? HashRouter : BrowserRouter

const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } } })

const render = () =>
  createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider theme={theme} defaultMode="dark">
        <CssBaseline />
        <WalletProvider>
          <Router>
            <App />
          </Router>
        </WalletProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
)

// The hosted preview carries its logos in one packed file; load it before the first paint.
if (import.meta.env.VITE_LOGO_PACK === '1') loadLogoPack().finally(render)
else render()
registerServiceWorker()
void refreshPush().catch(() => {})
