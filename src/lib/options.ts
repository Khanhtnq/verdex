// Stock options: contracts/VerdexOptions.sol. Writers lock the stock (call) or the strike in USDG (put) and name a
// premium; buyers pay it to the writer; holders exercise until expiry by delivery, at the strike. No oracle.
import { useQuery } from '@tanstack/react-query'
import { encodeFunctionData, erc20Abi, parseAbi, type Address } from 'viem'
import { OPTIONS_ADDRESS } from '../../scripts/p2p-address.mjs'
import { ROBINHOOD } from './api'
import { waitForTx } from './lifi'
import { MULTICALL3, RPC, USDG, client, ensureChain, sendTx, type TxCtx } from './pools'

export const OPTIONS = OPTIONS_ADDRESS as Address
export const abi = parseAbi([
  'function write(address underlying,bool isPut,uint256 amount,uint256 strike,uint256 premium,uint40 expiresAt) returns (uint256)',
  'function buy(uint256 id)',
  'function transfer(uint256 id,address to)',
  'function exercise(uint256 id)',
  'function reclaim(uint256 id)',
  'function option(uint256 id) view returns ((address writer,address holder,address underlying,bool isPut,uint8 state,uint40 expiresAt,uint256 amount,uint256 strike,uint256 premium))',
  'function optionCount() view returns (uint256)',
])
export type Option = { id: bigint; writer: Address; holder: Address; underlying: Address; isPut: boolean; state: 0 | 1 | 2; expiresAt: number; amount: bigint; strike: bigint; premium: bigint }
export const ZERO = '0x0000000000000000000000000000000000000000'
export const EXPIRIES = [{ label: '1 day', d: 1 }, { label: '1 week', d: 7 }, { label: '2 weeks', d: 14 }, { label: '1 month', d: 30 }, { label: '3 months', d: 90 }]

export async function readOptions(): Promise<Option[]> {
  const c = client()
  const n = Number(await c.readContract({ address: OPTIONS, abi, functionName: 'optionCount' }))
  const ids = Array.from({ length: n }, (_, i) => BigInt(i))
  const res = await c.multicall({ multicallAddress: MULTICALL3, allowFailure: false, contracts: ids.map((id) => ({ address: OPTIONS, abi, functionName: 'option', args: [id] }) as const) })
  return res.map((o, i) => ({ id: ids[i], ...o, state: o.state as Option['state'] })).reverse()
}
export function useOptions() {
  return useQuery({ queryKey: ['options'], queryFn: readOptions, refetchInterval: 30_000 })
}
const rhChain = (ctx: TxCtx) => (ctx.chain && ctx.chain.id === ROBINHOOD ? ctx.chain : ({ id: ROBINHOOD, metamask: { rpcUrls: [RPC] } } as never))
async function approve(ctx: TxCtx, token: Address, amount: bigint) {
  if (amount === 0n) return
  const allowance = await client().readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [ctx.account.address, OPTIONS] })
  if (allowance >= amount) return
  ctx.onPhase('approving')
  const h = await ctx.walletClient.sendTransaction({ account: ctx.account.address, chain: null, to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [OPTIONS, amount] }) })
  await waitForTx(rhChain(ctx), h)
}
async function call(ctx: TxCtx, data: `0x${string}`) {
  const hash = await sendTx(ctx, OPTIONS, data)
  const r = await client().waitForTransactionReceipt({ hash, timeout: 180_000 })
  if (r.status !== 'success') throw new Error('The transaction reverted')
  return hash
}
export async function writeOption(ctx: TxCtx, o: { underlying: Address; isPut: boolean; amount: bigint; strike: bigint; premium: bigint; days: number }) {
  await ensureChain(ctx)
  await approve(ctx, o.isPut ? USDG.address : o.underlying, o.isPut ? o.strike : o.amount)
  return call(ctx, encodeFunctionData({ abi, functionName: 'write', args: [o.underlying, o.isPut, o.amount, o.strike, o.premium, Math.floor(Date.now() / 1000) + o.days * 86_400] }))
}
export async function buyOption(ctx: TxCtx, o: Option) {
  await ensureChain(ctx)
  await approve(ctx, USDG.address, o.premium)
  return call(ctx, encodeFunctionData({ abi, functionName: 'buy', args: [o.id] }))
}
export async function exercise(ctx: TxCtx, o: Option) {
  await ensureChain(ctx)
  await approve(ctx, o.isPut ? o.underlying : USDG.address, o.isPut ? o.amount : o.strike)
  return call(ctx, encodeFunctionData({ abi, functionName: 'exercise', args: [o.id] }))
}
export async function reclaim(ctx: TxCtx, o: Option) {
  await ensureChain(ctx)
  return call(ctx, encodeFunctionData({ abi, functionName: 'reclaim', args: [o.id] }))
}
