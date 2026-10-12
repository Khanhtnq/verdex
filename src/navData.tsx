import type { ComponentType } from 'react'
import { BankIcon, BarsIcon, BoltIcon, BookIcon, BriefcaseIcon, BuildingIcon, CalendarIcon, CheckIcon, CoinIcon, DocIcon, DropIcon, GemIcon, GridIcon, HandCoinIcon, HelpIcon, LayersIcon, LockIcon, PercentIcon, PieIcon, ReceiptIcon, RefreshIcon, RocketIcon, SearchIcon, ShieldIcon, SparkIcon, SwapIcon, TargetIcon, TrendIcon, UsersIcon, VaultIcon } from './components/icons'

export type NavItem = { label: string; icon: ComponentType<{ size?: number }>; path: string; soon?: boolean; divider?: boolean; action?: 'swap' | 'private' }
export type NavGroup = { label: string; match: string[]; items: NavItem[]; link?: NavItem }

const doc = (label: string, id: string, icon: NavItem['icon']): NavItem => ({ label, icon, path: `/docs#${id}` })

export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Markets',
    match: ['/assets', '/issuers', '/private-markets'],
    items: [
      { label: 'All assets', icon: GridIcon, path: '/assets' },
      { label: 'Watchlist', icon: TargetIcon, path: '/watchlist' },
      ...([
        ['Stocks', BarsIcon],
        ['ETFs and Index Funds', PieIcon],
        ['Commodities', GemIcon],
        ['Private Credit', DocIcon],
        ['Treasuries', BankIcon],
      ] as const).map(([label, icon]) => ({ label, icon, path: `/assets?category=${encodeURIComponent(label)}` })),
      { label: 'Private Markets', icon: LockIcon, path: '/private-markets' },
      { label: 'Issuers', icon: BuildingIcon, path: '/issuers', divider: true },
    ],
  },
  {
    label: 'Baskets',
    match: ['/index', '/rwa-baskets', '/vaults', '/strategies', '/launch'],
    items: [
      { label: 'Verdex Index', icon: PieIcon, path: '/index' },
      { label: 'Make your own index', icon: PieIcon, path: '/index/create' },
      { label: 'Community indexes', icon: UsersIcon, path: '/index/community' },
      { label: 'Index league', icon: BarsIcon, path: '/league' },
      { label: 'Automated Baskets', icon: RefreshIcon, path: '/rwa-baskets#automated', divider: true },
      { label: 'Index Baskets', icon: LayersIcon, path: '/rwa-baskets#baskets' },
      { label: 'Discover all Baskets', icon: SearchIcon, path: '/rwa-baskets/discover' },
      { label: 'Vaults', icon: VaultIcon, path: '/vaults', divider: true },
      { label: 'Strategies', icon: UsersIcon, path: '/strategies' },
      { label: 'Launchpad', icon: RocketIcon, path: '/launch', divider: true },
    ],
  },
  {
    label: 'Earn',
    match: ['/rwa-pools', '/pools', '/yield', '/earn'],
    items: [{ label: 'Yield on idle USDG', icon: PercentIcon, path: '/earn/idle' }, { label: 'Verdex Pools', icon: BoltIcon, path: '/pools' }, { label: 'Tokenized Pools', icon: DropIcon, path: '/rwa-pools' }, { label: 'Asset Yield', icon: PercentIcon, path: '/yield', divider: true }],
  },
  {
    label: 'Lend and Borrow',
    match: ['/lend'],
    items: [
      { label: 'Verdex Lend', icon: HandCoinIcon, path: '/lend/verdex' },
      { label: 'Term loans', icon: HandCoinIcon, path: '/lend/term' },
      { label: 'Leverage', icon: TrendIcon, path: '/leverage' },
      { label: 'Verdex on Solana', icon: PieIcon, path: '/solana' },
      { label: 'Orders without you', icon: TargetIcon, path: '/orders/without-you' },
      { label: 'Vaults without you', icon: VaultIcon, path: '/vaults/without-you' },
      { label: 'Copy a wallet', icon: SearchIcon, path: '/copy' },
      { label: 'Gift a stock', icon: GemIcon, path: '/gift' },
      { label: 'Lend and Borrow', icon: HandCoinIcon, path: '/lend' },
      { label: 'Multiply', icon: TrendIcon, path: '/lend?tab=multiply' },
    ],
  },
  {
    label: 'Trade',
    match: ['/'],
    items: [
      { label: 'Swap and Bridge', icon: SwapIcon, path: '/', action: 'swap' },
      { label: 'Private Swap', icon: LockIcon, path: '/', action: 'private' },
      { label: 'Auto-Invest', icon: CalendarIcon, path: '/auto-invest', divider: true },
      { label: 'Auto-Invest without you', icon: RefreshIcon, path: '/auto-invest/without-you' },
      { label: 'Auto-Invest into any index', icon: RefreshIcon, path: '/index/auto-invest' },
      { label: 'Orders', icon: TargetIcon, path: '/orders' },
      { label: 'Stock options', icon: TargetIcon, path: '/options' },
      { label: 'Agent', icon: SparkIcon, path: '/agent' },
      { label: 'Agent without you', icon: SparkIcon, path: '/agent/without-you' },
      { label: 'The Verdex app', icon: SparkIcon, path: '/app', divider: true },
      { label: 'Notifications', icon: SparkIcon, path: '/notifications' },
      { label: 'VERDEX token', icon: CoinIcon, path: '/verdex', divider: true },
      { label: 'Fees buy VERDEX', icon: ReceiptIcon, path: '/treasury' },
      { label: 'Verdex in numbers', icon: BarsIcon, path: '/numbers' },
      { label: 'Holders', icon: UsersIcon, path: '/holders' },
      { label: 'Share cards', icon: SparkIcon, path: '/share' },
      { label: 'Holders vote', icon: UsersIcon, path: '/vote' },
    ],
  },
  { label: 'Portfolio', match: ['/portfolio', '/profile'], items: [], link: { label: 'Portfolio', icon: BriefcaseIcon, path: '/portfolio' } },
  {
    label: 'Docs',
    match: ['/docs'],
    items: [
      doc('Overview', 'overview', BookIcon),
      doc('Tokenized Baskets', 'tokenized-baskets', LayersIcon),
      doc('Tokenized Pools', 'tokenized-pools', DropIcon),
      doc('Verdex Pools', 'verdex-pools', BoltIcon),
      doc('Asset Yield', 'asset-yield', PercentIcon),
      doc('Launchpad', 'launchpad', RocketIcon),
      doc('Private Markets', 'private-markets', LockIcon),
      doc('Auto-Invest without you', 'auto-invest-without-you', RefreshIcon),
      doc('Verdex Index', 'verdex-index', PieIcon),
      doc('Fees buy VERDEX', 'fees-buy-verdex', ReceiptIcon),
      doc('Verdex Lend', 'verdex-lend', HandCoinIcon),
      doc('Leverage', 'leverage', TrendIcon),
      doc('Orders without you', 'orders-without-you', TargetIcon),
      doc('Vaults without you', 'vaults-without-you', VaultIcon),
      doc('Agent without you', 'agent-without-you', SparkIcon),
      doc('Verdex in numbers', 'verdex-in-numbers', BarsIcon),
      doc('Holders vote', 'holders-vote', UsersIcon),
      doc('Copy a wallet', 'copy-a-wallet', SearchIcon),
      doc('Verdex API', 'api', DocIcon),
      doc('Lend and Borrow', 'lend-and-borrow', HandCoinIcon),
      doc('Fees', 'fees', ReceiptIcon),
      doc('Holding VERDEX', 'holding', CoinIcon),
      doc('Safety', 'safety', ShieldIcon),
      doc('Audit', 'audit', CheckIcon),
      doc('FAQ', 'faq', HelpIcon),
    ],
  },
]


export function groupMatches(group: NavGroup, pathname: string) {
  return group.match.some((m) => (m === '/' ? pathname === '/' : pathname.startsWith(m)))
}

export function itemActive(item: NavItem, pathname: string, search: string, hash: string) {
  if (item.action || item.soon) return false
  const [beforeHash, h] = item.path.split('#')
  const [p, q = ''] = beforeHash.split('?')
  return pathname === p && search.replace(/^\?/, '') === q && (!h || hash === `#${h}`)
}

export function scrollToId(id: string, tries = 30) {
  const el = document.getElementById(id)
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  else if (tries > 0) setTimeout(() => scrollToId(id, tries - 1), 100)
}
