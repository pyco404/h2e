// Generate preloaded EpochState + swapped WSOL BucketState fixtures for the
// distribute_batch tests (no swap_payout in 1.7). Fixed mints => fixed PDAs.
import { PublicKey, Keypair } from '@solana/web3.js'
import fs from 'fs'
import { PROGRAM_ID, pdas, WSOL_MINT, idl, BN } from './client'
import * as anchor from '@coral-xyz/anchor'
const accCoder = new anchor.BorshAccountsCoder(idl)
const DIR = 'tests/fixtures/epoch'
const LAMPORTS = 5_000_000

function persistKp(name: string): Keypair {
    const p = `${DIR}/${name}.json`
    if (fs.existsSync(p)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, 'utf8'))))
    const kp = Keypair.generate(); fs.writeFileSync(p, JSON.stringify(Array.from(kp.secretKey))); return kp
}
function accountJson(pubkey: PublicKey, data: Buffer) {
    return { pubkey: pubkey.toBase58(), account: { lamports: LAMPORTS, data: [data.toString('base64'), 'base64'], owner: PROGRAM_ID.toBase58(), executable: false, rentEpoch: 0 } }
}

// 20 shared recipients, sorted ascending by pubkey
const recipients = Array.from({ length: 20 }, (_, i) => persistKp(`recipient-${i}`)).sort((a, b) => a.publicKey.toBuffer().compare(b.publicKey.toBuffer()))
fs.writeFileSync(`${DIR}/recipients.json`, JSON.stringify(recipients.map(r => r.publicKey.toBase58())))

const cases = [
    { name: 'A', recipientCount: 20, amountOut: 20_000_000 },
    { name: 'B', recipientCount: 20, amountOut: 20_000_000 },
    { name: 'C', recipientCount: 20, amountOut: 20_000_000 },
    { name: 'D', recipientCount: 20, amountOut: 1_000 },
]
async function main() {
const manifest: any = { recipients: recipients.map(r => r.publicKey.toBase58()), cases: {} }
for (const c of cases) {
    const mint = persistKp(`mint-${c.name}`).publicKey
    const [epochPda, epochBump] = PublicKey.findProgramAddressSync([Buffer.from('epoch'), mint.toBuffer(), Buffer.alloc(4)], PROGRAM_ID)
    const [bucketPda, bucketBump] = PublicKey.findProgramAddressSync([Buffer.from('bucket'), mint.toBuffer(), Buffer.alloc(4), WSOL_MINT.toBuffer()], PROGRAM_ID)
    const epoch = await accCoder.encode('EpochState', { mint, epoch_index: 0, start_ts: new BN(0), end_ts: new BN(0), payout_amount: new BN(c.amountOut), total_weight: new BN(0), merkle_root: Array(32).fill(0), bucket_count: 1, buckets_complete: 0, settled: true, bump: epochBump })
    const bucket = await accCoder.encode('BucketState', { epoch: epochPda, out_mint: WSOL_MINT, amount_in: new BN(c.amountOut), amount_out: new BN(c.amountOut), recipient_count: c.recipientCount, cursor: 0, paid_amount: new BN(0), swapped: true, complete: false, bump: bucketBump })
    fs.writeFileSync(`${DIR}/epoch-${c.name}.acct.json`, JSON.stringify(accountJson(epochPda, epoch)))
    fs.writeFileSync(`${DIR}/bucket-${c.name}.acct.json`, JSON.stringify(accountJson(bucketPda, bucket)))
    manifest.cases[c.name] = { mint: mint.toBase58(), epoch: epochPda.toBase58(), bucket: bucketPda.toBase58(), amountOut: c.amountOut, recipientCount: c.recipientCount }
}
fs.writeFileSync(`${DIR}/manifest.json`, JSON.stringify(manifest, null, 2))
console.log('fixtures generated for cases A,B,C,D + 20 recipients')
}
main()
