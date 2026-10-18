// Holders vote: rounds of ranked votes on what ships next, where a holder's VERDEX balance is their vote. The
// contract (contracts/VerdexVote.sol) keeps the rounds and every voter's ranking; the page tallies a round by
// reading the rankings and each voter's balance from the token at that moment. Borda count: with n candidates,
// a first place is worth n points of the voter's weight, a second n-1, and so on; unranked candidates get none.
import { useQuery } from '@tanstack/react-query'
import { encodeFunctionData, erc20Abi, formatUnits, isAddress, parseAbi, type Address } from 'viem'
import artifact from '../../contracts/VerdexVote.json'
import { VOTE_ADDRESS as BUILT_IN } from '../../scripts/vote-address.mjs'
import { VERDEX_TOKEN } from './holding'
import { MULTICALL3, client, ensureChain, sendTx, type TxCtx } from './pools'

export const VOTE_ADDRESS = (String(import.meta.env.VITE_VOTE_ADDRESS ?? '').trim() || BUILT_IN).trim()
export const DEPLOYED = isAddress(VOTE_ADDRESS)
export const CONTRACT = (DEPLOYED ? VOTE_ADDRESS : '0x0000000000000000000000000000000000000000') as Address
export const abi = parseAbi([
  'constructor(address verdex_)',
  'function openRound(string title,string[] options,uint40 closesAt) returns (uint256)',
  'function vote(uint256 id,uint8[] ranking)',
  'function round(uint256 id) view returns (string title,string[] options,uint40 opensAt,uint40 closesAt,uint256 voterCount)',
  'function isOpen(uint256 id) view returns (bool)',
  'function voters(uint256 id,uint256 offset,uint256 limit) view returns (address[])',
  'function rankingOf(uint256 id,address voter) view returns (uint8[])',
  'function votedAt(uint256,address) view returns (uint40)',
  'function weightOf(address voter) view returns (uint256)',
  'function roundCount() view returns (uint256)',
  'function admin() view returns (address)',
  'function transferAdmin(address to)',
  'event RoundOpened(uint256 indexed id,string title,string[] options,uint40 opensAt,uint40 closesAt)',
  'event Voted(uint256 indexed id,address indexed voter,uint8[] ranking)',
])
export const BYTECODE = artifact.bytecode as `0x${string}`
export const EXPLORER = 'https://robin.etherscan.io'
export const explorerAddress = (a: string) => `${EXPLORER}/address/${a}`

export type Candidate = { index: number; label: string; points: bigint; firsts: bigint; share: number; rank: number }
export type Round = {
  id: bigint
  title: string
  options: string[]
  shipped: string[]
  opensAt: number
  closesAt: number
  open: boolean
  voterCount: number
  weightVoting: bigint // the VERDEX behind every ranking, read now
  supply: bigint
  candidates: Candidate[] // sorted, best first
  mine?: number[] // the connected wallet's ranking
  myWeight: bigint
}
const PAGE = 200n

// Options already shipped, taken out of a round's tally (their index in the round), and rounds whose results are
// read as final earlier than the contract's own close. Round 1 closes on this page on Oct 17, 23:59 CEST.
export const SHIPPED: Record<string, number[]> = { '1': [4] }
export const CLOSE_EARLY: Record<string, number> = { '1': Date.parse('2026-10-17T21:59:59Z') / 1000 }
export async function readRound(id: bigint, me?: Address): Promise<Round> {
  const c = client()
  const [r, open] = await Promise.all([c.readContract({ address: CONTRACT, abi, functionName: 'round', args: [id] }), c.readContract({ address: CONTRACT, abi, functionName: 'isOpen', args: [id] })])
  const [title, options, opensAt, chainClose, voterCount] = r
  const early = CLOSE_EARLY[String(id)]
  const closesAt = early && early < chainClose ? early : chainClose
  const openHere = open && Math.floor(Date.now() / 1000) <= closesAt
  const shipped = new Set(SHIPPED[String(id)] ?? [])
  const voters: Address[] = []
  for (let off = 0n; off < voterCount; off += PAGE) voters.push(...(await c.readContract({ address: CONTRACT, abi, functionName: 'voters', args: [id, off, PAGE] })))
  const n = options.length - shipped.size
  const points = options.map(() => 0n), firsts = options.map(() => 0n)
  let weightVoting = 0n
  let eligibleVoters = 0
  let mine: number[] | undefined
  for (let i = 0; i < voters.length; i += 100) {
    const batch = voters.slice(i, i + 100)
    const res = await c.multicall({ multicallAddress: MULTICALL3, batchSize: 4096, contracts: batch.flatMap((v) => [
      { address: CONTRACT, abi, functionName: 'rankingOf', args: [id, v] } as const,
      { address: VERDEX_TOKEN.address, abi: erc20Abi, functionName: 'balanceOf', args: [v] } as const,
      { address: CONTRACT, abi, functionName: 'votedAt', args: [id, v] } as const,
    ]) })
    batch.forEach((v, k) => {
      const ranking = res[k * 3].status === 'success' ? ([...(res[k * 3].result as readonly number[])] as number[]) : []
      const w = res[k * 3 + 1].status === 'success' ? (res[k * 3 + 1].result as bigint) : 0n
      const at = res[k * 3 + 2].status === 'success' ? Number(res[k * 3 + 2].result as number | bigint) : 0
      if (at === 0 || at > closesAt) return
      eligibleVoters += 1
      if (me && v.toLowerCase() === me.toLowerCase()) mine = ranking
      if (w === 0n || !ranking.length) return
      weightVoting += w
      const seen = new Set<number>()
      ranking.filter((opt) => !shipped.has(opt) && opt < options.length && !seen.has(opt) && (seen.add(opt), true)).forEach((opt, pos) => { points[opt] += w * BigInt(n - pos); if (pos === 0) firsts[opt] += w })
    })
  }
  const [supply, myBal] = await Promise.all([
    c.readContract({ address: VERDEX_TOKEN.address, abi: erc20Abi, functionName: 'totalSupply' }).catch(() => 0n),
    me ? c.readContract({ address: VERDEX_TOKEN.address, abi: erc20Abi, functionName: 'balanceOf', args: [me] }).catch(() => 0n) : Promise.resolve(0n),
  ])
  const total = points.reduce((s, p) => s + p, 0n)
  const candidates: Candidate[] = options.map((label, index) => ({ index, label, points: points[index], firsts: firsts[index], share: total > 0n ? Number((points[index] * 10_000n) / total) / 100 : 0, rank: 0 })).filter((x) => !shipped.has(x.index))
  candidates.sort((a, b) => (b.points > a.points ? 1 : b.points < a.points ? -1 : a.index - b.index))
  candidates.forEach((x, i) => (x.rank = i + 1))
  return { id, title, options: [...options], shipped: [...shipped].map((i) => options[i]), opensAt: Number(opensAt), closesAt: Number(closesAt), open: openHere, voterCount: eligibleVoters, weightVoting, supply, candidates, mine, myWeight: me ? myBal : 0n }
}
export async function readRounds(me?: Address): Promise<Round[]> {
  if (!DEPLOYED) return []
  const c = client()
  const n = Number(await c.readContract({ address: CONTRACT, abi, functionName: 'roundCount' }))
  const out: Round[] = []
  for (let id = n; id >= 1 && out.length < 6; id--) out.push(await readRound(BigInt(id), me))
  return out
}
export function useRounds(me: Address | undefined) {
  return useQuery({ queryKey: ['vote-rounds', me?.toLowerCase()], queryFn: () => readRounds(me), enabled: DEPLOYED, staleTime: 20_000, refetchInterval: 60_000, retry: 1 })
}
export async function castVote(ctx: TxCtx, id: bigint, ranking: number[]) {
  await ensureChain(ctx)
  return sendTx(ctx, CONTRACT, encodeFunctionData({ abi, functionName: 'vote', args: [id, ranking] }))
}
export async function openRound(ctx: TxCtx, title: string, options: string[], closesAt: number) {
  await ensureChain(ctx)
  return sendTx(ctx, CONTRACT, encodeFunctionData({ abi, functionName: 'openRound', args: [title, options, closesAt] }))
}
export const fmtVerdex = (v: bigint) => { const n = Number(formatUnits(v, 18)); return `${n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n.toFixed(0)} VERDEX` }
export const fmtWhen = (sec: number) => new Date(sec * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
