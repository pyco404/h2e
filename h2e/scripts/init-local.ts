/**
 * One-time local init so the app (localhost:5178, RPC 127.0.0.1:8899) loads:
 * creates GlobalConfig + PlatformAllowlist and adds the initial payout assets.
 * admin = keeper = platform_wallet = the deployer wallet, for a local demo.
 */
import { Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import * as fs from 'fs'
import { initializeGlobalIx, initPlatformAllowlistIx, setPlatformAllowlistIx, pdas, BN, WSOL_MINT } from '../client'

const RPC = 'http://127.0.0.1:8899'
const conn = new Connection(RPC, 'confirmed')
const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.HOME + '/.config/solana/id.json', 'utf8'))))
const CONFIG = new PublicKey('CKpkBHBdts4P97hiUCQJWVC2rQrJ6sfDQX7xcDSoR6VS')
const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
const NVDA = new PublicKey('Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh')
const AAPL = new PublicKey('XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp')

async function send(ixs: any[]): Promise<string> {
  const { blockhash } = await conn.getLatestBlockhash()
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: wallet.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message())
  tx.sign([wallet]); const sig = await conn.sendTransaction(tx); await conn.confirmTransaction(sig, 'confirmed'); return sig
}

;(async () => {
  if (!(await conn.getAccountInfo(pdas.global()))) {
    await send([initializeGlobalIx({
      admin: wallet.publicKey, keeper: wallet.publicKey, platform_wallet: wallet.publicKey,
      platform_config_key: CONFIG, usdc_mint: USDC,
      holder_bps: 6000, h2e_bps: 3000, platform_bps: 1000, dev_buy_cap_bps: 300, holder_cap_bps: 300,
      epoch_seconds: new BN(86400), h2e_epoch_seconds: new BN(604800), max_slippage_bps: 100,
      min_sweep_lamports: new BN(1_000_000), pool_creation_fee_lamports: new BN(0), paused: false, pause_launches: false,
    }, wallet.publicKey)])
    console.log('✓ GlobalConfig initialized')
  } else console.log('· GlobalConfig already present')

  if (!(await conn.getAccountInfo(pdas.platformAllowlist()))) {
    await send([initPlatformAllowlistIx(wallet.publicKey)]); console.log('✓ PlatformAllowlist created')
  } else console.log('· PlatformAllowlist already present')

  for (const [name, m] of [['USDC', USDC], ['WSOL', WSOL_MINT], ['NVDAx', NVDA], ['AAPLx', AAPL]] as [string, PublicKey][]) {
    await send([setPlatformAllowlistIx(m, true, wallet.publicKey)]); console.log(`✓ allowlisted ${name}`)
  }
  console.log('\nDONE — reload http://localhost:5178/#/launch')
})().catch((e) => { console.error('init failed:', e.message || e); process.exit(1) })
