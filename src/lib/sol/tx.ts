// Verdex on Solana, the transaction layer. No Verdex program on Solana: a basket is bought leg by leg through
// Jupiter's routes, each leg one transaction the wallet signs in a single prompt, and the stocks land in the
// wallet as themselves (xStocks, Backed's tokenized shares). The fee, when a fee wallet is configured, is one
// USDC transfer prepended to the first leg. Pure functions over @solana/web3.js, so a script can run them.
import { Connection, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction, type AddressLookupTableAccount } from '@solana/web3.js'
import { Buffer } from 'buffer'

export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
export const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
export const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
export const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
export const JUPITER = 'https://lite-api.jup.ag'

export type JupQuote = { inputMint: string; outputMint: string; inAmount: string; outAmount: string; otherAmountThreshold: string; priceImpactPct: string; slippageBps: number; routePlan: { swapInfo: { label: string } }[] }
type JupIx = { programId: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string }
type JupSwapIxs = { computeBudgetInstructions: JupIx[]; setupInstructions: JupIx[]; swapInstruction: JupIx; cleanupInstruction?: JupIx | null; otherInstructions?: JupIx[]; addressLookupTableAddresses: string[]; error?: string }

export async function jupQuote(p: { inputMint: string; outputMint: string; amount: bigint; slippageBps: number; signal?: AbortSignal }): Promise<JupQuote> {
  const u = new URL(JUPITER + '/swap/v1/quote')
  u.searchParams.set('inputMint', p.inputMint); u.searchParams.set('outputMint', p.outputMint); u.searchParams.set('amount', p.amount.toString()); u.searchParams.set('slippageBps', String(p.slippageBps)); u.searchParams.set('swapMode', 'ExactIn')
  const r = await fetch(u, { signal: p.signal })
  const j = (await r.json()) as JupQuote & { error?: string }
  if (!r.ok || j.error) throw new Error(j.error ?? `Jupiter quote failed (${r.status})`)
  return j
}
export async function jupPrices(mints: string[]): Promise<Record<string, { usdPrice: number; liquidity: number }>> {
  const out: Record<string, { usdPrice: number; liquidity: number }> = {}
  for (let i = 0; i < mints.length; i += 50) {
    const r = await fetch(`${JUPITER}/price/v3?ids=${mints.slice(i, i + 50).join(',')}`)
    if (!r.ok) continue
    const j = (await r.json()) as Record<string, { usdPrice?: number; liquidity?: number } | null>
    for (const [k, v] of Object.entries(j)) if (v) out[k] = { usdPrice: v.usdPrice ?? 0, liquidity: v.liquidity ?? 0 }
  }
  return out
}
const toIx = (ix: JupIx) => new TransactionInstruction({ programId: new PublicKey(ix.programId), keys: ix.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })), data: Buffer.from(ix.data, 'base64') })

export const ata = (owner: PublicKey, mint: PublicKey, program = TOKEN_PROGRAM) => PublicKey.findProgramAddressSync([owner.toBuffer(), program.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0]
// Create the fee wallet's USDC account if it does not exist (idempotent), then move the fee there.
export function feeInstructions(payer: PublicKey, feeWallet: PublicKey, amount: bigint): TransactionInstruction[] {
  const mint = new PublicKey(USDC_MINT)
  const from = ata(payer, mint), to = ata(feeWallet, mint)
  const create = new TransactionInstruction({ programId: ATA_PROGRAM, keys: [{ pubkey: payer, isSigner: true, isWritable: true }, { pubkey: to, isSigner: false, isWritable: true }, { pubkey: feeWallet, isSigner: false, isWritable: false }, { pubkey: mint, isSigner: false, isWritable: false }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false }], data: Buffer.from([1]) })
  const data = Buffer.alloc(10); data.writeUInt8(12, 0); data.writeBigUInt64LE(amount, 1); data.writeUInt8(6, 9) // TransferChecked
  const transfer = new TransactionInstruction({ programId: TOKEN_PROGRAM, keys: [{ pubkey: from, isSigner: false, isWritable: true }, { pubkey: mint, isSigner: false, isWritable: false }, { pubkey: to, isSigner: false, isWritable: true }, { pubkey: payer, isSigner: true, isWritable: false }], data })
  return [create, transfer]
}

// One Jupiter swap as instructions, composed into a v0 transaction with the given extra instructions in front.
export async function buildSwapTx(conn: Connection, user: PublicKey, quote: JupQuote, extra: TransactionInstruction[], blockhash: string, extraAfter = false): Promise<VersionedTransaction> {
  const r = await fetch(JUPITER + '/swap/v1/swap-instructions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ quoteResponse: quote, userPublicKey: user.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 1_000_000, priorityLevel: 'medium' } } }) })
  const j = (await r.json()) as JupSwapIxs
  if (!r.ok || j.error) throw new Error(j.error ?? `Jupiter swap failed (${r.status})`)
  const luts = (await Promise.all(j.addressLookupTableAddresses.map((a) => conn.getAddressLookupTable(new PublicKey(a))))).map((x) => x.value).filter((x): x is AddressLookupTableAccount => !!x)
  const swap = [...j.setupInstructions.map(toIx), toIx(j.swapInstruction), ...(j.cleanupInstruction ? [toIx(j.cleanupInstruction)] : []), ...(j.otherInstructions ?? []).map(toIx)]
  const ixs = [...j.computeBudgetInstructions.map(toIx), ...(extraAfter ? [...swap, ...extra] : [...extra, ...swap])]
  const msg = new TransactionMessage({ payerKey: user, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(luts)
  return new VersionedTransaction(msg)
}

export type Leg = { mint: string; symbol: string; decimals: number; quote: JupQuote }
// Quote every leg of a buy: USDC split equally, or by the weights given.
export async function quoteBuyLegs(stocks: { mint: string; symbol: string; decimals: number }[], usdc: bigint, slippageBps: number, signal?: AbortSignal): Promise<Leg[]> {
  const per = usdc / BigInt(stocks.length)
  return Promise.all(stocks.map(async (s) => ({ ...s, quote: await jupQuote({ inputMint: USDC_MINT, outputMint: s.mint, amount: per, slippageBps, signal }) })))
}
export async function quoteSellLegs(held: { mint: string; symbol: string; decimals: number; amount: bigint }[], slippageBps: number, signal?: AbortSignal): Promise<Leg[]> {
  return Promise.all(held.filter((h) => h.amount > 0n).map(async (s) => ({ mint: s.mint, symbol: s.symbol, decimals: s.decimals, quote: await jupQuote({ inputMint: s.mint, outputMint: USDC_MINT, amount: s.amount, slippageBps, signal }) })))
}
// All the transactions of a basket trade, ready to sign. On a buy the fee rides in front of each leg (or the first leg);
// on a sell it rides behind each leg, paid out of the guaranteed minimum USDC that leg produces.
export async function buildLegTxs(conn: Connection, user: PublicKey, legs: Leg[], fee: { wallet: PublicKey; amount?: bigint; amounts?: bigint[] } | undefined, feeAt: 'first' | 'last' | 'each-first' | 'each-last' = 'first'): Promise<{ txs: VersionedTransaction[]; blockhash: string; lastValidBlockHeight: number }> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed')
  const txs: VersionedTransaction[] = []
  const after = feeAt === 'last' || feeAt === 'each-last'
  for (let i = 0; i < legs.length; i++) {
    const legAmt = fee?.amounts ? (fee.amounts[i] ?? 0n) : (fee && ((feeAt === 'first' && i === 0) || (feeAt === 'last' && i === legs.length - 1)) ? (fee.amount ?? 0n) : 0n)
    const feeIx = fee && legAmt > 0n ? feeInstructions(user, fee.wallet, legAmt) : []
    txs.push(await buildSwapTx(conn, user, legs[i].quote, feeIx, blockhash, after))
  }
  return { txs, blockhash, lastValidBlockHeight }
}
// Send every signed transaction at once (they share a blockhash, so waiting in between would risk expiry), then
// poll for each in order. Public RPCs do not all open websockets, so no subscriptions.
export async function sendAll(conn: Connection, txs: VersionedTransaction[], lastValidBlockHeight: number, onLanded: (i: number, sig: string) => void): Promise<string[]> {
  const sigs: string[] = []
  for (const tx of txs) sigs.push(await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3, preflightCommitment: 'confirmed' }))
  const landed = new Set<number>()
  for (;;) {
    await new Promise((r) => setTimeout(r, 1500))
    const st = (await conn.getSignatureStatuses(sigs)).value
    st.forEach((x, i) => {
      if (landed.has(i)) return
      if (x?.err) throw new Error(`Leg ${i + 1} (${sigs[i].slice(0, 8)}…) failed on chain: ${JSON.stringify(x.err)}`)
      if (x && (x.confirmationStatus === 'confirmed' || x.confirmationStatus === 'finalized')) { landed.add(i); onLanded(i, sigs[i]) }
    })
    if (landed.size === sigs.length) return sigs
    if ((await conn.getBlockHeight('confirmed')) > lastValidBlockHeight) throw new Error(`${sigs.length - landed.size} of ${sigs.length} legs expired before confirmation; nothing moved on those.`)
  }
}
// Token balances of a wallet for the mints given, read from their associated token accounts (xStocks live under
// Token-2022, USDC under the classic Token program). Public RPCs block getTokenAccountsByOwner; this they allow.
export async function readTokenBalances(conn: Connection, owner: PublicKey, mints: { mint: string; program2022: boolean }[]): Promise<Record<string, bigint>> {
  const out: Record<string, bigint> = {}
  const addrs = mints.map((m) => ata(owner, new PublicKey(m.mint), m.program2022 ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM))
  for (let i = 0; i < addrs.length; i += 8) { // public RPCs cap getMultipleAccounts around ten
    const r = await conn.getMultipleAccountsInfo(addrs.slice(i, i + 8))
    r.forEach((a, k) => { const m = mints[i + k]; out[m.mint] = a && a.data.length >= 72 ? a.data.readBigUInt64LE(64) : 0n })
  }
  return out
}
