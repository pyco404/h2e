/**
 * Generate the offline fixtures the swap_payout suite preloads: a synthetic
 * Bonding CoinConfig (so no DBC/network is needed to have a coin) at an old
 * launch_ts, plus its persisted mint keypair. Run before the validator boots;
 * the .acct.json is fed to solana-test-validator via --account.
 */
import { PublicKey, Keypair } from '@solana/web3.js'
import { pdas, PROGRAM_ID, encodeCoinConfig, WSOL_MINT, BN } from '../client'
import fs from 'fs'
import path from 'path'

const dir = 'tests/fixtures/swap'
fs.mkdirSync(dir, { recursive: true })

// Persist the coin mint keypair before anything depends on it.
const mintPath = path.join(dir, 'coin-mint.json')
let mint: Keypair
if (fs.existsSync(mintPath)) {
    mint = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(mintPath, 'utf8'))))
} else {
    mint = Keypair.generate()
    fs.writeFileSync(mintPath, JSON.stringify(Array.from(mint.secretKey)))
}

const [coinPda, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from('coin'), mint.publicKey.toBuffer()], PROGRAM_ID)

async function main() {
    const cc = {
        mint: mint.publicKey,
        dbc_pool: PublicKey.default,
        damm_pool: null,
        locked_position: null,
        creator_wallet: PublicKey.default,
        default_payout_mint: WSOL_MINT, // pairing choice; irrelevant to the swap tests
        launch_ts: new BN(0),         // epoch 0 ended long ago (with epoch_seconds ≥ 1)
        current_epoch: 0,
        total_claimed: new BN(0),
        total_paid_out: new BN(0),
        status: { Bonding: {} },
        bump,
    }
    const encoded = await encodeCoinConfig(cc)
    // Allocate at full INIT_SPACE (8 disc + 224): adds default_payout_mint(32) to
    // the Task 1.9 layout. The fixture encodes Options as None (small);
    // set_graduation later writes Some, which needs the reserved room — so zero-pad
    // to the real account size.
    const INIT = 8 + 224
    const data = Buffer.concat([encoded, Buffer.alloc(Math.max(0, INIT - encoded.length))])
    const acct = {
        pubkey: coinPda.toBase58(),
        account: {
            lamports: 5_000_000,
            data: [data.toString('base64'), 'base64'],
            owner: PROGRAM_ID.toBase58(),
            executable: false,
            rentEpoch: 0,
        },
    }
    fs.writeFileSync(path.join(dir, 'coin.acct.json'), JSON.stringify(acct, null, 2))
    console.log('coin mint   :', mint.publicKey.toBase58())
    console.log('coin_config :', coinPda.toBase58(), 'bump', bump)
    console.log('wrote', path.join(dir, 'coin.acct.json'))
}
main()
