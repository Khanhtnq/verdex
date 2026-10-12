import { lazy, Suspense, useEffect } from 'react'
import { Box } from '@mui/material'
import { Route, Routes, useLocation } from 'react-router-dom'
import { EarlyGate } from './components/EarlyGate'
import { t } from './theme/tokens'
import { Nav } from './components/Nav'
import { Footer } from './components/Footer'
import { WalletDialog } from './components/wallet/WalletButton'
import { TabBar } from './components/TabBar'
import { InstallSheet } from './components/InstallSheet'
import { DueBuys } from './components/DueBuys'
import { Landing } from './landing/Landing'

const AssetsPage = lazy(() => import('./pages/AssetsPage'))
const IssuersPage = lazy(() => import('./pages/IssuersPage'))
const BasketsPage = lazy(() => import('./pages/BasketsPage'))
const DiscoverPage = lazy(() => import('./pages/DiscoverPage'))
const PoolsPage = lazy(() => import('./pages/PoolsPage'))
const LendPage = lazy(() => import('./pages/LendPage'))
const PortfolioPage = lazy(() => import('./pages/PortfolioPage'))
const AutoInvestPage = lazy(() => import('./pages/AutoInvestPage'))
const VaultsPage = lazy(() => import('./pages/VaultsPage'))
const StrategiesPage = lazy(() => import('./pages/StrategiesPage'))
const OrdersPage = lazy(() => import('./pages/OrdersPage'))
const AgentPage = lazy(() => import('./pages/AgentPage'))
const TokenPage = lazy(() => import('./pages/TokenPage'))
const VerdexPoolsPage = lazy(() => import('./pages/VerdexPoolsPage'))
const AssetYieldPage = lazy(() => import('./pages/AssetYieldPage'))
const LaunchPage = lazy(() => import('./pages/LaunchPage'))
const PrivateMarketsPage = lazy(() => import('./pages/PrivateMarketsPage'))
const AutoPilotPage = lazy(() => import('./pages/AutoPilotPage'))
const IndexPage = lazy(() => import('./pages/IndexPage'))
const DeployIndexPage = lazy(() => import('./pages/DeployIndexPage'))
const SolanaPage = lazy(() => import('./pages/SolanaPage'))
const OrdersWithoutYouPage = lazy(() => import('./pages/OrdersWithoutYouPage'))
const DeployOrdersPage = lazy(() => import('./pages/DeployOrdersPage'))
const VaultsWithoutYouPage = lazy(() => import('./pages/VaultsWithoutYouPage'))
const DeployVaultsPage = lazy(() => import('./pages/DeployVaultsPage'))
const AgentWithoutYouPage = lazy(() => import('./pages/AgentWithoutYouPage'))
const DeployAgentPage = lazy(() => import('./pages/DeployAgentPage'))
const NumbersPage = lazy(() => import('./pages/NumbersPage'))
const HoldersPage = lazy(() => import('./pages/HoldersPage'))
const StockPage = lazy(() => import('./pages/StockPage'))
const IndexCreatePage = lazy(() => import('./pages/IndexCreatePage'))
const IndexViewPage = lazy(() => import('./pages/IndexViewPage'))
const CommunityIndexesPage = lazy(() => import('./pages/CommunityIndexesPage'))
const GiftPage = lazy(() => import('./pages/GiftPage'))
const GiftClaimPage = lazy(() => import('./pages/GiftClaimPage'))
const SharePage = lazy(() => import('./pages/SharePage'))
const WatchlistPage = lazy(() => import('./pages/WatchlistPage'))
const IndexAutoInvestPage = lazy(() => import('./pages/IndexAutoInvestPage'))
const LeaguePage = lazy(() => import('./pages/LeaguePage'))
import { AlertWatcher } from './components/AlertWatcher'
const VotePage = lazy(() => import('./pages/VotePage'))
const CopyPage = lazy(() => import('./pages/CopyPage'))
const DeployVotePage = lazy(() => import('./pages/DeployVotePage'))
const VerdexLendPage = lazy(() => import('./pages/VerdexLendPage'))
const DeployLendPage = lazy(() => import('./pages/DeployLendPage'))
const LeveragePage = lazy(() => import('./pages/LeveragePage'))
const DeployLeveragePage = lazy(() => import('./pages/DeployLeveragePage'))
const TreasuryPage = lazy(() => import('./pages/TreasuryPage'))
const DeployTreasuryPage = lazy(() => import('./pages/DeployTreasuryPage'))
const DeployAutoInvestPage = lazy(() => import('./pages/DeployAutoInvestPage'))
const DocsPage = lazy(() => import('./pages/DocsPage'))
const LegalPage = lazy(() => import('./pages/LegalPage'))
const NotFoundPage = lazy(() => import('./pages/NotFoundPage'))

function BgLayer() {
  return (
    <Box
      sx={{
        position: 'fixed',
        inset: 0,
        zIndex: -1,
        pointerEvents: 'none',
        overflow: 'hidden',
        background: t.color.page,
        transition: 'background .3s cubic-bezier(0.25, 0.8, 0.25, 1)',
        '&::before': { content: '""', position: 'absolute', left: '50%', top: -320, width: 1100, height: 640, transform: 'translateX(-50%)', background: 'radial-gradient(50% 50%, rgba(143,166,97,.10) 0%, rgba(0,0,0,0) 100%)', opacity: 1, transition: 'opacity .3s cubic-bezier(0.25, 0.8, 0.25, 1)' },
      }}
    />
  )
}

// One title per route, for tabs, history, sharing and search results.
const TITLES: [string, string][] = [
  ['/assets', 'Markets'],
  ['/issuers', 'Issuers'],
  ['/rwa-baskets/discover', 'Discover Baskets'],
  ['/rwa-baskets', 'Baskets'],
  ['/rwa-pools', 'Tokenized Pools'],
  ['/pools', 'Verdex Pools'],
  ['/yield', 'Asset Yield'],
  ['/launch', 'Launchpad'],
  ['/private-markets', 'Private Markets'],
  ['/lend', 'Lend and Borrow'],
  ['/portfolio', 'Portfolio'],
  ['/auto-invest/without-you', 'Auto-Invest without you'],
  ['/auto-invest', 'Auto-Invest'],
  ['/deploy/auto-invest', 'Deploy Auto-Invest'],
  ['/index', 'Verdex Index'],
  ['/lend/verdex', 'Verdex Lend'],
  ['/deploy/lend', 'Deploy Verdex Lend'],
  ['/leverage', 'Leverage'],
  ['/deploy/leverage', 'Deploy Leverage'],
  ['/deploy/index', 'Deploy Verdex Index'],
  ['/solana', 'Verdex on Solana'],
  ['/orders/without-you', 'Orders without you'],
  ['/deploy/orders', 'Deploy Orders without you'],
  ['/vaults/without-you', 'Vaults without you'],
  ['/deploy/vaults', 'Deploy Vaults without you'],
  ['/agent/without-you', 'Agent without you'],
  ['/deploy/agent', 'Deploy Agent without you'],
  ['/numbers', 'Verdex in numbers'],
  ['/holders', 'VERDEX holders'],
  ['/index/create', 'Make your own index'],
  ['/index/community', 'Community indexes'],
  ['/gift', 'Gift a stock'],
  ['/gift/claim', 'A gift for you'],
  ['/share', 'Share cards'],
  ['/watchlist', 'Watchlist'],
  ['/index/auto-invest', 'Auto-Invest into any index'],
  ['/league', 'Index league'],
  ['/vote', 'Holders vote'],
  ['/copy', 'Copy a wallet'],
  ['/deploy/vote', 'Deploy Holders vote'],
  ['/treasury', 'Fees buy VERDEX'],
  ['/deploy/treasury', 'Deploy Treasury'],
  ['/vaults', 'Vaults'],
  ['/strategies', 'Strategies'],
  ['/orders', 'Orders'],
  ['/agent', 'Agent'],
  ['/verdex', 'VERDEX token'],
  ['/docs', 'Docs'],
  ['/terms', 'Terms of Service'],
  ['/privacy', 'Privacy Policy'],
]
const BASE_TITLE = 'Verdex: Unified Marketplace for Real-World Assets'
function RouteTitle() {
  const { pathname } = useLocation()
  useEffect(() => {
    const hit = TITLES.find(([p]) => pathname === p || pathname.startsWith(p + '/'))
    document.title = hit ? `${hit[1]} · Verdex` : BASE_TITLE
  }, [pathname])
  return null
}

function ScrollToTop() {
  const { pathname, hash } = useLocation()
  useEffect(() => {
    if (!hash) window.scrollTo({ top: 0 })
  }, [pathname, hash])
  return null
}

export default function App() {
  return (
    <>
      <BgLayer />
      <ScrollToTop />
      <RouteTitle />
      <Nav />
      <Box component="main">
        <Suspense fallback={<Box sx={{ minHeight: '60dvh' }} />}>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/assets" element={<AssetsPage />} />
            <Route path="/assets/:ticker" element={<EarlyGate path="/stock"><StockPage /></EarlyGate>} />
            <Route path="/issuers" element={<IssuersPage />} />
            <Route path="/rwa-baskets" element={<BasketsPage />} />
            <Route path="/rwa-baskets/discover" element={<DiscoverPage />} />
            <Route path="/rwa-pools" element={<PoolsPage />} />
            <Route path="/pools" element={<EarlyGate path="/pools"><VerdexPoolsPage /></EarlyGate>} />
            <Route path="/yield" element={<EarlyGate path="/yield"><AssetYieldPage /></EarlyGate>} />
            <Route path="/launch" element={<EarlyGate path="/launch"><LaunchPage /></EarlyGate>} />
            <Route path="/private-markets" element={<EarlyGate path="/private-markets"><PrivateMarketsPage /></EarlyGate>} />
            <Route path="/lend" element={<LendPage />} />
            <Route path="/portfolio" element={<PortfolioPage />} />
            <Route path="/auto-invest" element={<EarlyGate path="/auto-invest"><AutoInvestPage /></EarlyGate>} />
            <Route path="/auto-invest/without-you" element={<EarlyGate path="/auto-invest/without-you"><AutoPilotPage /></EarlyGate>} />
            <Route path="/deploy/auto-invest" element={<DeployAutoInvestPage />} />
            <Route path="/index" element={<EarlyGate path="/index"><IndexPage /></EarlyGate>} />
            <Route path="/index/create" element={<IndexCreatePage />} />
            <Route path="/index/auto-invest" element={<IndexAutoInvestPage />} />
            <Route path="/index/community" element={<CommunityIndexesPage />} />
            <Route path="/gift" element={<GiftPage />} />
            <Route path="/gift/claim" element={<GiftClaimPage />} />
            <Route path="/share" element={<SharePage />} />
            <Route path="/watchlist" element={<WatchlistPage />} />
            <Route path="/league" element={<LeaguePage />} />
            <Route path="/index/:chain/:address" element={<EarlyGate path="/index/create"><IndexViewPage /></EarlyGate>} />
            <Route path="/deploy/index" element={<DeployIndexPage />} />
            <Route path="/deploy/index/:chainKey" element={<DeployIndexPage />} />
            <Route path="/solana" element={<EarlyGate path="/solana"><SolanaPage /></EarlyGate>} />
            <Route path="/orders/without-you" element={<EarlyGate path="/orders/without-you"><OrdersWithoutYouPage /></EarlyGate>} />
            <Route path="/deploy/orders" element={<DeployOrdersPage />} />
            <Route path="/vaults/without-you" element={<EarlyGate path="/vaults/without-you"><VaultsWithoutYouPage /></EarlyGate>} />
            <Route path="/deploy/vaults" element={<DeployVaultsPage />} />
            <Route path="/agent/without-you" element={<EarlyGate path="/agent/without-you"><AgentWithoutYouPage /></EarlyGate>} />
            <Route path="/deploy/agent" element={<DeployAgentPage />} />
            <Route path="/numbers" element={<EarlyGate path="/numbers"><NumbersPage /></EarlyGate>} />
            <Route path="/holders" element={<EarlyGate path="/holders"><HoldersPage /></EarlyGate>} />
            <Route path="/vote" element={<EarlyGate path="/vote"><VotePage /></EarlyGate>} />
            <Route path="/copy" element={<EarlyGate path="/copy"><CopyPage /></EarlyGate>} />
            <Route path="/deploy/vote" element={<DeployVotePage />} />
            <Route path="/lend/verdex" element={<EarlyGate path="/lend/verdex"><VerdexLendPage /></EarlyGate>} />
            <Route path="/deploy/lend" element={<DeployLendPage />} />
            <Route path="/leverage" element={<EarlyGate path="/leverage"><LeveragePage /></EarlyGate>} />
            <Route path="/deploy/leverage" element={<DeployLeveragePage />} />
            <Route path="/treasury" element={<TreasuryPage />} />
            <Route path="/deploy/treasury" element={<DeployTreasuryPage />} />
            <Route path="/vaults" element={<EarlyGate path="/vaults"><VaultsPage /></EarlyGate>} />
            <Route path="/strategies" element={<EarlyGate path="/strategies"><StrategiesPage /></EarlyGate>} />
            <Route path="/orders" element={<EarlyGate path="/orders"><OrdersPage /></EarlyGate>} />
            <Route path="/agent" element={<EarlyGate path="/agent"><AgentPage /></EarlyGate>} />
            <Route path="/verdex" element={<EarlyGate path="/verdex"><TokenPage /></EarlyGate>} />
            <Route path="/docs" element={<DocsPage />} />
            <Route path="/terms" element={<LegalPage kind="terms" />} />
            <Route path="/privacy" element={<LegalPage kind="privacy" />} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </Suspense>
      </Box>
      <Footer />
      <TabBar />
      <InstallSheet />
      <AlertWatcher />
      <DueBuys />
      <WalletDialog />
    </>
  )
}
