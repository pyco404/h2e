/**
 * Generate a few synthetic-but-real CoinConfig accounts so the app's Explore /
 * coin / My-coins pages have coins to show WITHOUT a DBC launch (which needs the
 * cloned rail + egress). Each is a real on-chain account owned by the H2E program,
 * decoded by the same client the app uses — only the DBC pool behind it is fake.
 * Fed to solana-test-validator via --account.
 */
import { PublicKey, Keypair } from '@solana/web3.js'
import { PROGRAM_ID, encodeCoinConfig, BN } from '../client'
import { deriveMintMetadata } from '@meteora-ag/dynamic-bonding-curve-sdk'
import * as fs from 'fs'
import * as path from 'path'

const creator = new PublicKey(process.argv[2] || '11111111111111111111111111111111')
const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
const NVDA = new PublicKey('Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh')
const WSOL = new PublicKey('So11111111111111111111111111111111111111112')

const METAPLEX = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s')

/** Minimal Metaplex MetadataV1: key + update_authority + mint + name/symbol/uri
 *  borsh strings. That prefix is all any reader needs for name/symbol/uri, and it
 *  is what makes the app's Explore cards show a real name and ticker offline. */
function metadataAccount(mint: PublicKey, name: string, symbol: string, uri: string) {
  const str = (v: string) => { const b = Buffer.from(v, 'utf8'); const len = Buffer.alloc(4); len.writeUInt32LE(b.length); return Buffer.concat([len, b]) }
  const data = Buffer.concat([
    Buffer.from([4]), METAPLEX.toBuffer(), mint.toBuffer(),
    str(name), str(symbol), str(uri),
    Buffer.alloc(2),      // seller_fee_basis_points
    Buffer.from([0]),     // creators: Option::None
    Buffer.alloc(64),     // trailing optionals, all None/zero
  ])
  return {
    pubkey: deriveMintMetadata(mint).toBase58(),
    account: { lamports: 5_616_720, data: [data.toString('base64'), 'base64'], owner: METAPLEX.toBase58(), executable: false, rentEpoch: 0 },
  }
}

const dir = 'scripts/.demo-coins'
fs.rmSync(dir, { recursive: true, force: true })
fs.mkdirSync(dir, { recursive: true })

const now = Math.floor(Date.now() / 1000)
const coins = [
  { name: 'Correy the Cat', symbol: 'CORREY', payout: USDC, ageH: 30 },
  { name: 'Nvidia Holders', symbol: 'NVH', payout: NVDA, ageH: 12 },
  { name: 'Sol Maxi', symbol: 'SOLMAX', payout: WSOL, ageH: 3 },
]

async function main() {
  for (const c of coins) {
    const mint = Keypair.generate()
    const [pda, bump] = PublicKey.findProgramAddressSync([Buffer.from('coin'), mint.publicKey.toBuffer()], PROGRAM_ID)
    const cc = {
      mint: mint.publicKey, dbc_pool: Keypair.generate().publicKey, damm_pool: null, locked_position: null,
      creator_wallet: creator, default_payout_mint: c.payout, launch_ts: new BN(now - c.ageH * 3600),
      current_epoch: 0, total_claimed: new BN(0), total_paid_out: new BN(0), status: { Bonding: {} }, bump,
    }
    const enc = await encodeCoinConfig(cc)
    const data = Buffer.concat([enc, Buffer.alloc(Math.max(0, 8 + 224 - enc.length))])
    const acct = { pubkey: pda.toBase58(), account: { lamports: 5_000_000, data: [data.toString('base64'), 'base64'], owner: PROGRAM_ID.toBase58(), executable: false, rentEpoch: 0 } }
    fs.writeFileSync(path.join(dir, `${c.symbol}.acct.json`), JSON.stringify(acct))
    const md = metadataAccount(mint.publicKey, c.name, c.symbol, '')
    fs.writeFileSync(path.join(dir, `${c.symbol}.meta.acct.json`), JSON.stringify(md))
    console.log(`${c.symbol.padEnd(7)} mint ${mint.publicKey.toBase58()}  coinConfig ${pda.toBase58()}  metadata ${md.pubkey}`)
  }
}
main()
