# Verdex

The front door to tokenized markets. Verdex is a non-custodial marketplace for real-world assets:
tokenized stocks, ETFs, commodities, private credit and treasuries from every issuer, on every chain,
bought, sold, bridged, scheduled, held in vaults, lent and borrowed from the user's own wallet.

Live at [useverdex.xyz](https://useverdex.xyz). Token: VERDEX on Robinhood Chain,
`0x96f455a90a80dcf0c2df6703ea4ba3bedf286e43`. Updates on [@useverdex](https://x.com/useverdex).

## What it does

- **Markets.** Every tokenized stock, ETF, commodity, private-credit and treasury token Verdex knows
  about, grouped by underlying asset so NVDA from Ondo, xStocks, bStocks, Robinhood and Coinbase sit in
  one row with their chains and prices. Search, categories, issuers.
- **Swap and Bridge.** Live routes priced through the LI.FI aggregator across the DEXs, bridges and
  solvers it reaches. Any EVM chain in, any listed asset out, one signature. A private-swap mode sends
  the output to a different address.
- **Auto-Invest.** A recurring buy of any listed asset: amount, cadence, pay token. The first buy
  approves the pay token once; each buy after that is one confirmation on its day, priced live.
- **Vaults.** A target allocation across up to twelve assets on one chain, curated or custom. Balances
  and prices are read live, drift is computed against the targets, and when a vault passes its
  threshold or its date, Verdex plans the trades (sells of the overweight, buys of the underweight)
  and the wallet confirms them one by one.
- **Strategies and Orders.** Follow a published allocation into your own vault, or share one as a
  link. Limit and stop orders on any listed asset, watched while the app is open and filled with a
  swap the wallet confirms.
- **Agent.** Ask for an order, a recurring buy or a vault in plain words. Bring your own Anthropic or
  OpenAI key (kept in the browser, sent only to that provider); the agent reads the market snapshot,
  the live price feed and the connected wallet through a fixed set of tools and drafts each action as
  a card. Nothing is placed, scheduled or created until the card is approved, and the wallet still
  confirms every trade. Without a key, a small rules-based helper drafts the same cards.
- **Verdex Pools.** Liquidity for tokenized stocks on Robinhood Chain through the Uniswap v3
  contracts already there: every stock pool from the factory with live price, liquidity, volume and
  fee APR, a range and amount composer, and your positions with fees, collect and remove. No Verdex
  contract and no Verdex fee.
- **Asset Yield.** What sits idle in a wallet on Robinhood Chain, put to work through public
  contracts only: a tokenized stock goes into a one-sided Uniswap v3 band just above its price (earns
  the pool fee on every trade that reaches it, stays yours below it, sold only through the top), and
  USDG goes into Spark Savings USDG, an ERC-4626 vault at the rate Spark pays. Stop or withdraw any
  time from the same page.
- **Launchpad.** Launch a token on Robinhood Chain through the Pons V2 contracts that created
  VERDEX: fixed supply, a bonding curve quoted in ETH, USDG or one of the tokenized stocks the factory
  accepts, a first buy in the same transaction, graduation into a Uniswap v4 pool with locked
  liquidity, and a creator fee paid on every trade. A live feed of every launch on the factory and
  the wallet's own launches. No Verdex contract and no Verdex fee.
- **Auto-Invest without you.** The one Verdex contract: `contracts/VerdexAutoInvest.sol` on Robinhood
  Chain. Approve an exact USDG allowance, set a plan (stock, amount, cadence, number of buys) and an
  executor runs each buy when due: the contract pulls one buy's worth, swaps it in the stock's Uniswap
  v3 pool with a price floor read from the pool, sends the stock to the owner and a tip to the executor.
  It holds nothing between buys; the admin only keeps the executor list. The executor
  (`scripts/executor-lib.mjs`) runs every ten minutes inside `server.mjs`, the Node process that
  serves the built site on Railway, from a gas-only wallet whose key is read from the `EXECUTOR_KEY`
  environment variable (or `executor.key`, which never leaves the private repository); `scripts/autoinvest-executor.mjs` runs one pass from a shell or a cron. On Base the same contract over Slipstream pools
  (`contracts/VerdexAutoInvestCL.sol`, `scripts/deploy-autoinvest-base.mjs`, `?chain=base`, USDC).
- **Verdex Index.** Baskets of tokenized stocks as one ERC-20 each: `contracts/VerdexIndex.sol` (the index and its
  factory) and `contracts/VerdexIndexRouter.sol` (USDG in, shares out, in one transaction through the stocks' Uniswap
  v3 pools, with a per-leg price floor and a fee waived for VERDEX holders). Fixed units per share, redeem in kind
  any time, a supply cap as the creator's only lever. Deployed from `/deploy/index`.
- **Verdex on Base.** The same indexes on Base, made of Coinbase's tokenized stocks (NVDAc, TSLAc and the rest) and
  quoted in USDC through Aerodrome Slipstream pools: `contracts/VerdexIndexRouterCL.sol` is the router variant that
  looks pools up by tick spacing. The chain selector on `/index` switches between Robinhood Chain and Base;
  `src/lib/indexChains.ts` holds each chain's DEX, quote token and deployed addresses. Deployed from
  `/deploy/index/base`. The Coinbase tokens are executed natively by Base's nodes (their code is `0xef`), so they cannot
  run on a local fork; the flow was tested against Base's live state with `eth_simulateV1` instead.
- **Orders without you.** `contracts/VerdexOrders.sol`: limit and stop orders that fill while the owner is away, the
  Auto-Invest pattern applied to orders. An order keeps its level as the pool's own sqrtPriceX96; the executor (the
  same pass as Auto-Invest, in `scripts/executor-lib.mjs`) fills triggered orders from the owner's exact allowance
  with a spot-less-1% floor read at fill time, the tip in USDG. Four kinds: buy below, stop sell, sell above, buy
  above; optional expiry. Deployed from `/deploy/orders`; the page is `/orders/without-you`. On Base the same contract
  over Slipstream pools (`contracts/VerdexOrdersCL.sol`, `scripts/deploy-orders-base.mjs`, `?chain=base`, USDC).
- **Vaults without you.** `contracts/VerdexVaults.sol`: target weights kept by a contract. Holdings are valued at the
  pools' spot prices; when a weight drifts past the threshold and the interval has passed, the executor (same pass as
  Auto-Invest and Orders) sells the overweight stocks for USDG, takes a ten-cent tip, buys the underweight ones and
  sends everything to the owner, in one transaction with spot-less-1% floors. Allowances are per stock, exactly what
  the owner holds. Deployed from `/deploy/vaults`; the page is `/vaults/without-you`. On Base the same contract over
  Slipstream pools (`contracts/VerdexVaultsCL.sol`, `scripts/deploy-vaults-base.mjs`, `?chain=base`, USDC).
- **Agent without you.** `contracts/VerdexAgent.sol`: a budget and rules for the agent, kept by a contract. A
  mandate names the stocks, the rule (buy the dips, buy strength, take profits, cut losses, both ways) and its size,
  the USDG per trade, per day and in all, a cooldown per stock, a spot-less-1% floor, an expiry and a tip. The executor
  (same pass as the others, `runAgentOnce`) reads each stock's move on the day, or in the last hour, from the pools'
  market data and trades
  inside the limits from the owner's allowance; the contract refuses anything outside them (`check` returns the
  reason). Rules v2 (both ways, the hourly window, weekly caps as a multiple of the day cap) are encoded in the rule
  byte the contract stores and never reads; the weekly cap is kept by the executor from the Traded events of the last
  seven days. Deployed from `/deploy/agent` or `scripts/deploy-agent.mjs`; the page is `/agent/without-you`, and the
  Agent page drafts mandates into it.
- **Verdex in numbers.** `/numbers`: Index TVL from the index contracts valued at the pools, volume from the
  aggregator's record of swaps and bridges made through Verdex plus the Index routers' events, fees from the
  treasury contract, and every plan, fill, rebalance and trade from the four "without you" contracts, read by the
  browser with a link to every transaction (`src/lib/numbers.ts`). No analytics, nothing typed in.
- **Holders vote.** `contracts/VerdexVote.sol`: rounds of ranked votes on what ships next; a holder's VERDEX balance
  is their weight, read from the token when the page tallies (Borda count), never stored or snapshotted. The admin
  only opens rounds. Deployed with round 1 from `scripts/deploy-vote.mjs` (candidates in `scripts/vote-round-1.json`)
  or from `/deploy/vote`; the page is `/vote`.
- **Copy a wallet.** `/copy` (`src/lib/copy.ts`): reads the tokenized stocks any address holds on Robinhood Chain,
  values them at the pools and turns them into weights; Copy saves a vault on this device at those weights (funded
  on the Vaults page, leg by leg with floors), Keep opens Vaults without you with the weights filled in. No contract.
- **Phase 4.** `/holders` (VERDEX holders from the token's transfer history, `holders()` in `scripts/api-lib.mjs`);
  `/assets/:ticker` stock pages with daily candles (`/api/candles/<chain>/<pool>`, GeckoTerminal, paced and cached
  on the server); backtests (`src/lib/backtest.ts`); `/index/create` and `/index/community` over the open index
  factories; `contracts/VerdexGift.sol` with `/gift`, `/gift/claim` and the claim relay (`scripts/gift-relay.mjs`);
  `/share` cards drawn on a canvas; `/watchlist` alerts kept in the browser; `contracts/VerdexIndexPlans.sol` with
  `/index/auto-invest` and the executor's `runIndexPlansOnce`; `/league`.
- **Verdex API.** `scripts/api-lib.mjs`, served by `server.mjs` at `/api/*`: numbers, indexes (both chains), the
  without-you contracts and their executions, the treasury, the aggregator volume, the pools and the asset list, as
  JSON with a sixty-second cache and open CORS. The same reads the site makes, made by the server. `GET /api` lists them.
- **Verdex on Solana.** `/solana`: the same baskets made of xStocks (Backed's tokenized shares on Solana), bought and sold
  with USDC through Jupiter. No Verdex program: `src/lib/sol/tx.ts` asks Jupiter for each leg's route, composes one v0
  transaction per leg (the 0.25% USDC fee rides on the first one when `VITE_SOLANA_FEE_WALLET` is set), the wallet
  signs them all in one prompt (`src/lib/sol/wallet.ts`: Phantom, Solflare, Backpack, Wallet Standard) and the page
  sends them in order, polling for confirmation. The stocks land in the wallet as themselves. Tested with
  `simulateTransaction` against mainnet for a funded wallet, and end to end on the page with a mock wallet.
- **Verdex Lend.** `contracts/VerdexLend.sol` (v3): isolated money markets for tokenized stocks. Long markets lend USDG against
  a stock; short markets lend the stock against USDG. Supply and earn the interest; lock collateral and borrow. Prices from
  the pair's Uniswap v3 pool (lower collateral value of spot and a 30-minute average to borrow, higher to liquidate), hard
  caps, a 10% reserve of interest to the treasury. No function moves funds to the owner. Pricing never falls back to
  spot: if the pool's history is shorter than the window, the longest window it has is used down to half, and below
  that pricing refuses. Liquidations hand collateral over at the lower of spot and the average, floored at the
  average less the bonus; a position that runs out of collateral has its remaining debt written off against the
  reserves, then the suppliers. Deployed from `/deploy/lend`; the page is `/lend/verdex`. See `docs/audit-2026-10-05.md`.
- **Leverage.** `contracts/VerdexLeverage.sol` (v2): up to 1.9x long and 2x short on top of Lend. A long buys the stock with margin
  plus borrowed USDG in one swap and locks it; a short locks margin, borrows the stock and sells it in the same swap.
  Each wallet gets its own account contract, so each position is its own Lend position. Open interest capped per market.
  Deployed from `/deploy/leverage`; the page is `/leverage`.
- **Fees buy VERDEX.** `contracts/VerdexTreasury.sol`: where every protocol fee lands. The executor sweeps its USDG
  and ETH into VERDEX through an allowlisted router, the contract checks the result against a floor it reads from
  the pools, burns half and keeps half for the weekly payout to the wallets that paid the fees. No function sends
  funds anywhere else. Deployed from `/deploy/treasury`; the server runs the sweeps and payouts.
- **Private Markets.** The private companies with a token: pre-IPO exposure issued by PreStocks on
  Solana (Anthropic, OpenAI, Anduril, Neuralink, Kalshi, Polymarket, Figure AI), with price,
  liquidity, volume and holders from Jupiter and the transfer fee, pause switch and supply from each
  mint on Solana, read every minute. The companies that left (SpaceX listed, xAI's conversion
  closed), a check for replaced and refunded mints, and a link to trade on Jupiter. No Verdex
  contract and no Verdex fee.
- **$VERDEX page.** The token, read from the chain: market data, creator fees and sweeps, the dev
  wallet's holding, buys and burns, the bug bounty tiers, all live in the browser with a link to every
  transaction.
- **Baskets, Pools, Lend and Borrow.** Reserve index baskets and automated baskets, tokenized-stock
  liquidity pools, and Kamino lending markets for tokenized assets.
- **Portfolio.** Everything the connected wallet holds across the listed chains.
- **App.** Installable as a home-screen app (PWA) with a tab bar, offline shell, and reminders when a
  scheduled buy or a rebalance is due.

Holding any amount of VERDEX removes the 0.25% Verdex fee on every trade: swaps, bridges, private
swaps, Auto-Invest buys, order fills, vault rebalances and agent trades. Holding 0.5% of the supply
opens each new feature before its public date. Both are read from the token contract each time.

## Non-custodial by construction

Verdex never holds funds or keys. The site requests accounts only after the user clicks Connect, never
signs messages, and sends transactions only through the user's own wallet with `eth_sendTransaction`.
Plans and vaults are stored in the browser for the wallet that created them and are never uploaded.
See [SECURITY.md](SECURITY.md).

## Stack

- React 19, TypeScript, Vite 7
- MUI 7 (Emotion) for layout and theming, Motion for scroll reveals
- TanStack Query for data, viem for wallet transactions, EIP-6963 wallet discovery
- LI.FI API for quotes, token lists and chains, with bundled snapshots as fallback
- Geist and LT Remark web fonts

## Develop

```bash
npm install
npm run dev          # http://localhost:5173
npm run lint
npm run typecheck
npm run build        # typecheck + production build into dist/
npm run preview      # serve the production build
npm run build:preview  # relative base + hash routing, for static hosts without rewrites
```

Node 22. Copy `.env.example` to `.env` for the optional variables:

| Variable | Purpose |
| --- | --- |
| `VITE_LIFI_API_KEY` | Lifts the public LI.FI rate limit. Sent as `x-lifi-api-key` on every LI.FI request. |
| `VITE_VERDEX_FEE` | Verdex fee for wallets that hold no VERDEX, on every trade, as a fraction. Default `0.0025`. Collected by LI.FI for the `verdex` integrator; when that integrator has no fee wallet configured the route rejects it and the trade goes through without it. |

### Data and logos

Chains, tools and token lists come from LI.FI at runtime with snapshots in `public/api` as fallback.
Assets, baskets, pools and lending markets ship as snapshots in `public/api` and `public/data`. Every
remote logo the data references is mirrored in `public/img/logos` as 96px WebP and listed in
`src/data/logos.json`, so the site does not depend on third-party image hosts. The preview build packs
them into one JSON file (`scripts/pack-logos.mjs`).

### Promo material

`promo/` holds the launch films and tweet copy. Timelines are plain HTML pages that paint any second
on demand; `promo/render.mjs` renders them frame by frame with Playwright and encodes with ffmpeg.
`promo/showcase.mjs` and `promo/phone.mjs` record the real site, desktop and phone, with a mock wallet.
Details in [promo/README.md](promo/README.md).

## Layout

```
src/
  landing/     Hero, feature sections, token card, swap intro
  swap/        Swap widget and token picker (LI.FI quotes, viem execution)
  pages/       App routes: markets, issuers, baskets, discover, pools, lend, portfolio, auto-invest, vaults, strategies, orders, agent, docs
  components/  Nav, tab bar, footer, icons, motion helpers, wallet provider, install sheet, due reminders
  lib/         Data hooks, LI.FI client, Auto-Invest, Vaults, Strategies, Orders and Agent engines, PWA helpers, image resolver
  theme/       Design tokens, MUI theme, shared style objects
  data/        Docs content, logo manifest
public/
  api/, data/  Data snapshots
  logos/, img/ Chain, tool, issuer and token artwork
  icons/       App icons; manifest.webmanifest and sw.js for the installable app
promo/         Films, clips, recorders, tweet copy
scripts/       Logo packing, app icons, public release
```

## Deploy

`railway.json` builds with Railpack (`npm run build`) and serves `dist` with the `index.html` fallback
that client-side routes need. Any static host works the same way: build, serve `dist`, rewrite unknown
paths to `index.html`.

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first; it covers the
setup, the layout, and the rules that keep the site non-custodial. CI runs lint, typecheck and build.

## License

The source code is released under the [MIT License](LICENSE).

Third-party material is not covered by that license and stays under its owners' terms: the typefaces in
`src/fonts`, the chain, protocol, issuer and token artwork in `public/logos` and `public/img`, and the
market data snapshots in `public/api` and `public/data`. Replace them with assets you hold rights to
before shipping a fork commercially.
