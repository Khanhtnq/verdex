// Term loans: contracts/VerdexTerm.sol. Lenders post offers (USDG locked, waiting for borrowers), borrowers post
// requests (collateral locked, waiting for a lender). Fixed interest for a fixed term, any token as collateral, no
// oracle and no liquidation before the end: repay by the end and the collateral comes back, or the lender takes it.
import { useQuery } from '@tanstack/react-query'
import { encodeFunctionData, erc20Abi, parseAbi, parseUnits, type Address } from 'viem'
import { TERM_ADDRESS } from '../../scripts/p2p-address.mjs'
import { ROBINHOOD } from './api'
import { waitForTx } from './lifi'
import { MULTICALL3, USDG, client, ensureChain, sendTx, type TxCtx } from './pools'

export const TERM = TERM_ADDRESS as Address
export const abi = parseAbi([
  'function postOffer(address collateral,uint256 amount,uint256 collPerLoan,uint256 minLoan,uint16 interestBps,uint32 term,uint40 expiresAt) returns (uint256)',
  'function postRequest(address collateral,uint256 collAmount,uint256 collPerLoan,uint256 minLoan,uint16 interestBps,uint32 term,uint40 expiresAt) returns (uint256)',
  'function borrow(uint256 id,uint256 principal) returns (uint256)',
  'function lend(uint256 id,uint256 principal) returns (uint256)',
  'function repay(uint256 loanId)',
  'function claim(uint256 loanId)',
  'function close(uint256 id)',
  'function offer(uint256 id) view returns ((address maker,bool isRequest,bool closed,address collateral,uint256 left,uint256 collPerLoan,uint256 minLoan,uint16 interestBps,uint32 term,uint40 expiresAt))',
  'function loan(uint256 id) view returns ((uint256 offerId,address lender,address borrower,address collateral,uint256 principal,uint256 owed,uint256 collAmount,uint40 startAt,uint40 endAt,uint8 state))',
  'function offerCount() view returns (uint256)',
  'function loansOf(address who) view returns (uint256[])',
])
export type Offer = { id: bigint; maker: Address; isRequest: boolean; closed: boolean; collateral: Address; left: bigint; collPerLoan: bigint; minLoan: bigint; interestBps: number; term: number; expiresAt: number }
export type Loan = { id: bigint; offerId: bigint; lender: Address; borrower: Address; collateral: Address; principal: bigint; owed: bigint; collAmount: bigint; startAt: number; endAt: number; state: 0 | 1 | 2 }
export const DAY = 86_400
export const SHORT_TERMS = [7, 14, 30]
export const LONG_TERMS = [90, 180, 365]

export async function readOffers(): Promise<Offer[]> {
  const c = client()
  const n = Number(await c.readContract({ address: TERM, abi, functionName: 'offerCount' }))
  const ids = Array.from({ length: n }, (_, i) => BigInt(i))
  const res = await c.multicall({ multicallAddress: MULTICALL3, allowFailure: false, contracts: ids.map((id) => ({ address: TERM, abi, functionName: 'offer', args: [id] }) as const) })
  return res.map((o, i) => ({ id: ids[i], ...o })).reverse()
}
export function useOffers() {
  return useQuery({ queryKey: ['term-offers'], queryFn: readOffers, refetchInterval: 30_000 })
}
export async function readLoans(who: Address): Promise<Loan[]> {
  const c = client()
  const ids = await c.readContract({ address: TERM, abi, functionName: 'loansOf', args: [who] })
  const res = await c.multicall({ multicallAddress: MULTICALL3, allowFailure: false, contracts: ids.map((id) => ({ address: TERM, abi, functionName: 'loan', args: [id] }) as const) })
  return res.map((l, i) => ({ id: ids[i], ...l, state: l.state as Loan['state'] })).reverse()
}
export function useLoans(who: Address | undefined) {
  return useQuery({ queryKey: ['term-loans', who?.toLowerCase()], queryFn: () => readLoans(who!), enabled: !!who, refetchInterval: 30_000 })
}

// Collateral units per 1e18 USDG units, from "collateral worth `ratio` times the loan at `price` USDG per token".
export function collPerLoan(ratio: number, price: number, collDecimals: number) {
  const perUsdg = parseUnits((ratio / price).toFixed(Math.min(collDecimals, 12)), collDecimals) // per 1 USDG (1e6 units)
  return perUsdg * 10n ** BigInt(18 - USDG.decimals)
}
export const collFor = (principal: bigint, perLoan: bigint) => (principal === 0n ? 0n : (principal * perLoan - 1n) / 10n ** 18n + 1n)
// The most USDG a request's locked collateral can still back.
export const maxPrincipal = (collLeft: bigint, perLoan: bigint) => (collLeft * 10n ** 18n) / perLoan

async function approve(ctx: TxCtx, token: Address, amount: bigint) {
  const c = client()
  const allowance = await c.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [ctx.account.address, TERM] })
  if (allowance >= amount) return
  ctx.onPhase('approving')
  const h = await ctx.walletClient.sendTransaction({ account: ctx.account.address, chain: null, to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [TERM, amount] }) })
  await waitForTx(ctx.chain ?? ({ id: ROBINHOOD } as never), h)
}
async function call(ctx: TxCtx, data: `0x${string}`) {
  const hash = await sendTx(ctx, TERM, data)
  const r = await client().waitForTransactionReceipt({ hash, timeout: 180_000 })
  if (r.status !== 'success') throw new Error('The transaction reverted')
  return hash
}
export type NewOffer = { isRequest: boolean; collateral: Address; amount: bigint; collPerLoan: bigint; minLoan: bigint; interestBps: number; termDays: number; openDays: number }
export async function post(ctx: TxCtx, o: NewOffer) {
  await ensureChain(ctx)
  await approve(ctx, o.isRequest ? o.collateral : USDG.address, o.amount)
  const expiresAt = Math.floor(Date.now() / 1000) + o.openDays * DAY
  return call(ctx, encodeFunctionData({ abi, functionName: o.isRequest ? 'postRequest' : 'postOffer', args: [o.collateral, o.amount, o.collPerLoan, o.minLoan, o.interestBps, o.termDays * DAY, expiresAt] }))
}
// Take an offer (borrow: lock collateral, get USDG) or fill a request (lend: send USDG, the borrower's collateral is locked).
export async function take(ctx: TxCtx, o: Offer, principal: bigint) {
  await ensureChain(ctx)
  if (o.isRequest) await approve(ctx, USDG.address, principal)
  else await approve(ctx, o.collateral, collFor(principal, o.collPerLoan))
  return call(ctx, encodeFunctionData({ abi, functionName: o.isRequest ? 'lend' : 'borrow', args: [o.id, principal] }))
}
export async function repay(ctx: TxCtx, l: Loan) {
  await ensureChain(ctx)
  await approve(ctx, USDG.address, l.owed)
  return call(ctx, encodeFunctionData({ abi, functionName: 'repay', args: [l.id] }))
}
export async function claimLoan(ctx: TxCtx, l: Loan) {
  await ensureChain(ctx)
  return call(ctx, encodeFunctionData({ abi, functionName: 'claim', args: [l.id] }))
}
export async function closeOffer(ctx: TxCtx, id: bigint) {
  await ensureChain(ctx)
  return call(ctx, encodeFunctionData({ abi, functionName: 'close', args: [id] }))
}
