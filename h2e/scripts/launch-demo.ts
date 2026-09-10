/**
 * Launch a couple of REAL demo coins on the local validator so the app's Explore
 * / coin / My-coins pages have something to show without launching from a browser.
 * Uses the same client builders and DBC rail as the real launch flow.
 */
import {
  Connection, Keypair, PublicKey, TransactionInstruction, TransactionMessage,
  VersionedTransaction, AddressLookupTableProgram, AddressLookupTableAccount, ComputeBudgetProgram,
} from '@solana/web3.js'
import * as fs from 'fs'
import { launchCoinIx, launchCoinAltAddresses, pdas, decodeCoinConfig, BN } from '../client'

const RPC = 'http://127.0.0.1:8899'
const conn = new Connection(RPC, 'confirmed')
const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.HOME + '/.config/solana/id.json', 'utf8'))))
const CONFIG = new PublicKey('CKpkBHBdts4P97hiUCQJWVC2rQrJ6sfDQX7xcDSoR6VS')
const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
const NVDA = new PublicKey('Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh')

async function sendV0(ixs: TransactionInstruction[], signers: Keypair[], alt?: AddressLookupTableAccount): Promise<string> {
  const { blockhash } = await conn.getLatestBlockhash()
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: signers[0].publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(alt ? [alt] : []))
  tx.sign(signers); const sig = await conn.sendTransaction(tx); await conn.confirmTransaction(sig, 'confirmed'); return sig
}
async function warmAlt(addresses: PublicKey[]): Promise<AddressLookupTableAccount> {
  const slot = await conn.getSlot('finalized')
  const [createIx, altAddr] = AddressLookupTableProgram.createLookupTable({ authority: wallet.publicKey, payer: wallet.publicKey, recentSlot: slot })
  await sendV0([createIx], [wallet])
  for (let i = 0; i < addresses.length; i += 18)
    await sendV0([AddressLookupTableProgram.extendLookupTable({ payer: wallet.publicKey, authority: wallet.publicKey, lookupTable: altAddr, addresses: addresses.slice(i, i + 18) })], [wallet])
  let alt: AddressLookupTableAccount | null = null
  for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 400)); alt = (await conn.getAddressLookupTable(altAddr)).value; if (alt && alt.state.addresses.length >= addresses.length) break }
  await new Promise((r) => setTimeout(r, 1200)); return alt!
}

async function launch(name: string, symbol: string, payout: PublicKey) {
  const mint = Keypair.generate()
  const accts = { payer: wallet.publicKey, baseMint: mint.publicKey, config: CONFIG, platformWallet: wallet.publicKey }
  const params = { name, symbol, uri: `https://h2etoken.xyz/meta/${symbol.toLowerCase()}.json`, dev_buy_lamports: new BN(0), default_payout_mint: payout }
  const alt = await warmAlt(launchCoinAltAddresses(accts))
  await sendV0([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), launchCoinIx(params, accts)], [wallet, mint], alt)
  const cc = decodeCoinConfig((await conn.getAccountInfo(pdas.coinConfig(mint.publicKey)))!.data)
  console.log(`✓ launched ${symbol} (${name}) — mint ${mint.publicKey.toBase58()} · status ${Object.keys(cc.status)[0]}`)
  return mint.publicKey
}

;(async () => {
  console.log('launching demo coins on', RPC)
  await launch('Correy the Cat', 'CORREY', USDC)
  await launch('Nvidia Holders', 'NVH', NVDA)
  console.log('\nDONE — open http://localhost:5178/#/coin (Explore) to see them.')
})().catch((e) => { console.error('launch-demo failed:', e.message || e); process.exit(1) })
