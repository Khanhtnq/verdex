// Gift a stock: deposit a token in contracts/VerdexGift.sol under a one-time key, and share a link whose fragment holds
// that key (a fragment never reaches any server). The receiver's browser signs their address with it; the claim goes
// through the Verdex relay (which pays the gas) or the receiver's own wallet. Unclaimed gifts come back after expiry.
import { useQuery } from '@tanstack/react-query'
import { decodeEventLog, encodeFunctionData, erc20Abi, isAddress, parseAbi, type Address, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { GIFT_ADDRESS as BUILT_IN } from '../../scripts/gift-address.mjs'
import { ROBINHOOD } from './api'
import { waitForTx } from './lifi'
import { client, ensureChain, sendTx, type TxCtx } from './pools'

export const GIFT_ADDRESS = (String(import.meta.env.VITE_GIFT_ADDRESS ?? '').trim() || BUILT_IN) as Address
export const GIFT_DEPLOYED = isAddress(GIFT_ADDRESS)
export const abi = parseAbi([
  'function create(address token,uint256 amount,address key,uint40 expiresAt) returns (uint256)',
  'function claim(uint256 id,address to,bytes signature)',
  'function takeBack(uint256 id)',
  'function claimDigest(uint256 id,address to) view returns (bytes32)',
  'function gift(uint256 id) view returns ((address sender,address token,address key,uint40 createdAt,uint40 expiresAt,uint8 state,uint256 amount,address claimedBy))',
  'function giftCount() view returns (uint256)',
  'function sentBy(address sender) view returns (uint256[])',
  'event Created(uint256 indexed id,address indexed sender,address indexed token,uint256 amount,address key,uint40 expiresAt)',
])
export type Gift = { id: bigint; sender: Address; token: Address; key: Address; createdAt: number; expiresAt: number; state: 0 | 1 | 2; amount: bigint; claimedBy: Address }
export const EXPIRIES = [{ label: '1 day', s: 86_400 }, { label: '7 days', s: 7 * 86_400 }, { label: '30 days', s: 30 * 86_400 }, { label: '90 days', s: 90 * 86_400 }]
const GIFT_KEYS_STORAGE = 'verdex:gift-keys:v1'

function readKeyStore(): Record<string, Hex> {
  try { return JSON.parse(localStorage.getItem(GIFT_KEYS_STORAGE) ?? '{}') as Record<string, Hex> } catch { return {} }
}
function saveGiftKey(keyAddr: Address, pk: Hex, id?: bigint) {
  try {
    const store = readKeyStore()
    store[`${GIFT_ADDRESS.toLowerCase()}:key:${keyAddr.toLowerCase()}`] = pk
    if (id !== undefined) store[`${GIFT_ADDRESS.toLowerCase()}:id:${id.toString()}`] = pk
    localStorage.setItem(GIFT_KEYS_STORAGE, JSON.stringify(store))
  } catch { /* storage unavailable */ }
}
export function savedGiftLink(g: Pick<Gift, 'id' | 'key'>): string | undefined {
  const store = readKeyStore()
  const pk = store[`${GIFT_ADDRESS.toLowerCase()}:id:${g.id.toString()}`] ?? store[`${GIFT_ADDRESS.toLowerCase()}:key:${g.key.toLowerCase()}`]
  return pk && /^0x[0-9a-fA-F]{64}$/.test(pk) ? giftLink(g.id, pk) : undefined
}
export function keyMatchesGift(key: Hex, giftKey: Address): boolean {
  if (giftKey === '0x0000000000000000000000000000000000000000') return false
  try { return privateKeyToAccount(key).address.toLowerCase() === giftKey.toLowerCase() } catch { return false }
}

export async function readGift(id: bigint): Promise<Gift> {
  const g = await client().readContract({ address: GIFT_ADDRESS, abi, functionName: 'gift', args: [id] })
  return { id, sender: g.sender, token: g.token, key: g.key, createdAt: g.createdAt, expiresAt: g.expiresAt, state: g.state as Gift['state'], amount: g.amount, claimedBy: g.claimedBy }
}
export function useGift(id: bigint | undefined) {
  return useQuery({ queryKey: ['gift', id?.toString()], queryFn: () => readGift(id!), enabled: GIFT_DEPLOYED && id !== undefined, refetchInterval: 15_000 })
}
export async function readSent(owner: Address): Promise<Gift[]> {
  const ids = await client().readContract({ address: GIFT_ADDRESS, abi, functionName: 'sentBy', args: [owner] })
  return (await Promise.all([...ids].map((id) => readGift(id)))).reverse()
}
export function useSent(owner: Address | undefined) {
  return useQuery({ queryKey: ['gifts-sent', owner?.toLowerCase()], queryFn: () => readSent(owner!), enabled: GIFT_DEPLOYED && !!owner, refetchInterval: 30_000 })
}
export const giftLink = (id: bigint, key: Hex) => `${location.origin}/gift/claim#id=${id}&k=${key.slice(2)}`
export function parseLink(hash: string): { id: bigint; key: Hex } | null {
  const p = new URLSearchParams(hash.replace(/^#/, ''))
  const id = p.get('id'), k = p.get('k')
  if (!id || !/^\d+$/.test(id) || !k || !/^[0-9a-fA-F]{64}$/.test(k)) return null
  return { id: BigInt(id), key: `0x${k}` as Hex }
}

// Approve the amount needed, deposit it under a fresh key, and return the link.
export async function createGift(ctx: TxCtx, token: Address, amount: bigint, life: number) {
  await ensureChain(ctx)
  const c = client()
  const allowance = await c.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [ctx.account.address, GIFT_ADDRESS] })
  if (allowance < amount) {
    ctx.onPhase('approving')
    const h = await ctx.walletClient.sendTransaction({ account: ctx.account.address, chain: null, to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [GIFT_ADDRESS, amount] }) })
    await waitForTx(ctx.chain ?? ({ id: ROBINHOOD } as never), h)
  }
  const pk = generatePrivateKey()
  const key = privateKeyToAccount(pk).address
  saveGiftKey(key, pk)
  const expiresAt = Math.floor(Date.now() / 1000) + life
  const hash = await sendTx(ctx, GIFT_ADDRESS, encodeFunctionData({ abi, functionName: 'create', args: [token, amount, key, expiresAt] }))
  const r = await c.waitForTransactionReceipt({ hash, timeout: 180_000 })
  if (r.status !== 'success') throw new Error('The transaction reverted')
  const createdEvent = abi.find((x) => x.type === 'event' && x.name === 'Created')!
  let id: bigint | undefined
  for (const log of r.logs) {
    if (log.address.toLowerCase() !== GIFT_ADDRESS.toLowerCase()) continue
    try {
      const d = decodeEventLog({ abi: [createdEvent], data: log.data, topics: log.topics })
      id = (d.args as { id: bigint }).id
      break
    } catch { /* ignore unrelated logs */ }
  }
  if (id === undefined) {
    const sent = await c.readContract({ address: GIFT_ADDRESS, abi, functionName: 'sentBy', args: [ctx.account.address] })
    id = sent.slice(-1)[0]
  }
  if (id === undefined) throw new Error('Could not read the created gift id')
  saveGiftKey(key, pk, id)
  return { hash, id, link: giftLink(id, pk), ok: true }
}
export async function signClaim(id: bigint, key: Hex, to: Address) {
  const digest = await client().readContract({ address: GIFT_ADDRESS, abi, functionName: 'claimDigest', args: [id, to] })
  return privateKeyToAccount(key).signMessage({ message: { raw: digest } })
}
// The relay pays the gas; if it is busy or off, the receiver can send the same claim from their own wallet.
export async function claimByRelay(id: bigint, key: Hex, to: Address) {
  const signature = await signClaim(id, key, to)
  const r = await fetch('/api/gift/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: id.toString(), to, signature }) })
  const j = await r.json().catch(() => ({ ok: false, error: `relay ${r.status}` }))
  if (!j.ok) throw new Error(j.error ?? 'relay failed')
  const receipt = await client().waitForTransactionReceipt({ hash: j.hash, timeout: 180_000 })
  if (receipt.status !== 'success') throw new Error('The transaction reverted')
  return j.hash as Hex
}
export async function claimFromWallet(ctx: TxCtx, id: bigint, key: Hex) {
  await ensureChain(ctx)
  const signature = await signClaim(id, key, ctx.account.address)
  const hash = await sendTx(ctx, GIFT_ADDRESS, encodeFunctionData({ abi, functionName: 'claim', args: [id, ctx.account.address, signature] }))
  const receipt = await client().waitForTransactionReceipt({ hash, timeout: 180_000 })
  if (receipt.status !== 'success') throw new Error('The transaction reverted')
  return hash
}
export async function takeBack(ctx: TxCtx, id: bigint) {
  await ensureChain(ctx)
  const hash = await sendTx(ctx, GIFT_ADDRESS, encodeFunctionData({ abi, functionName: 'takeBack', args: [id] }))
  const receipt = await client().waitForTransactionReceipt({ hash, timeout: 180_000 })
  if (receipt.status !== 'success') throw new Error('The transaction reverted')
  return hash
}
