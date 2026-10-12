import type { ReactNode } from 'react'
import { BRAND } from '../theme/tokens'

const N = BRAND.name
export type DocBlock =
  | { kind: 'p'; text: ReactNode }
  | { kind: 'defs'; items: { term: string; text: ReactNode }[] }
  | { kind: 'steps'; items: { title: string; text: string }[] }
  | { kind: 'fees'; items: { term: string; text: string }[] }
  | { kind: 'issuers' }
  | { kind: 'chains' }
  | { kind: 'faq'; items: { q: string; a: string }[] }
export type DocSection = { id: string; title: string; blocks: DocBlock[]; sub?: boolean }

export const DOC_SECTIONS: DocSection[] = [
  {
    id: 'overview',
    title: 'Overview',
    blocks: [
      { kind: 'p', text: `${N} is the unified marketplace for real-world assets. Stock tokens from Ondo, xStocks, Robinhood, Coinbase and bStocks trade in one place, alone or as whole baskets. Every swap and bridge is priced across bridges, exchanges and intent solvers, and you sign from your own address.` },
      { kind: 'p', text: `${N} never holds your funds. Transfers go from your own address through audited routing contracts to the destination address you choose.` },
      { kind: 'p', text: 'Tokenized Baskets are live: index baskets you hold as one token, and strategy baskets you hold stock by stock. Tokenized Pools lists the liquidity pools of tokenized stocks across chains, and Verdex Pools lets you provide liquidity to the ones on Robinhood Chain from your wallet. Lend and Borrow lets you earn on tokenized stocks, borrow against them, or hold more of one with Multiply.' },
    ],
  },
  {
    id: 'swap-and-bridge',
    title: 'Swap and Bridge',
    blocks: [
      { kind: 'defs', items: [{ term: 'Swap', text: 'Same chain. Trade one token for another on a single chain, e.g. USDC → EURC on Arc.' }, { term: 'Bridge', text: 'Across chains. Move an asset from one chain to another, swapping on the way if needed, e.g. ETH on Base → USDC on Arc.' }] },
      { kind: 'p', text: 'The Swap tab keeps both sides on the same chain. The Bridge tab lets you pick any source and any destination chain.' },
    ],
  },
  {
    id: 'how-a-transfer-works',
    title: 'How a transfer works',
    sub: true,
    blocks: [
      { kind: 'steps', items: [
        { title: 'Choose what to send and receive', text: 'Pick the token and chain on each side and enter an amount.' },
        { title: 'Compare routes', text: `${N} lists every available route, labelled Best Return and Fastest. Tap any route to select it. Quotes refresh about every minute.` },
        { title: 'Review and sign', text: 'Review shows the minimum you will receive, fees and estimated time. Some tokens need a one-time approval before the transfer.' },
        { title: 'Watch it settle', text: 'The route overlay shows each step as it happens: approval, send, bridge and receive, with explorer links for each transaction.' },
      ] },
    ],
  },
  {
    id: 'tokenized-baskets',
    title: 'Tokenized Baskets',
    blocks: [
      { kind: 'p', text: `A basket is a set of tokenized stocks (or other assets) at stated weights. ${N} aggregates baskets from different sources and shows them in one place, with one way to buy and sell each kind. There are three kinds.` },
      { kind: 'defs', items: [
        { term: 'Index baskets', text: 'One token per basket. The token is backed by the assets inside and can be redeemed for them. You buy one token and hold one token.' },
        { term: 'Automated baskets', text: 'A portfolio in your own account, bought for you and rebalanced to its target weights on a schedule. You add or withdraw at any time.' },
        { term: 'Strategy baskets', text: 'A list of stocks and weights. There is no basket token: you buy each stock token yourself in one order, and you hold each of them.' },
      ] },
      { kind: 'p', text: `${N} never holds your funds in any of them. Every purchase is signed by you and the tokens arrive at your own address.` },
    ],
  },
  {
    id: 'index-baskets',
    title: 'Index baskets',
    sub: true,
    blocks: [
      { kind: 'p', text: 'Index baskets are issued through Reserve. Each basket is a single ERC-20 token, backed one to one by the tokens inside it at published weights. Minting and redeeming are open onchain calls, so the token can always be exchanged for the assets inside. The Tokenized Baskets page shows the baskets that hold tokenized stocks; Discover lists every active index basket with search and a chain filter.' },
      { kind: 'steps', items: [
        { title: 'Open a basket', text: 'The basket page shows price, the year-to-date change, a chart, the holdings with their weights, fees, holders, recent mints and redeems, and the disclosures.' },
        { title: 'Choose what to pay with', text: 'Ethereum: USDC, ETH or WETH. BNB Chain: USDT or USDC. Base: USDC, ETH or WETH.' },
        { title: 'Enter an amount', text: `${N} asks every source the basket trades through and uses the one that gives you the most. The card shows the basket tokens you will receive; Details shows the price, the projected slippage, the minimum you will receive at your slippage setting (0.1%, 0.5% or 1%) and every source’s quote, and you can pick a different one.` },
        { title: 'Approve and buy', text: 'A token needs a one-time approval. Then either one transaction mints or buys the basket token to your address, or, when the best quote is CoW Swap or PancakeSwap X, you sign an order and a market maker fills it within a few minutes. An order that is not filled expires and nothing is spent.' },
        { title: 'Sell', text: 'The arrows on the card switch to selling. The basket token goes back into the token you choose, through the source with the best quote.' },
      ] },
      { kind: 'defs', items: [
        { term: 'Exposure and Collateral', text: 'The holdings table has two views. Exposure shows the company or asset you are exposed to. Collateral shows the token actually held, its issuer and that token’s own market cap.' },
        { term: 'Backing', text: 'Stock baskets show “100% backed by real stocks” with the issuer of the stock tokens named. How each stock token is backed is described by its issuer on the basket page.' },
        { term: 'Chart before launch', text: 'Before a basket’s launch date the line is an estimate: the launch-day basket priced with the stocks’ history, without fees or rebalances.' },
        { term: 'Market hours', text: 'Baskets that hold Ondo stock tokens show the US market session. Outside market hours prices can move less and cost more to trade.' },
        { term: 'Where quotes come from', text: 'Reserve’s own minting, two aggregators, and two order venues, CoW Swap and PancakeSwap X. The basket’s mint fee applies when Reserve mints the basket; the other sources trade existing basket tokens.' },
        { term: 'Quotes and VPNs', text: 'Quotes come straight from each source to your browser. Some refuse VPN and proxy connections; if you see that message, turn the VPN off and try again.' },
      ] },
    ],
  },
  {
    id: 'automated-baskets',
    title: 'Automated baskets',
    sub: true,
    blocks: [
      { kind: 'p', text: 'Automated baskets are ready-made portfolios that keep themselves on target: stocks by theme, the trades of well-known investors, crypto, gold and yield. Each one is held in your own account and rebalanced to its target weights on a schedule, so you never have to trade the holdings yourself. Baskets trade on BNB Chain, Base, Ethereum, Arbitrum and Robinhood Chain.' },
      { kind: 'steps', items: [
        { title: 'Pick a basket', text: 'Filter by group and open a basket to see its holdings, weights, performance, total invested and how often it rebalances.' },
        { title: 'Open your account', text: 'One signature opens your own account for that basket. It costs no gas, and only you can withdraw from it.' },
        { title: 'Invest', text: 'Send USDT on BNB Chain, USDC on Base, Ethereum or Arbitrum, or USDG on Robinhood Chain. The holdings are bought as soon as the funds arrive.' },
        { title: 'Let it rebalance', text: 'The basket returns to its target weights on its schedule, daily for most baskets. You can pause and resume rebalancing at any time.' },
        { title: 'Withdraw', text: 'One signature sells every holding and sends the proceeds to your own address in the same stablecoin.' },
      ] },
      { kind: 'defs', items: [
        { term: 'What you hold', text: 'The basket’s holdings, in an account that belongs to your address. Your Profile shows each basket you hold and its value.' },
        { term: 'Rebalancing', text: 'Automatic, to the target weights. When a basket’s weights are updated, your account follows them at its next rebalance.' },
        { term: 'Fee', text: '0.50% per swap, taken on every swap made for your account, rebalances included.' },
        { term: 'Tokenized stocks', text: 'Sold during US market hours (Mon to Fri, 9:30 to 16:00 New York). A withdrawal sent outside those hours may need to be sent again.' },
        { term: 'Returns shown', text: 'The basket’s own history at its target weights, before fees. It is not a forecast.' },
      ] },
    ],
  },
  {
    id: 'strategy-baskets',
    title: 'Strategy baskets',
    sub: true,
    blocks: [
      { kind: 'p', text: 'Strategy baskets are themed stock portfolios: investor trackers, AI and chips, energy and resources, and sectors. Each one is a list of stocks with target weights and a one-year return. Most are bought on BNB Chain with stock tokens from Ondo; one is on Robinhood Chain with stock tokens from Robinhood.' },
      { kind: 'steps', items: [
        { title: 'Pick a basket', text: 'Filter by category and open a basket to see what it holds, the weights, and the buy and sell card.' },
        { title: 'Set the weights', text: 'Target weights uses the basket’s own weights. Equal weight gives every stock the same share. Or move the slider of any stock; a stock at 0% is left out. If the weights do not add to 100%, the order is split in proportion.' },
        { title: 'Enter an amount', text: 'You pay with USDT on BNB Chain or USDG on Robinhood Chain. The order is split by the weights and every stock gets its own live quote. A stock with no route at that moment is marked and left out.' },
        { title: 'Buy', text: 'One approval for the pay token, then one swap per stock, each confirmed by you. The card shows every stock as it goes through, with a link to the transaction. If one swap fails, the others still continue.' },
        { title: 'Sell', text: 'Choose 25%, 50% or 100%. That share of each stock you hold from the basket is swapped back to the pay token, one swap per stock.' },
      ] },
      { kind: 'defs', items: [
        { term: 'What you hold', text: 'The stock tokens themselves, each one separately. You can sell any of them on its own at any time, here or on Swap and Bridge.' },
        { term: 'Rebalancing', text: 'None. The weights are the basket’s target weights on the day you buy; your holdings then move with the stocks.' },
        { term: 'Slippage', text: '0.5%, 1% or 2% per swap. A swap whose price moves past it reverts and that stock is marked as failed.' },
        { term: 'Returns shown', text: 'The one-year return is the basket’s own history at its target weights. It is not a forecast.' },
      ] },
    ],
  },
  {
    id: 'issuers-and-chains',
    title: 'Issuers and chains',
    sub: true,
    blocks: [
      { kind: 'p', text: `Every asset on ${N} is a token from a third-party issuer: stocks and ETFs, gold, private credit and treasuries. How each token is backed is set out by its issuer.` },
      { kind: 'issuers' },
      { kind: 'p', text: 'Issuers decide who may hold their tokens. Tokenized stocks are generally not available to residents of the United States and of sanctioned countries. Each basket page carries the issuer’s own description and risk list.' },
    ],
  },
  {
    id: 'private-markets',
    title: 'Private Markets',
    blocks: [
      { kind: 'p', text: `Private Markets lists the private companies that have a token: pre-IPO exposure issued by PreStocks on Solana, one Token-2022 mint per company, priced where it trades. ${N} reads the price, the liquidity, the day’s volume and the holder count from Jupiter, and the transfer fee, the pause switch and the supply from each mint on Solana, every minute, in the browser. ${N} adds no contract and takes no fee; the trade happens on Jupiter, in your own Solana wallet.` },
      { kind: 'defs', items: [
        { term: 'What the token is', text: 'The issuer takes exposure to a private company’s shares through vehicles that hold them and issues a token against it. Holding the token is a claim on that exposure under the issuer’s terms: no shares in your name, no vote, no dividend. The issuer’s terms exclude U.S. persons. If the issuer fails, the token fails with it, whatever the company does.' },
        { term: 'The price', text: 'The last trade in the mint’s pools on Meteora and Raydium, reached through Jupiter. It is not the company’s last funding round and it moves with every buy and sell. Liquidity is how much sits in those pools; it tells you how far a trade would move the price.' },
        { term: 'Transfer fee', text: 'Every mint carries a Token-2022 transfer fee, taken on every transfer, the buy included. The issuer can change it with an epoch’s notice; the page shows the fee in force and any scheduled change, read from the mint.' },
        { term: 'Pause and delegate', text: 'The issuer holds a pause switch that stops every transfer of a mint, and a permanent delegate that can move or burn tokens from any account. Both are part of how it converts and refunds. The page shows whether transfers are open.' },
        { term: 'How it ends', text: 'When a company lists or is bought, the issuer converts, redeems or refunds the token under its terms. SpaceX listed in June 2026 and its public stock trades tokenized as SPCX in Markets; xAI’s token had a conversion window that closed on 12 September 2026. Both are kept on the page with what is left in their pools.' },
        { term: 'Replaced and refunded mints', text: `The issuer has retired more than twenty earlier mints, renamed OUTDATED or REFUNDED onchain. They still carry the PreStocks name and still get pasted into swap boxes. Only the mints on the page trade today; the check at the bottom tells you what any other mint is, by ${N}’s list first and by Jupiter’s name for the rest.` },
        { term: 'Fees', text: `No ${N} fee. You pay the mint’s transfer fee on the buy and on every later transfer, the pool fee, and Jupiter’s own terms.` },
      ] },
    ],
  },
  {
    id: 'tokenized-pools',
    title: 'Tokenized Pools',
    blocks: [
      { kind: 'p', text: 'Tokenized Pools lists the liquidity pools where tokenized stocks trade: 199 Uniswap v4 pools on Robinhood Chain and Base. Every one of them can be deposited into from here.' },
      { kind: 'defs', items: [
        { term: 'Liquidity', text: 'The dollar value of both tokens in the pool.' },
        { term: '24h volume', text: 'The dollar value traded in the pool over the last 24 hours.' },
        { term: 'Fee', text: 'The pool’s own fee tier, paid by traders to liquidity providers.' },
        { term: 'Fee APR', text: 'One day of fees at the current volume, times 365, divided by liquidity. Shown only where the pool states a fee tier. It changes with volume and is not a promise.' },
        { term: 'Adding liquidity', text: 'Open a pool and choose Add Liquidity. Set a price range and the amounts, approve each token once, and one transaction adds the position to your address. It earns the pool’s fee while the price is inside your range.' },
      ] },
    ],
  },
  {
    id: 'verdex-pools',
    title: 'Verdex Pools',
    blocks: [
      { kind: 'p', text: `Verdex Pools is where you provide that liquidity. It reads every Uniswap v3 pool of a tokenized stock on Robinhood Chain from the factory, against USDG and ETH at every fee tier, and lets you open, top up, collect from and close positions from ${N}, signed in your own wallet. ${N} adds no contract and takes no fee on it.` },
      { kind: 'defs', items: [
        { term: 'Where the numbers come from', text: 'The pool list, the price and the tick from the chain, refreshed every minute. Liquidity and volume in dollars from DexScreener. Fee APR is one day of the pool fee at the current volume, times 365, divided by the liquidity: a snapshot, not a forecast.' },
        { term: 'Range', text: 'Presets of ±2%, ±5%, ±10% and ±25% around the current price, full range, or your own bounds. A tighter range earns a larger share of the fees while the price is inside and stops earning when it leaves; a full-range position always earns, but less.' },
        { term: 'Amounts', text: 'Type one side and the other follows from the range and the price. Outside the range only one token is needed. The minimums sent with the transaction allow 0.5% of movement; the deadline is 20 minutes.' },
        { term: 'The transaction', text: 'One approval per token the first time, then one call to the Uniswap v3 position manager. ETH is sent as ETH and wrapped inside the call, with any excess refunded in the same transaction. The position is an NFT held by your address.' },
        { term: 'Your positions', text: 'Every position your address holds in these pools, with the amounts it represents at the current price, whether the price is inside its range, and the fees it has earned but not yet collected. Collect pays the fees out; Remove takes out a share and the fees together, and closing the position burns the NFT.' },
        { term: 'Impermanent loss', text: 'A position is a bet the price stays inside the range. If the stock rises past the top you hold only the quote token; if it falls below the bottom you hold only the stock. The fees are the compensation for taking that side of every trade.' },
      ] },
    ],
  },
  {
    id: 'asset-yield',
    title: 'Asset Yield',
    blocks: [
      { kind: 'p', text: `Asset Yield puts what sits idle in your wallet on Robinhood Chain to work, through public contracts only. A tokenized stock goes into a one-sided Uniswap v3 band just above its price, where it earns the pool fee on every trade that reaches the band and is sold only if the price climbs through it. USDG goes into Spark Savings USDG, an ERC-4626 vault that accrues the Spark rate every second. ${N} adds no contract and takes no fee on either.` },
      { kind: 'defs', items: [
        { term: 'What is idle', text: 'When you connect, the page reads the balance of every tokenized stock the site lists on Robinhood Chain and your USDG, and for each stock picks the pool it would work in: a USDG pool with at least $1,000 of liquidity and the highest fee APR, or failing that the deepest pool of any quote.' },
        { term: 'The band', text: 'Presets of +2%, +5% and +10% above the current price, aligned to the pool’s tick spacing. The position holds only the stock, so nothing else is deposited and the shares stay yours while the price is below the band. Inside the band they earn the pool fee; through the top they have been sold at about the geometric mean of the two edges, which the page shows before you sign.' },
        { term: 'Stocks: the transaction', text: 'One approval of the stock token the first time, then one call to the Uniswap v3 position manager. The position is an NFT in your wallet and also appears on the Verdex Pools page and in the Uniswap app. Stop closes it and returns whatever it holds, stock or quote, plus the fees.' },
        { term: 'Cash: Spark Savings USDG', text: 'Deposit sends USDG to the vault and you receive spUSDG, whose value in USDG grows at the per-second rate the vault reports. The page compounds that rate over a year to show the APY. Withdraw redeems a share of your spUSDG back to USDG in the same wallet, with no lock and no exit fee. The vault has a deposit cap set by Spark.' },
        { term: 'Working now', text: 'Every position your address holds in these pools, labelled Earning when the price is inside its band, Waiting when it holds only the stock below the band, and Sold when the price has gone through and it holds the quote. Your Spark balance is listed with them.' },
        { term: 'Risks', text: 'A band is a sale you agreed to: if the stock rises through it you no longer hold the stock. Fee APR is today’s figure at today’s volume. The Spark vault is a contract run and audited by Spark; its rate moves when Spark moves it, and a deposit is exposed to that contract. There is no insurance on any of it.' },
      ] },
    ],
  },
  {
    id: 'launchpad',
    title: 'Launchpad',
    blocks: [
      { kind: 'p', text: `The Launchpad lets anyone launch a token on Robinhood Chain from ${N}, through the Pons V2 contracts that created VERDEX: the launch factory, its launch-and-buy router and the hook that charges fees in the pool. A launch mints a fixed supply of 1,000,000,000, opens a bonding curve quoted in ETH, USDG or one of the tokenized stocks the factory accepts, and graduates by itself into a Uniswap v4 pool with locked liquidity once the curve has raised its threshold. ${N} adds no contract and takes no fee; the launch fee and the curve fee are Pons's, read from the factory as you look.` },
      { kind: 'defs', items: [
        { term: 'What you choose', text: 'A name, a symbol, a logo link and a description, an X link and a website if you have them, the asset the token is priced in, your creator fee up to the factory’s maximum, and your first buy. The first buy lands in the same transaction as the launch, before anyone else can trade, and is exempt from the snipe tax.' },
        { term: 'The transaction', text: 'One call to the Pons router, after one approval when the quote is an ERC-20. The value sent is the launch fee plus the first buy for an ETH launch, or the launch fee alone otherwise. The page reads the factory’s economics digest just before and pins it into the call, so a change of terms by Pons in between makes the launch revert instead of repricing it.' },
        { term: 'Snipe tax', text: 'For the first seconds after a launch the curve taxes buys at a rate that starts near 99% and decays to zero, so bots cannot front-run a creator’s own first buy. The creator’s first buy and the addresses they list are exempt.' },
        { term: 'Graduation', text: 'Each quote asset has a threshold set by Pons. When the curve has raised it, the factory moves the raised quote and the reserved tokens into a Uniswap v4 pool behind the Pons hook and locks the liquidity position. From then on the token trades in the pool.' },
        { term: 'Creator fee', text: 'Your fee in basis points, charged by Pons on every trade, on the curve and in the pool after graduation, and paid to your wallet in the quote asset. VERDEX runs at 2%; its sweeps are listed on its page with every transaction.' },
        { term: 'The feed', text: 'The newest launches on the factory, whoever made them, with the quote, the curve’s progress, the age and the creator address, read from the factory’s events and the curve contracts. Most launches are memecoins and most never graduate. The list is what the chain says, not a recommendation.' },
      ] },
    ],
  },
  {
    id: 'lend-and-borrow',
    title: 'Lend and Borrow',
    blocks: [
      { kind: 'p', text: 'Lend and Borrow (Beta) runs on Kamino, a lending protocol on Solana, in the markets that hold tokenized stocks: xStocks Market, STRCx Market and Sentora xStocks Market. Earn on a stock token, borrow against it, or hold more of it with Multiply. You need a Solana address; the first supply opens your position on Kamino.' },
      { kind: 'defs', items: [
        { term: 'Supply', text: 'Lend a token to a market and earn its supply rate. It stays yours, and everything you supply in one market counts together as collateral there.' },
        { term: 'Borrow', text: 'Borrow against what you supplied in the same market, at that token’s borrow rate. The card shows your loan to value before and after.' },
        { term: 'Withdraw and Repay', text: 'At any time, one transaction each. A withdrawal comes from what is not lent out, so when nearly all of a token is borrowed it waits for repayments or new supply.' },
        { term: 'Multiply', text: 'Hold more of a stock token than you deposit, up to the pair’s maximum leverage. One transaction borrows, swaps and deposits; if any step fails, none of it happens. Closing reverses it and returns the rest to you.' },
        { term: 'Rates', text: 'Supply and borrow rates move with how much of each token is borrowed. Kamino stops new borrowing from a token when it is heavily borrowed; positions can still be repaid and closed.' },
        { term: 'Liquidation', text: 'If what you owe reaches the liquidation loan to value of your collateral, Kamino sells part of the collateral to repay it, at a penalty.' },
        { term: 'Multiply gains and losses', text: 'Both are larger by the leverage you choose. When the borrow rate is above what the stock token earns, holding the position costs money.' },
        { term: 'Fees', text: `No ${N} fee. You pay Kamino’s borrow rate on what you borrow.` },
      ] },
    ],
  },
  {
    id: 'auto-invest',
    title: 'Auto-Invest',
    blocks: [
      { kind: 'p', text: `A recurring buy of one listed asset: the amount, the cadence (daily, weekly, every two weeks, monthly) and the stablecoin to pay with. Plans are stored in your browser for the wallet that made them; nothing is deposited anywhere.` },
      { kind: 'steps', items: [
        { title: 'Set it up', text: 'Pick the asset and its version (issuer and chain), the amount in dollars, the cadence and the pay token. The first buy can run right away or wait for the first scheduled date.' },
        { title: 'On its day', text: `${N} reminds you, prices the buy through the aggregator, approves the pay token once if needed, and asks your wallet to confirm the swap. Nothing moves before that confirmation.` },
        { title: 'Pause or remove', text: 'A plan is a note on your device. Pause it, change it or remove it at any time; the history of buys and their transactions stays with it.' },
      ] },
    ],
  },
  {
    id: 'auto-invest-without-you',
    title: 'Auto-Invest without you',
    blocks: [
      { kind: 'p', text: `Auto-Invest without you is a recurring buy of a tokenized stock on Robinhood Chain that runs while your wallet is closed. It is the one ${N} contract: short, open source, verified on the explorer, and unaudited. You approve an exact USDG allowance and create a plan: the stock, the amount per buy, the cadence, how many buys, and the first run. When a buy is due, an executor calls the contract, which pulls one buy's worth from your allowance, swaps it in the stock's USDG pool on Uniswap v3, sends the stock to your wallet and a tip of a few cents to the executor. ${N} takes no fee.` },
      { kind: 'defs', items: [
        { term: 'The allowance', text: 'Exact, never unlimited: the buys you asked for plus their tips, or a year of buys for an open-ended plan. It is the most the contract can ever pull. Cut it to zero from the page or from any wallet and every plan stops at once.' },
        { term: 'The price floor', text: 'Each buy must return at least the pool’s spot price less the plan’s slippage, read from the pool in the same transaction. If the pool is thin or moved, the buy waits for the next run instead of filling badly. The pool must hold at least $25k of liquidity when the plan is made.' },
        { term: 'Who runs it', text: `An executor on the contract’s list, or you. ${N} runs an executor every ten minutes from the same server that serves this site, with a wallet that holds a little ETH for gas and nothing else; its address is on the contract. The list exists so that the price floor cannot be gamed by an arbitrary caller; the admin can add or remove executors and nothing else.` },
        { term: 'Nothing held', text: 'Tokens pass through the contract inside one transaction. Between buys it holds no balance of yours, and no admin can move a plan, change it, pause it or touch your allowance.' },
        { term: 'Pause, resume, cancel', text: 'From the page, one transaction each. A cancelled plan never runs again. A finished plan has made every buy it was asked for.' },
        { term: 'Missed buys', text: 'If a buy cannot run (balance or allowance short, pool too far from spot) the plan simply waits. When it runs again the next buy is one interval later; missed buys do not pile up.' },
        { term: 'On Base', text: 'The same contract runs on Base (contracts/VerdexAutoInvestCL.sol) over Aerodrome Slipstream pools, in Coinbase’s tokenized stocks and USDC: pools are found by tick spacing instead of fee tier; the allowance, the floor and the pull at buy time are the same code. Switch chains at the top of the page; the executor runs both on the same ten-minute pass, tipped in USDC there.' },
        { term: 'Risk', text: `The contract is unaudited. It is about two hundred lines, tested on a fork of Robinhood Chain, with the source and compiled bytecode in the repository. Read it before you trust it with more than you would lose.` },
      ] },
    ],
  },
  {
    id: 'orders-without-you',
    title: 'Orders without you',
    blocks: [
      { kind: 'p', text: `Orders without you are limit and stop orders that live in a contract on Robinhood Chain (contracts/VerdexOrders.sol) and fill while your wallet is closed. An order names a stock, a side, an amount and a price level; the level is stored as the stock's Uniswap v3 pool's own price. ${N}'s executor, the same one that runs Auto-Invest, checks every open order every ten minutes; when the pool is at or past the level it fills the order: one swap in that pool, the proceeds to your wallet, a few cents of USDG to the executor. You can fill a triggered order yourself at any time. The contract holds nothing between orders and takes no fee.` },
      { kind: 'defs', items: [
        { term: 'Four kinds', text: 'Buy below (a limit buy), Stop, sell below (a stop loss), Sell above (a take profit) and Buy above (a breakout). All four are the same contract call with a level and a direction.' },
        { term: 'The allowance', text: 'You approve exactly what the order may pull: the USDG of a buy plus the tip, or the shares of a sell. Never unlimited. Revoking it ends every order at once. An order whose allowance or balance is short simply waits.' },
        { term: 'Two prices at fill time', text: 'Your level decides when the order may fill. The pool\'s spot price less 1%, read in the same transaction, decides the least you accept. Both come from the pool itself, so a manipulated pool makes the fill wait rather than fill badly.' },
        { term: 'Expiry', text: 'An order can be good until you cancel it, or for a day, a week or a month. After that it can no longer fill and shows as expired.' },
        { term: 'Who fills', text: `Allowed executors and the order’s owner. The executor list is the only thing the contract’s admin can change; no admin can touch an order or move anyone’s tokens.` },
        { term: 'On Base', text: 'The same contract runs on Base (contracts/VerdexOrdersCL.sol) over Aerodrome Slipstream pools, in Coinbase’s tokenized stocks and USDC: pools are found by tick spacing instead of fee tier and the callback keeps the Uniswap v3 name; the floor, the pull at fill time and the allowances are the same code. Switch chains at the top of the page; the executor runs both on the same ten-minute pass, tipped in USDC there.' },
        { term: 'Risk', text: 'The contract is unaudited. It is about two hundred lines, holds no balance, and the source and compiled bytecode are in the repository, tested on a fork of Robinhood Chain. Read it before you trust it with more than you would lose. Orders on this device (the Orders page) remain available and never leave your browser.' },
      ] },
    ],
  },
  {
    id: 'vaults-without-you',
    title: 'Vaults without you',
    blocks: [
      { kind: 'p', text: `Vaults without you are target weights over tokenized stocks on Robinhood Chain kept by a contract (contracts/VerdexVaults.sol) while your wallet is closed. A vault names the stocks, their target weights, a drift threshold and the least time between runs. ${N}'s executor values your holdings at the stocks' Uniswap v3 pool prices every ten minutes; when any weight is further from its target than the threshold and the interval has passed, it runs the vault: inside one transaction the contract pulls the overweight stocks from your allowances, sells them for USDG in their pools, takes a ten-cent tip, buys the underweight stocks with the proceeds and sends everything to your wallet. It holds nothing between runs and takes no fee.` },
      { kind: 'defs', items: [
        { term: 'Allowances', text: 'For each stock you approve the contract for exactly what you hold: the most a rebalance can ever sell of it. When you buy more of a stock, approve it again from the vault card. Revoking the allowances ends the vault for good.' },
        { term: 'The threshold and the interval', text: 'A rebalance runs only when both hold: some weight is at least the threshold away from its target (2%, 5% or 10%), and the interval since the last run has passed (a day, a week or a month at least). Small vaults rebalance rarely; legs under one USDG are skipped.' },
        { term: 'Floors', text: 'Every sale and every purchase must return at least the pool’s spot price less 1%, read in the same transaction. A pool that has moved makes the whole run revert, not fill badly. Weights are valued at the same spot prices.' },
        { term: 'Who runs it', text: 'Allowed executors and the vault’s owner. The executor list is the only thing the admin can change; no admin can touch a vault or move anyone’s tokens.' },
        { term: 'On Base', text: 'The same contract runs on Base (contracts/VerdexVaultsCL.sol) over Aerodrome Slipstream pools: the legs are Coinbase’s tokenized stocks, valued and rebalanced in USDC, found by tick spacing instead of fee tier. Allowances, floors and the one-transaction rebalance are the same code. Switch chains at the top of the page; the executor checks both chains on the same pass.' },
        { term: 'Risk', text: 'The contract is unaudited. Weights are read from spot prices, so a pool pushed far from its market price for a moment could trigger a run that trades at that price; the floors limit each leg to spot less 1% and the interval limits how often it can happen. The source and compiled bytecode are in the repository, tested on a fork of Robinhood Chain. Vaults on this device (the Vaults page) remain available and never leave your browser.' },
      ] },
    ],
  },
  {
    id: 'agent-without-you',
    title: 'Agent without you',
    blocks: [
      { kind: 'p', text: `Agent without you is a budget and rules for the agent, kept by a contract on Robinhood Chain (contracts/VerdexAgent.sol) while your wallet is closed. A mandate names the tokenized stocks the agent may trade, the rule it follows, how much USDG it may spend per trade, per day and in all, the least time between two trades on the same stock, a price floor, an expiry and a tip. ${N}'s executor reads each stock's move on the day every ten minutes and applies the rule; when it fires, it calls the contract, which pulls the amount from your allowance, swaps it in the stock's Uniswap v3 pool against USDG, sends the proceeds to you and the tip to the executor. It holds nothing between trades and takes no fee.` },
      { kind: 'defs', items: [
        { term: 'The rules', text: 'Five, each with a size: buy the dips (a stock is that far down: buy a trade of it), buy strength (that far up: buy), take profits (that far up: sell a slice of what you hold), cut losses (that far down: sell), and both ways (down: buy, up: sell, in one mandate). The move is measured on the day or, since rules v2, in the last hour; the executor reads it from the pools’ market data every ten minutes and applies the rule to each stock in the mandate.' },
        { term: 'Rules v2', text: 'Both ways, the hourly window and weekly caps live in the same byte the contract already stores for the rule and never reads, so no new contract and no new allowance: a both-ways mandate approves USDG for its budget and each stock for what you hold; the weekly cap is a multiple of the day cap (2x, 3x or 5x) that the executor keeps from the contract’s own trade events of the last seven days, on top of the day cap the contract enforces.' },
        { term: 'The limits', text: 'Per trade (a buy’s USDG, a sale’s value at spot), per day (buys and sales together, over a rolling day from the mandate’s creation), the budget (USDG for buys, in all; top it up from the card), the cooldown (one trade per stock per cooldown at least), the expiry, and a floor of spot less 1% on every trade, read in the same transaction. The contract checks all of them in `check` and `execute` and refuses the rest. Trades under one USDG are refused too.' },
        { term: 'Allowances', text: 'A buy mandate approves USDG for exactly its budget plus a tip per trade the budget allows. A sell mandate approves each stock for what you hold. Revoking the allowances ends the mandate for good; closing it does the same from the contract side.' },
        { term: 'Who runs it', text: 'Allowed executors and the mandate’s owner. The executor list is the only thing the admin can change; no admin can touch a mandate or move anyone’s tokens.' },
        { term: 'What the contract does not check', text: 'The timing. Whether a stock really moved that much on the day is the executor’s reading of the market data, not proven onchain. The worst a rogue executor could do is trade inside your limits, at spot less your floor, as often as the cooldown and the caps allow. Keep the caps at what you would hand a stranger with those rules.' },
        { term: 'Risk', text: 'The contract is unaudited. The floors come from the pools’ spot prices, so a pool pushed far from its market price for a moment could fill a trade at that price, bounded by the per-trade cap. The source and compiled bytecode are in the repository, tested on a fork of Robinhood Chain. The Agent page remains available and proposes without ever trading on its own.' },
      ] },
    ],
  },
  {
    id: 'verdex-in-numbers',
    title: 'Verdex in numbers',
    blocks: [
      { kind: 'p', text: `The Numbers page (/numbers) is what the contracts hold and have done, read from the chain by your browser when you open it, each number with the transactions behind it. Nothing on it is typed in by ${N}: a figure you cannot click through to a transaction or a contract is not on the page.` },
      { kind: 'defs', items: [
        { term: 'Index TVL', text: 'The stocks the index contracts hold, on Robinhood Chain and on Base, valued at the pools’ spot prices at the moment you load the page, index by index.' },
        { term: 'Volume', text: `Two sources. Swaps and bridges made through ${N} come from the aggregator’s public record for the integrator name, the last 89 days, with a link to each transaction. Index buys and sells come from the routers’ own events on both chains.` },
        { term: 'Fees', text: 'From the treasury contract: VERDEX bought, burned and paid back in all, sweep by sweep and payout by payout, the same figures the Treasury page shows.' },
        { term: 'Without you', text: 'From the four contracts: how many plans, orders, vaults and mandates exist, and every buy, fill, rebalance and trade the executor or an owner has run, from the contracts’ events over the last four weeks.' },
        { term: 'What it is not', text: 'Not a dashboard of users, wallets or sessions: the site keeps no analytics. Not a price or a market cap: those are on the token page, from the pool. Small numbers are shown as they are.' },
      ] },
    ],
  },
  {
    id: 'holders-vote',
    title: 'Holders vote',
    blocks: [
      { kind: 'p', text: `Holders vote (/vote) is rounds of ranked votes on what ${N} ships next, kept by a contract on Robinhood Chain (contracts/VerdexVote.sol). A round names its candidates and when it closes; any address submits a ranking while it is open and can replace it. Nothing is locked, deposited or snapshotted: the page tallies a round by reading every voter’s ranking from the contract and every voter’s VERDEX balance from the token at that moment.` },
      { kind: 'defs', items: [
        { term: 'The count', text: 'Borda: with n candidates, a first place is worth n times the voter’s balance, a second n minus one, and so on; candidates left unranked get nothing from that voter. The page shows each candidate’s share of all points and the balance that put it first.' },
        { term: 'Weight', text: 'Your VERDEX balance when the round is tallied, never when you voted. Buy more and your vote grows; sell and it shrinks; sell everything and your ranking stays on the chain but weighs nothing.' },
        { term: 'Rounds', text: 'The admin opens one about every two weeks, with two to twelve candidates and a closing time; it cannot vote, remove a ranking or change a round once opened. Closed rounds keep their rankings onchain, so anyone can re-tally them.' },
        { term: 'What it decides', text: `The order in which ${N} builds what comes after phase 2. It is a ranking by the holders, read by the people who build; it is not a governance token, a treasury vote or a promise of a date.` },
        { term: 'Risk', text: 'The contract is unaudited and moves no tokens; the risk is the vote itself being read wrongly, which anyone can check by re-tallying from the contract. A ranking is public under your address.' },
      ] },
    ],
  },
  {
    id: 'copy-a-wallet',
    title: 'Copy a wallet',
    blocks: [
      { kind: 'p', text: `Copy a wallet (/copy) reads the tokenized stocks any address holds on Robinhood Chain, values them at their USDG pools’ spot prices and turns them into weights, all from the chain when you paste the address. Copy it saves a vault on this device at those weights, which you fund with USDG on the Vaults page: each stock is bought from its pool by a swap your wallet confirms, with a floor. Keep it opens Vaults without you with the weights filled in, so the contract keeps you at them.` },
      { kind: 'defs', items: [
        { term: 'What is copied', text: 'An allocation at today’s prices: the weights, not the entry prices, the timing or anything the address does next. Stocks without a deep USDG pool are shown and left out of the weights, since they could not be bought well.' },
        { term: 'What is not', text: `${N} does not know who an address is, keeps no list of addresses, stores nothing you paste and ranks no wallets. Every balance on the chain is public; the page only reads them.` },
        { term: 'Custody and fees', text: 'None. Your USDG buys your stocks into your wallet through the same pools and floors as everything else on the site. There is no contract for copying and no fee.' },
        { term: 'Risk', text: 'You are buying what someone else holds, at the pools’ current prices, with the pools’ current depth. A thin pool fills badly up to the floor; a copied wallet can sell a minute later and you will not see it here.' },
      ] },
    ],
  },
  {
    id: 'api',
    title: 'Verdex API',
    blocks: [
      { kind: 'p', text: `The API is the same reads the site makes, made by the server and served as JSON, open to anyone, no key, no sign-up, cached sixty seconds. Nothing is stored: when the cache expires the next call reads the chain (and the aggregator’s public record) again. Every response is {"ok": true, "readAt": "…", "data": …}; errors are {"ok": false, "error": "…"} with a 502. CORS is open, so a browser page can call it directly.` },
      { kind: 'defs', items: [
        { term: 'GET /api', text: 'Lists the endpoints.' },
        { term: 'GET /api/numbers', text: 'The numbers page in one object: Index TVL and the list of indexes, volume through the aggregator by chain, Index buys and sells, the treasury totals, and the counts of plans, orders, vaults, mandates and executions.' },
        { term: 'GET /api/indexes, /api/indexes/base', text: 'Every index on both chains (or on Base only): address, symbol, name, supply, NAV and TVL at the pools, and each component’s units per share, price, weight and pool.' },
        { term: 'GET /api/without-you', text: 'The four contracts that work without you: their addresses, how many plans, orders, vaults and mandates exist, and every buy, fill, rebalance and trade of the last four weeks with its transaction.' },
        { term: 'GET /api/treasury', text: 'VERDEX bought, burned, paid back and waiting, and every sweep and payout with its transaction.' },
        { term: 'GET /api/volume', text: 'Swaps and bridges made through Verdex in the last 89 days, from the aggregator’s public record: totals by chain and each transfer with its explorer link.' },
        { term: 'GET /api/pools, /api/pools/base', text: 'Every tokenized-stock pool against the chain’s stablecoin: price, liquidity, day volume and the day’s move, with the pool and token addresses.' },
        { term: 'GET /api/assets', text: 'The stock list the site uses, with each asset’s tokens per chain.' },
        { term: 'GET /api/holders', text: 'Every wallet holding VERDEX with its balance, share and first day, the count, new holders today and this week, the spread by share of supply and the growth since the mint. The pool and contracts are labelled.' },
        { term: 'GET /api/candles/{robinhood|base}/{pool}', text: 'Daily candles of one pool, oldest first: [unix, open, high, low, close, volume in dollars]. Cached thirty minutes.' },
        { term: 'POST /api/gift/claim', text: 'The gift relay: { id, to, signature } where the signature is the gift link’s key signing the claim for `to`. Simulated, then sent by the executor wallet, which pays the gas. A few per address per hour.' },
        { term: 'Limits', text: 'Sixty-second cache per endpoint; one read in flight per endpoint, so a burst of calls shares one read. Be kind: it runs on the same small server as the executor. Fields may be added; existing ones will not change meaning without a note in the changelog.' },
      ] },
    ],
  },
  {
    id: 'verdex-index',
    title: 'Verdex Index',
    blocks: [
      { kind: 'p', text: `A Verdex Index is a basket of tokenized stocks as one ERC-20 on Robinhood Chain. Each share is backed by a fixed number of units of every stock in it, set when the index is created and never changed, held by the index contract (contracts/VerdexIndex.sol). Buying an index with USDG goes through the router (contracts/VerdexIndexRouter.sol), which buys exactly those units in each stock's Uniswap v3 pool, issues the shares and refunds the USDG it did not need, all in one transaction. Selling does the same in reverse. Redeeming hands you the stocks themselves, with no pool and no fee. The contracts are open source, verified on the explorer, and unaudited.` },
      { kind: 'defs', items: [
        { term: 'Units, not weights', text: 'The weights shown are the units at today’s prices. Nothing rebalances and nobody manages the basket. An index created with equal value per stock drifts as prices move, like a buy-and-hold basket would.' },
        { term: 'The price floor', text: 'Every leg of a buy or sell carries a limit the page sets from the pools’ spot prices, one percent by default. A thin or moved pool makes the whole transaction revert instead of filling one leg badly.' },
        { term: 'The fee', text: `${N} charges 0.25% of the USDG side of a buy or sell through the router, paid to the treasury address on the router. Wallets holding any VERDEX pay nothing, checked onchain in the same transaction. Redeeming in kind is free for everyone.` },
        { term: 'The cap', text: 'Each index has a cap on its share supply, set by whoever created it. It is the only lever the creator has: there is no function in the index contract that moves the stocks anywhere but back to a redeemer. Caps start small while the contracts are new.' },
        { term: 'Who can create one', text: `Anyone can create an index on the factory with their own name, stocks and units. The page lists the ones ${N} created at launch; the explorer lists them all.` },
        { term: 'On Base', text: `The same indexes exist on Base, made of Coinbase's tokenized stocks and quoted in USDC. The router there (contracts/VerdexIndexRouterCL.sol) fills each leg in the stock's Aerodrome Slipstream pool. VERDEX does not exist on Base, so the 0.25% fee applies to every wallet and goes to the treasury wallet, which buys VERDEX on Robinhood Chain. Switch chains at the top of the Index page; your wallet is moved to Base when you trade.` },
        { term: 'On Solana', text: `Solana has the baskets without the index token. The page at /solana asks Jupiter for the best route from USDC into every stock of a basket (xStocks, Backed's tokenized shares), builds one transaction per leg and your Solana wallet signs them all in one prompt; the stocks land in your wallet as themselves and you sell any share of them the same way. ${N} deploys no program on Solana and holds nothing. The 0.25% fee, once a Solana fee wallet is set, is one USDC transfer in the first leg. A leg that would move its pool more than one percent is refused before you sign; if a later leg fails after earlier ones landed, the page shows which did.` },
        { term: 'Risk', text: `The contracts are unaudited. The index holds the stocks behind the shares, so a bug there is a loss of those stocks. The source and compiled bytecode are in the repository, tested on a fork of Robinhood Chain and against Base's live state. Read them before you trust them with more than you would lose. On Solana the risks are Jupiter's routes, the pools behind them and the xStocks terms, none of which are ${N}'s.` },
      ] },
    ],
  },
  {
    id: 'fees-buy-verdex',
    title: 'Fees buy VERDEX',
    blocks: [
      { kind: 'p', text: `Every fee the ${N} protocol earns lands in one public contract, the treasury (contracts/VerdexTreasury.sol), and the only thing that contract can do with a balance is buy VERDEX. An executor sweeps its USDG and ETH into VERDEX through a route from the aggregator; the contract checks the VERDEX it gets against a floor it reads itself from the pools (USDG to ETH on Uniswap v3, ETH to VERDEX on Uniswap v4) less a slippage band, and reverts if the route came in under it. Half of every sweep goes to the burn address. The other half waits in the contract for the weekly payout to the wallets that paid the fees, pro rata to what they paid. No function sends funds anywhere else: not to the owner, not to the executor.` },
      { kind: 'defs', items: [
        { term: 'What flows in', text: `Today, the ${N} fee on Index buys and sells through the router. Each new contract points its fee at the treasury as it ships. The 0.25% swap fee collected by the aggregator still goes to the fee wallet until the integrator wallet is moved to the treasury.` },
        { term: 'The sweep', text: 'Runs every six hours from the server that serves this site, when the treasury holds at least a few USDG or a little ETH. The route is built by the aggregator for the treasury itself; the contract swaps, measures the VERDEX that arrived, and refuses anything under its floor. Every sweep is a transaction listed on the page.' },
        { term: 'The payout', text: 'Once a week, the kept VERDEX goes to the wallets that paid fees since the last payout, in proportion to the fees they paid, read from the fee events of the routers. The page shows the running list and your share before it is paid. The executor computes the split; the contract only pays from the bucket and never more than it holds.' },
        { term: 'The split and the band', text: 'The burn share (50%) and the slippage band (8%) are set by the owner, both capped in the contract. The owner also keeps the executor list and the router list. That is all the owner can do.' },
        { term: 'Risk', text: `The contract is unaudited and holds fees between sweeps and VERDEX between payouts. The source and bytecode are in the repository, tested on a fork of Robinhood Chain.` },
      ] },
    ],
  },
  {
    id: 'verdex-lend',
    title: 'Verdex Lend',
    blocks: [
      { kind: 'p', text: `${N} Lend (contracts/VerdexLend.sol) is a set of isolated money markets for tokenized stocks on Robinhood Chain. Each market pairs one stock with USDG. Suppliers deposit USDG and earn the interest borrowers pay; borrowers lock the stock and draw USDG against it without selling. Markets are isolated: one stock, its own loan-to-value, its own caps, nothing spills over. The contract holds the stocks and the USDG and can send them only to the people they belong to, or to a liquidator against a loan that fell under its threshold. There is no function that moves funds to the owner.` },
      { kind: 'defs', items: [
        { term: 'The price', text: 'Read from the stock\'s Uniswap v3 USDG pool inside the transaction: the lower of spot and a 30-minute time-weighted average when you borrow or take collateral out, the higher of the two when a loan is checked for liquidation. A single manipulated block cannot open a loan it should not or close one it should not.' },
        { term: 'Interest', text: 'Accrues by the second at a rate that rises with how much of the supplied USDG is lent out: a base rate plus a slope at full use. Ten percent of the interest is kept as a reserve and sent to the treasury, where it buys VERDEX. The rest goes to the suppliers.' },
        { term: 'Liquidation', text: 'When debt exceeds the liquidation threshold of the collateral value, anyone can repay part of the debt and receive collateral worth that amount plus the bonus, at the liquidation price. Keep the health above 1 by repaying or adding collateral.' },
        { term: 'Caps', text: `Every market opens with hard caps on what can be supplied, borrowed and locked, raised by the owner as the market proves itself. The owner keeps caps, loan-to-value, thresholds, rates and the time-weighted window, and can pause new activity in a market; withdrawing, repaying and taking collateral out always work.` },
        { term: 'Version 3', text: 'The contract live today is the third: our own audit (docs/audit-2026-10-05.md) found an oracle that fell back to spot when the pool had too few observations, liquidations priced at the higher of spot and TWAP, phantom debt after a full seizure and short-market reserves sent where nothing could use them. All four are fixed in v3, re-tested on a fork, and the markets were recreated with the same parameters and caps. Nothing was supplied to the earlier versions.' },
        { term: 'Risk', text: `The contract is unaudited. Tokenized stocks are priced by their pools, not by the exchange they track; a thin pool can move. A borrower who ignores the health line loses collateral to liquidators. The source and bytecode are in the repository, tested on a fork of Robinhood Chain.` },
      ] },
    ],
  },
  {
    id: 'leverage',
    title: 'Leverage',
    blocks: [
      { kind: 'p', text: `${N} Leverage (contracts/VerdexLeverage.sol) opens two-times long and short positions on tokenized stocks, built on ${N} Lend. A long: your USDG margin plus USDG borrowed from Lend buy the stock in its Uniswap v3 pool, in one transaction, and the stock is locked in Lend as the collateral for that loan. A short: your margin is locked in a Lend market that lends the stock itself; the stock is borrowed, sold in the pool, and the USDG it fetched is locked next to your margin. Each wallet gets its own account contract, so each position is its own Lend position: its own health, its own liquidation, nothing shared. The hub holds nothing and no function moves funds to the owner.` },
      { kind: 'defs', items: [
        { term: 'Leverage', text: 'Up to 1.9x long and 2x short. A long at exactly 2x cannot pass the 50% loan-to-value check once the pool fee is paid, so the page stops at 1.9x. Shorts use markets with a 70% loan-to-value and an 80% liquidation line, because the collateral is USDG.' },
        { term: 'Closing', text: 'A long sells all the stock, repays the loan and returns the rest in USDG. A short buys the stock back, repays it and returns your margin and what is left. Both are one swap. Add margin at any time: a long repays part of its loan, a short adds USDG collateral.' },
        { term: 'Liquidation', text: 'Happens in Lend, by anyone, at the market\'s liquidation line, with its bonus. The page shows your health and the price at which it happens. A liquidated position is settled from the page so the wallet can open again.' },
        { term: 'Fee and caps', text: `${N} charges 0.25% of the exposure when a position opens, paid to the treasury where it buys VERDEX, waived for wallets holding VERDEX. Open interest is capped per market and raised as the markets prove themselves.` },
        { term: 'Version 2', text: 'v2 points at Lend v3, fixes a close that reverted after a full repay, and can add collateral to a position while its market is paused. Reviewed in our own audit with Lend; no third party has audited it. Caps start small.' },
        { term: 'Risk', text: 'Unaudited. Leverage multiplies a move both ways; a 1.9x long is liquidated after a fall of roughly a quarter, a 2x short after a rise of roughly a fifth, interest included. The prices are the pools\' prices. Read the contract before you trust it with more than you would lose.' },
      ] },
    ],
  },
  {
    id: 'vaults',
    title: 'Vaults',
    blocks: [
      { kind: 'p', text: `A target allocation across up to twelve listed assets on one chain, curated from a template or built by hand, held in your own wallet. ${N} reads balances and prices live, computes how far each asset has drifted from its target, and plans the trades back to target when the vault passes its drift threshold or its scheduled date.` },
      { kind: 'defs', items: [
        { term: 'Rule', text: 'Weekly, monthly, quarterly, or only when it drifts. A drift-only vault has no date.' },
        { term: 'Threshold', text: 'The drift, in percentage points, that makes a rebalance due: 2, 5 or 10.' },
        { term: 'Rebalance', text: 'Sells of the overweight assets and buys of the underweight ones, each priced through the aggregator and confirmed in your wallet one by one. A rebalance you start can be stopped between trades.' },
        { term: 'Funding', text: 'Add the quote stablecoin and the next rebalance buys the assets by weight.' },
      ] },
    ],
  },
  {
    id: 'phase-4',
    title: 'Holders, charts, your own index',
    blocks: [
      { kind: 'p', text: `Phase 4 added the pages that show what is on the chain and let you build on it. Everything below reads Robinhood Chain and Base directly or through the Verdex API.` },
      { kind: 'defs', items: [
        { term: 'Holders (/holders)', text: 'Every wallet holding VERDEX, read from the token’s transfer history since the mint with each balance read from the token, so the list adds up to the supply. Your rank, share and distance to early access when you connect.' },
        { term: 'Stock pages and charts (/assets/TICKER)', text: 'Daily candles from the stock’s own pool, up to 90 days, the move over 1, 7 and 30 days, the pool, the Verdex indexes that hold it, and buy, order and Auto-Invest buttons. Candles come from GeckoTerminal’s public record of the pool, cached by the Verdex server.' },
        { term: 'Backtest', text: 'A basket bought at its weights on the first day of the window and held at fixed units, valued at each stock’s daily close in its pool, against SPY over the same days, with best and worst day and the deepest drop. No fees or slippage. On every index, in the vault composer and before you make an index. Past moves are not a promise.' },
        { term: 'Make your own index (/index/create)', text: 'Up to 20 stocks and your weights become fixed units at today’s pool prices, one share worth one dollar at creation, deployed from your wallet through the open index factory on Robinhood Chain or Base. At most 1,000,000 shares. Names starting with Verdex and tickers starting with VX are kept for Verdex. The creator is the index’s owner, which can only change the share cap.' },
        { term: 'Community indexes (/index/community)', text: 'Every index anyone made with the factories, with the wallet that made it. Not curated, not promoted, not reviewed by Verdex: read what is in one before buying it. Each has a page at /index/CHAIN/ADDRESS.' },
        { term: 'Gift a stock (/gift)', text: 'contracts/VerdexGift.sol holds a gift under a one-time key carried in the link’s fragment, which never reaches a server. Claiming signs the receiver’s address with that key, so a copied claim can only pay the same receiver; the Verdex relay submits it and pays the gas. After the expiry the sender can take an unclaimed gift back. No owner, no admin, no fee. Whoever has the link can claim the gift: send it privately.' },
        { term: 'Share cards (/share)', text: 'Your holdings, an index or your holder rank drawn as an image in your browser. Nothing is uploaded.' },
        { term: 'Watchlist and alerts (/watchlist)', text: 'Starred stocks and price levels stay in your browser. While a Verdex tab or the installed app is open, the page checks the pools every minute and notifies you when a level is crossed. To trade instead of notify, use Orders without you.' },
        { term: 'Auto-Invest into any index (/index/auto-invest)', text: 'contracts/VerdexIndexPlans.sol: a recurring buy of any index on Robinhood Chain. The plan fixes each leg’s pool; the executor names only how many shares; the contract caps every leg at the pool’s spot plus 1% and the whole buy at the plan’s amount, sends the shares to you, refunds what was not spent and pays a $0.10 tip. The index router’s 0.25% fee applies. Verified, unaudited.' },
        { term: 'Index league (/league)', text: 'Every index on both chains ranked by how one share moved over 7 or 30 days, with what it holds and who made it.' },
      ] },
    ],
  },
  {
    id: 'strategies',
    title: 'Strategies',
    blocks: [
      { kind: 'p', text: `Published allocations you can follow into a vault of your own. A strategy is a set of weights with a change log; following it creates a vault in your wallet at the current version. When the manager publishes a new version, your vault shows the update and adopting it plans the trades; nothing changes until you do.` },
      { kind: 'p', text: 'Any vault can also be shared as a link. The link carries the weights, the chain and the rule, and nothing about the wallet that made it.' },
    ],
  },
  {
    id: 'orders',
    title: 'Orders',
    blocks: [
      { kind: 'p', text: 'Limit and stop orders on any listed asset on an EVM chain. An order names an asset, a side, a trigger price and a size, and is stored in your browser for the wallet that placed it.' },
      { kind: 'defs', items: [
        { term: 'Limit buy', text: 'Buys when the price falls to your level or lower.' },
        { term: 'Stop buy', text: 'Buys when the price breaks above your level.' },
        { term: 'Limit sell', text: 'Sells when the price rises to your level or higher.' },
        { term: 'Stop sell', text: 'A stop-loss: sells when the price falls to your level or lower.' },
        { term: 'Watching', text: `The price is checked every 30 seconds while ${N} is open, including the installed app, through the same feed that prices swaps. A level crossed while the app was closed triggers on the next open.` },
        { term: 'Fill', text: 'The fill is a market swap at the moment you confirm it, through the best route, so it lands at or near your level. Nothing is filled without that confirmation.' },
      ] },
    ],
  },
  {
    id: 'agent',
    title: 'Agent',
    blocks: [
      { kind: 'p', text: `Ask for an order, a recurring buy or a vault in plain words. The agent reads the market snapshot, the live price feed and your wallet through a fixed set of tools, and returns each action as a card with every field filled in. Approving the card saves a normal order, plan or vault; dismissing it leaves nothing behind. Your wallet still confirms every trade afterwards.` },
      { kind: 'defs', items: [
        { term: 'Your key', text: `Bring your own Anthropic or OpenAI key. It is stored in your browser only and sent, with your messages and the tool results, straight to that provider over HTTPS. ${N} has no server in that path.` },
        { term: 'No key', text: 'A small built-in helper understands the common phrasings and drafts the same cards without sending anything anywhere.' },
        { term: 'Tools', text: 'Four that read (search assets, price, holdings, activity) and three that draft (an order, a plan, a vault). The model cannot call anything else, and none of the tools can sign, send or move funds.' },
        { term: 'Approval', text: 'The agent proposes, you approve, your wallet confirms. There is no mode that skips a step.' },
      ] },
    ],
  },
  {
    id: 'fees',
    title: 'Fees',
    blocks: [
      { kind: 'p', text: 'Every quote shows the full cost before you sign. A transfer can include:' },
      { kind: 'fees', items: [
        { term: `${N} fee`, text: '0.25% of the amount sent, on swaps, bridges, private swaps, Auto-Invest buys, order fills, vault rebalances and agent trades. Zero for wallets that hold VERDEX.' },
        { term: 'VERDEX holders', text: `No ${N} fee on anything. The balance is read from the token contract on Robinhood Chain before each quote; any amount counts.` },
        { term: 'Index baskets', text: `No ${N} fee. The basket charges its own mint fee and yearly fee, shown on each basket page.` },
        { term: 'Automated baskets', text: '0.50% per swap, rebalances included.' },
        { term: 'Strategy baskets', text: '0.50% per swap, the same as Swap and Bridge.' },
        { term: 'Lend and Borrow', text: `No ${N} fee. You pay Kamino’s borrow rate on what you borrow.` },
        { term: 'Route fees', text: 'What the route itself charges, shown as one line in the quote. LI.FI, which prices and executes every trade, takes 0.25% of the amount sent on the routes it runs; a bridge or exchange on the route can add its own.' },
        { term: 'Network gas', text: 'paid in the source chain’s gas token' },
      ] },
      { kind: 'p', text: `Both the ${N} fee and the route fees are taken from the token you send and are already inside the amount the quote says you will receive. Gas on Arc is paid in USDC.` },
    ],
  },
  {
    id: 'holding',
    title: 'Holding VERDEX',
    blocks: [
      { kind: 'p', text: `VERDEX is the token behind ${N}. Holding it changes two things, both read from the wallet's balance on Robinhood Chain and nothing else: no contract to stake into, no lock, no registration.` },
      { kind: 'defs', items: [
        { term: 'Any amount', text: `The ${N} fee is zero on every trade: swaps, bridges, private swaps, Auto-Invest, Orders, Vaults, Strategies and the agent. Everyone else pays 0.25%.` },
        { term: '0.5% of the supply', text: `Early access. Each new feature opens to wallets holding at least 0.5% of the supply first, and to everyone a stated time later. The threshold is computed from the live total supply, so burns lower it.` },
        { term: 'How it is checked', text: `Your browser reads balanceOf and totalSupply from the token contract before each quote and when you open a gated page. The result is cached for a minute. Nothing is sent to ${N}.` },
        { term: 'Where it stands', text: 'The VERDEX page shows your balance, your share of the supply and how far you are from early access when a wallet is connected.' },
      ] },
    ],
  },
  {
    id: 'private-swaps',
    title: 'Private swaps',
    blocks: [
      { kind: 'p', text: 'Private swaps move assets across chains with no onchain link between the address that sends and the address that receives.' },
      { kind: 'steps', items: [
        { title: 'Choose tokens and a destination', text: 'Pick tokens, amount and a destination address.' },
        { title: 'Send the deposit', text: 'Send the exact amount to the one-time deposit address.' },
        { title: 'Routing', text: 'Funds route through two partner exchanges.' },
        { title: 'Delivery', text: 'The output arrives at the destination address.' },
      ] },
      { kind: 'fees', items: [{ term: `${N} fee`, text: '0.75%' }, { term: 'Time', text: '15–45 minutes' }, { term: 'Deposit window', text: 'about 30 minutes' }, { term: 'Minimum and maximum', text: 'set per token pair, shown in the quote' }] },
      { kind: 'p', text: 'Partner exchanges screen every swap and may hold, review or refund it.' },
      { kind: 'p', text: 'Private swaps are not available to US residents or in countries under US or EU sanctions.' },
      { kind: 'p', text: 'Routing through Monero: coming soon.' },
    ],
  },
  {
    id: 'tracking-a-transfer',
    title: 'Tracking a transfer',
    blocks: [
      { kind: 'p', text: `Every ${N} transfer appears on the Explorer with the source and destination asset, amounts, route, status, and a link to each chain’s block explorer.` },
      { kind: 'defs', items: [
        { term: 'Pending', text: 'Sent on the source chain, waiting for the bridge or destination transaction' },
        { term: 'Done', text: 'Received on the destination chain' },
        { term: 'Partial', text: 'Bridge completed but the destination swap did not; you received the bridged token' },
        { term: 'Refunded', text: 'The route could not complete and tokens were returned' },
        { term: 'Failed', text: 'The transfer did not go through, e.g. slippage exceeded or not enough balance' },
      ] },
    ],
  },
  {
    id: 'safety',
    title: 'Safety',
    blocks: [
      { kind: 'defs', items: [
        { term: 'Custody', text: 'Non-custodial. You sign every transaction from your own address.' },
        { term: 'Minimum received', text: 'Enforced onchain. If the price moves past your slippage setting, the transaction reverts.' },
        { term: 'Same-chain swaps', text: 'Atomic. A failed swap reverts completely.' },
        { term: 'Cross-chain transfers', text: 'If the bridge succeeds but the destination swap fails, you receive the bridged asset on the destination chain.' },
        { term: 'Contracts', text: 'Routing contracts are audited, open source and covered by a bug bounty.' },
        { term: 'Approvals', text: `Before a swap from an ERC-20 token, your wallet approves the aggregator's router to spend it. ${N} asks for an unlimited allowance once per token and chain so that recurring buys and rebalances need one confirmation each; you can revoke it at any time from your wallet or a tool such as revoke.cash, and the next trade will ask again.` },
        { term: 'Automation', text: `Plans, vaults, orders and agent proposals live in your browser. Nothing runs while the site is closed, nothing is executed without a confirmation in your wallet, and ${N} never holds keys, funds or allowances of its own.` },
      ] },
    ],
  },
  {
    id: 'audit',
    title: 'Audit',
    blocks: [
      { kind: 'p', text: `An internal audit of the site, published on 30 September 2026 so that anyone can check the findings against the code. It covers custody, approvals, routes, fees, the automation features, the agent, dependencies, the installed app and privacy, plus a crawl of every route on desktop and mobile. It is not a third-party audit, and it does not cover contracts ${N} does not own.` },
      { kind: 'defs', items: [
        { term: 'Automated checks', text: 'npm audit: 0 vulnerabilities in production and development packages. ESLint: 0 problems. TypeScript strict: 0 errors. 20 routes on two viewports: 0 page errors, 0 console errors, 0 failed requests.' },
        { term: 'Fixed', text: 'The privacy policy now names every data flow and who receives it. Every route has its own title. Shared links carry a preview image. Thirteen inputs are labelled for screen readers. Private-swap addresses are checksummed. Vendor code ships in its own chunks, so the largest file went from 1.1 MB to 288 kB.' },
        { term: 'Kept, and why', text: 'One unlimited allowance per token to the router named by each quote, so recurring buys and rebalances stay a single confirmation; revocable at any time. The agent key lives in your browser because there is no Verdex server to hold it. Order fills are market swaps at the moment you confirm.' },
        { term: 'Out of scope', text: 'The routing contracts, the issuers\' tokens, the lending and basket protocols and the launchpad behind VERDEX have their own audits.' },
        { term: 'Re-audit, 1 October 2026', text: 'Every check re-run after the seven launches that followed: 0 vulnerabilities, 0 lint problems, 0 type errors, 24 routes on two viewports with 0 errors. The holder, pools and yield engines read line by line. Two low findings fixed and shipped: a Spark deposit above the vault cap is refused before it reaches the wallet, and a stock’s band is placed in a pool with at least $25,000 of liquidity. Four things kept with the reasoning, among them that the Spark vault is upgradeable by Spark.' },
        { term: 'Full report', text: 'AUDIT.md in the repository lists every finding with the file to open: github.com/useverdex/verdex/blob/main/AUDIT.md. Report anything it missed to feedback@verdex.app.' },
      ] },
    ],
  },
  {
    id: 'bug-bounty',
    title: 'Bug bounty',
    blocks: [
      { kind: 'p', text: `Anyone who finds what the audit missed gets paid, in ETH on Robinhood Chain, from the creator fees the VERDEX token earns. Report privately first and give us reasonable time to fix; the channels and the full rules are in SECURITY.md in the repository.` },
      { kind: 'fees', items: [
        { term: 'Critical · 0.5 ETH', text: 'The site requests a signature or sends a transaction the user did not ask for, or what is sent is changed.' },
        { term: 'High · 0.2 ETH', text: 'A wrong route, amount, address or fee at confirmation time; reading another user\'s stored plans, orders, vaults or key.' },
        { term: 'Medium · 0.05 ETH', text: 'A data leak, a broken safety check, or automation acting on the wrong data.' },
        { term: 'Low · credit', text: 'Anything else that misleads a user.' },
      ] },
    ],
  },
  {
    id: 'supported-chains',
    title: 'Supported chains',
    blocks: [{ kind: 'chains' }],
  },
  {
    id: 'faq',
    title: 'FAQ',
    blocks: [
      { kind: 'faq', items: [
        { q: 'Why is Robinhood Chain the default?', a: `Robinhood Chain hosts the deepest pools of tokenized stocks today, and ${N} is native there. Any other supported chain is one tap away in the token picker.` },
        { q: 'Why does the fastest route pay a little less?', a: 'Faster routes use solvers and bridges that settle in seconds and charge a small premium for it. Best Return waits a little longer for the route that gives you the most.' },
        { q: 'How long does a bridge take?', a: 'Most bridges settle in under two minutes. Routes through canonical bridges can take longer; the estimated time is shown on every quote.' },
        { q: 'My transfer is pending for a long time. What do I do?', a: 'Open the transfer in the tracker. If the source transaction confirmed, the bridge will complete or refund by itself. If a destination swap failed you receive the bridged token instead.' },
        { q: 'What do I hold after buying a basket?', a: 'An index basket: one ERC-20 token backed by the assets inside. A strategy basket: each stock token separately. An automated basket: the holdings, in an account owned by your address.' },
        { q: 'Can I sell a basket at any time?', a: 'Yes. Index baskets redeem or sell onchain at any time. Strategy and automated baskets sell stock by stock during US market hours for tokenized stocks.' },
        { q: 'Why does a stock show no route?', a: 'No pool or solver could price that stock token at that moment, most often outside US market hours. It is marked and left out of the order; try again later.' },
        { q: 'Why was my basket quote refused?', a: 'Some sources refuse VPN and proxy connections, and issuers restrict certain residents. Turn the VPN off and try again; if it persists the source is unavailable in your region.' },
        { q: 'Can I add liquidity to a tokenized stock pool?', a: 'Yes. Open the pool under Tokenized Pools and choose Add Liquidity. Set a price range and the amounts, approve each token once, and one transaction adds the position.' },
        { q: 'Do I need an account?', a: `No. ${N} is non-custodial: connect a wallet and sign each transaction. There is nothing to register and no data to hand over.` },
      ] },
    ],
  },
]

export const BETA_NOTES = [
  { title: 'New integrations keep arriving', text: 'More issuers, chains, lending protocols and basket sources are added as each one is checked.' },
  { title: 'Pages and features can change', text: 'Layouts, options and flows are updated as new products join.' },
  { title: 'Routes depend on third parties', text: `Prices and liquidity come from the protocols ${N} connects to, so a route available now may be missing later, most often outside US market hours.` },
  { title: 'Tell us what you find', text: `Report anything that looks wrong to feedback@${BRAND.domain}.` },
]
