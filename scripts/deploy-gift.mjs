// Deploys VerdexGift (Gift a stock) on Robinhood Chain from the executor wallet (EXECUTOR_KEY env or executor.key).
// The contract has no owner and no admin, so nothing is handed over. Usage: node scripts/deploy-gift.mjs [--dry]
import { readFileSync } from 'node:fs'
import { createPublicClient, createWalletClient, http, formatEther, getContractAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
const dry = process.argv.includes('--dry')
const key = (process.env.EXECUTOR_KEY || readFileSync(new URL('../executor.key', import.meta.url), 'utf8')).trim()
const account = privateKeyToAccount(key)
const ART = JSON.parse(readFileSync(new URL('../contracts/VerdexGift.json', import.meta.url)))
const rh = { id: 4663, name: 'Robinhood Chain', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [process.env.RPC || 'https://rpc.mainnet.chain.robinhood.com/'] } } }
const pub = createPublicClient({ chain: rh, transport: http() })
const wal = createWalletClient({ account, chain: rh, transport: http() })
const nonce = await pub.getTransactionCount({ address: account.address })
console.log('deployer', account.address, 'ETH', formatEther(await pub.getBalance({ address: account.address })), 'will deploy at', getContractAddress({ from: account.address, nonce: BigInt(nonce) }), dry ? '(dry run)' : '')
if (dry) process.exit(0)
const hash = await wal.deployContract({ abi: ART.abi, bytecode: ART.bytecode })
const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 })
console.log('deploy', r.status, hash, r.contractAddress, 'gas', r.gasUsed)
console.log('\nGIFT_ADDRESS =', r.contractAddress, '\nETH left', formatEther(await pub.getBalance({ address: account.address })))
