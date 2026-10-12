// Auto-Invest into any index (contracts/VerdexIndexPlans.sol on Robinhood Chain): plans, the exact USDG allowance they
// need, and the owner's actions. The executor's pass in scripts/executor-lib.mjs buys the due plans.
import { useQuery } from '@tanstack/react-query'
import { encodeFunctionData, erc20Abi, parseAbi, type Address } from 'viem'
import { INDEX_PLANS_ADDRESS } from '../../scripts/index-plans-address.mjs'
import { ROBINHOOD } from './api'
import { waitForTx } from './lifi'
import { USDG, client, ensureChain, sendTx, type TxCtx } from './pools'
import type { IndexInfo } from './indexes'

export const PLANS = INDEX_PLANS_ADDRESS as Address
export const abi = parseAbi([
  'function create(address index,uint24[] fees,uint96 amount,uint96 tip,uint32 interval,uint40 firstAt,uint32 buys,uint16 maxSlippageBps) returns (uint256)',
  'function plan(uint256 id) view returns ((address owner,address index,uint96 amount,uint96 tip,uint32 interval,uint40 nextAt,uint32 buysLeft,uint32 buysDone,uint16 maxSlippageBps,bool paused,bool cancelled,uint128 spent,uint128 shares))',
  'function plansOf(address owner) view returns (uint256[])',
  'function planCount() view returns (uint256)',
  'function setPaused(uint256 id,bool paused)',
  'function cancel(uint256 id)',
  'function capFor(uint256 id,uint256 shares) view returns (uint256 total,uint256[] perLeg)',
  'function execute(uint256 id,uint256 shares) returns (uint256)',
])
export const TIP = 100_000n // $0.10
export const SLIPPAGE_BPS = 100
export const UNTIL_STOPPED = 4294967295
export const CADENCES = [{ label: 'Every day', s: 86_400 }, { label: 'Every week', s: 604_800 }, { label: 'Every two weeks', s: 1_209_600 }, { label: 'Every month', s: 2_592_000 }]
export type IndexPlan = { id: bigint; owner: Address; index: Address; amount: bigint; tip: bigint; interval: number; nextAt: number; buysLeft: number; buysDone: number; paused: boolean; cancelled: boolean; spent: bigint; shares: bigint }

export async function readPlans(owner: Address): Promise<IndexPlan[]> {
  const c = client()
  const ids = await c.readContract({ address: PLANS, abi, functionName: 'plansOf', args: [owner] })
  const ps = await Promise.all([...ids].map((id) => c.readContract({ address: PLANS, abi, functionName: 'plan', args: [id] })))
  return ps.map((p, i) => ({ id: ids[i], owner: p.owner, index: p.index, amount: p.amount, tip: p.tip, interval: p.interval, nextAt: p.nextAt, buysLeft: p.buysLeft, buysDone: p.buysDone, paused: p.paused, cancelled: p.cancelled, spent: p.spent, shares: p.shares })).reverse()
}
export function usePlans(owner: Address | undefined) {
  return useQuery({ queryKey: ['index-plans', owner?.toLowerCase()], queryFn: () => readPlans(owner!), enabled: !!owner, refetchInterval: 30_000 })
}
export function useAllowance(owner: Address | undefined) {
  return useQuery({ queryKey: ['index-plans-allowance', owner?.toLowerCase()], queryFn: () => client().readContract({ address: USDG.address, abi: erc20Abi, functionName: 'allowance', args: [owner!, PLANS] }), enabled: !!owner, refetchInterval: 30_000 })
}
// Approve what the plan may ever pull (every buy plus its tip; a year of buys for a plan with no end) and create it.
export const budgetFor = (amount: bigint, buys: number, interval: number) => (amount + TIP) * BigInt(buys === UNTIL_STOPPED ? Math.ceil((365 * 86_400) / interval) : buys)
export async function createPlan(ctx: TxCtx, x: IndexInfo, amount: bigint, interval: number, buys: number, current: bigint) {
  await ensureChain(ctx)
  const need = current + budgetFor(amount, buys, interval)
  ctx.onPhase('approving')
  const h = await ctx.walletClient.sendTransaction({ account: ctx.account.address, chain: null, to: USDG.address, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [PLANS, need] }) })
  await waitForTx(ctx.chain ?? ({ id: ROBINHOOD } as never), h)
  return sendTx(ctx, PLANS, encodeFunctionData({ abi, functionName: 'create', args: [x.address, x.fees, amount, TIP, interval, 0, buys, SLIPPAGE_BPS] }))
}
export async function setPaused(ctx: TxCtx, id: bigint, paused: boolean) { await ensureChain(ctx); return sendTx(ctx, PLANS, encodeFunctionData({ abi, functionName: 'setPaused', args: [id, paused] })) }
export async function cancelPlan(ctx: TxCtx, id: bigint) { await ensureChain(ctx); return sendTx(ctx, PLANS, encodeFunctionData({ abi, functionName: 'cancel', args: [id] })) }
export async function revoke(ctx: TxCtx) { await ensureChain(ctx); return sendTx(ctx, USDG.address, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [PLANS, 0n] })) }
