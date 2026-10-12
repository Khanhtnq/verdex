// Relays gift claims for receivers with no ETH: the claim is signed in the receiver's browser with the link's key and
// names the receiver, so the relay can only submit it, never redirect it. The executor wallet pays the gas. Each claim
// is simulated first; a few per address and a cap per day keep the gas bill bounded.
import { createPublicClient, createWalletClient, http, parseAbi, isAddress, isHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { GIFT_ADDRESS } from './gift-address.mjs'

const abi = parseAbi(['function claim(uint256 id,address to,bytes signature)'])
const RPC = process.env.RPC || 'https://rpc.mainnet.chain.robinhood.com/'
const chain = { id: 4663, name: 'Robinhood Chain', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } }
const PER_IP_HOUR = 6, PER_DAY = 300
const byIp = new Map()
let day = { start: Date.now(), n: 0 }

export async function relayClaim(key, ip, body) {
  if (!key) return { status: 503, body: { ok: false, error: 'relay off' } }
  const { id, to, signature } = body ?? {}
  if (!/^\d{1,12}$/.test(String(id)) || !isAddress(String(to)) || !isHex(signature) || signature.length !== 132) return { status: 400, body: { ok: false, error: 'bad claim' } }
  const now = Date.now()
  if (now - day.start > 86_400_000) day = { start: now, n: 0 }
  const hits = (byIp.get(ip) ?? []).filter((t) => now - t < 3_600_000)
  if (hits.length >= PER_IP_HOUR || day.n >= PER_DAY) return { status: 429, body: { ok: false, error: 'too many claims, claim from your own wallet instead' } }
  const account = privateKeyToAccount(key)
  const pub = createPublicClient({ chain, transport: http(RPC, { retryCount: 2 }) })
  const wallet = createWalletClient({ account, chain, transport: http(RPC) })
  try {
    const sim = await pub.simulateContract({ account, address: GIFT_ADDRESS, abi, functionName: 'claim', args: [BigInt(id), to, signature] })
    const hash = await wallet.writeContract(sim.request)
    byIp.set(ip, [...hits, now]); day.n++
    return { status: 200, body: { ok: true, hash } }
  } catch (e) {
    return { status: 400, body: { ok: false, error: String(e?.shortMessage ?? e?.message ?? e).split('\n')[0].slice(0, 160) } }
  }
}
