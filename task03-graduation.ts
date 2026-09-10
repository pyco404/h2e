/**
 * Task 0.3 — graduation to DAMM v2 and locked-LP fee claiming.
 *
 * Reuses the config-key + global ["fee"] PDA pattern from Task 0.2. Proves:
 *   1. The partner's migrated LP position is permanently locked but its trading
 *      fees are claimable, and the SAME global PDA can claim them via CPI.
 *   2. How graduation is detected on-chain (pool.migrationProgress / isMigrated).
 *   3. collectFeeMode quote-only holds pre- and post-migration.
 *
 * Devnet, Helius RPC. Every keypair persisted before funding.
 */

import {
    Connection, Keypair, PublicKey, SystemProgram, Transaction,
    TransactionInstruction, LAMPORTS_PER_SOL, sendAndConfirmTransaction,
    ComputeBudgetProgram,
} from '@solana/web3.js'
import {
    getAssociatedTokenAddressSync,
    createAssociatedTokenAccountIdempotentInstruction,
    getAccount, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token'
import BN from 'bn.js'
import fs from 'fs'
import crypto from 'crypto'
import {
    DynamicBondingCurveClient, buildCurve, deriveDbcPoolAddress,
    BaseFeeMode, CollectFeeMode, ActivationType, MigrationOption,
    MigrationFeeOption, TokenType, TokenDecimal, TokenAuthorityOption, SwapMode,
    DAMM_V2_MIGRATION_FEE_ADDRESS, deriveDammV2PoolAddress,
    deriveDammV2TokenVaultAddress, deriveDammV2PoolAuthority,
    deriveDammV2EventAuthority, derivePositionAddress, derivePositionNftAccount,
    deriveDammV2MigrationMetadataAddress,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import { CpAmm } from '@meteora-ag/cp-amm-sdk'

// --------------------------------------------------------------------------
const RPC = process.env.HELIUS_RPC_URL
if (!RPC || !RPC.includes('helius')) throw new Error('set HELIUS_RPC_URL')

const H2E_PROGRAM_ID = new PublicKey(fs.readFileSync('./.program-id', 'utf8').trim())
const DBC_PROGRAM_ID = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN')
const NATIVE_SOL = new PublicKey('So11111111111111111111111111111111111111112')
const KEY_DIR = './wallets/task03'

// migrationFeeOption 2 -> FixedBps100 -> DAMM v2 config for the migrated pool.
const MIGRATION_FEE_OPTION = MigrationFeeOption.FixedBps100 // = 2
const DAMM_V2_CONFIG = DAMM_V2_MIGRATION_FEE_ADDRESS[MIGRATION_FEE_OPTION]

// Low threshold so the pool graduates inside a short devnet run.
const MIGRATION_QUOTE_THRESHOLD_SOL = 0.5

const CLIFF_FEE_NUMERATOR = new BN(100_000_000)
const FIRST_FACTOR = 30
const SECOND_FACTOR = new BN(10)
const THIRD_FACTOR = new BN(522)
const BASE_FEE_MODE = BaseFeeMode.FeeSchedulerExponential

// --------------------------------------------------------------------------
let stepNo = 0
function header(t: string) {
    stepNo++
    console.log('\n' + '='.repeat(78))
    console.log(`STEP ${stepNo}: ${t}`)
    console.log('='.repeat(78))
}
const explorer = (s: string) => `https://solscan.io/tx/${s}?cluster=devnet`

function persisted(name: string): Keypair {
    const p = `${KEY_DIR}/${name}.json`
    if (fs.existsSync(p)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, 'utf8'))))
    const kp = Keypair.generate()
    fs.mkdirSync(KEY_DIR, { recursive: true })
    fs.writeFileSync(p, JSON.stringify(Array.from(kp.secretKey)))
    return kp
}
function load(path: string): Keypair {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path, 'utf8'))))
}

async function retry<T>(label: string, fn: () => Promise<T>): Promise<T> {
    let last: any
    for (let i = 1; i <= 6; i++) {
        try { return await fn() } catch (e: any) {
            last = e
            const m = String(e?.message ?? '') + String(e?.cause?.code ?? '')
            if (!/fetch failed|TIMEOUT|ECONNRESET|socket hang up|502|503|429/.test(m)) throw e
            console.log(`  [rpc:${label}] transient, retry ${i}/6`)
            await new Promise(r => setTimeout(r, 800))
        }
    }
    throw last
}

async function send(conn: Connection, tx: Transaction, signers: Keypair[], label: string): Promise<string> {
    let last: any
    for (let i = 1; i <= 4; i++) {
        try {
            const { blockhash } = await retry('blockhash', () => conn.getLatestBlockhash('finalized'))
            tx.recentBlockhash = blockhash
            tx.feePayer = signers[0].publicKey
            tx.signatures = []
            const sig = await sendAndConfirmTransaction(conn, tx, signers, { commitment: 'confirmed' })
            console.log(`  tx [${label}]: ${sig}`)
            console.log(`     ${explorer(sig)}`)
            return sig
        } catch (e: any) {
            last = e
            const m = String(e?.message ?? '')
            if (!m.includes('Blockhash not found') && !m.includes('block height exceeded')) throw e
            console.log(`  [${label}] blockhash stale, retry ${i}/4`)
        }
    }
    throw last
}

const disc = (n: string) => crypto.createHash('sha256').update(`global:${n}`).digest().subarray(0, 8)
const PROGRESS = ['PreBondingCurve', 'PostBondingCurve', 'LockedVesting', 'CreatedPool']

// --------------------------------------------------------------------------
async function main() {
    const conn = new Connection(RPC, 'confirmed')
    const client = DynamicBondingCurveClient.create(conn, 'confirmed')
    const cpAmm = new CpAmm(conn)
    const payer = load('./wallets/payer.json')

    console.log(`payer       : ${payer.publicKey.toBase58()}`)
    console.log(`balance     : ${(await retry('bal', () => conn.getBalance(payer.publicKey))) / LAMPORTS_PER_SOL} SOL`)
    console.log(`h2e program : ${H2E_PROGRAM_ID.toBase58()}`)

    const [feePda, feeBump] = PublicKey.findProgramAddressSync([Buffer.from('fee')], H2E_PROGRAM_ID)
    const [dbcEventAuthority] = PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], DBC_PROGRAM_ID)
    console.log(`global PDA   : ${feePda.toBase58()} (bump ${feeBump})`)
    console.log(`DAMM v2 cfg  : ${DAMM_V2_CONFIG.toBase58()} (migrationFeeOption=${MIGRATION_FEE_OPTION})`)

    // ---------------------------------------------------------------------
    header('Create config: low migrationQuoteThreshold, migrationFeeOption=2, quote-only')
    console.log(`migrationQuoteThreshold = ${MIGRATION_QUOTE_THRESHOLD_SOL} SOL`)
    console.log('  reason: low enough to graduate within a short devnet run on a funded trader,')
    console.log('  while still a valid curve. Quote raised becomes locked DAMM liquidity.')

    const configKp = persisted('config')
    if (!(await retry('cfg?', () => conn.getAccountInfo(configKp.publicKey)))) {
        const curve = buildCurve({
            token: {
                tokenType: TokenType.SPLToken, tokenBaseDecimal: TokenDecimal.SIX,
                tokenQuoteDecimal: TokenDecimal.NINE, tokenAuthorityOption: TokenAuthorityOption.Immutable,
                totalTokenSupply: 1_000_000_000, leftover: 0,
            },
            fee: {
                baseFeeParams: {
                    baseFeeMode: BASE_FEE_MODE,
                    feeSchedulerParam: { startingFeeBps: 1000, endingFeeBps: 200, numberOfPeriod: FIRST_FACTOR, totalDuration: 300 },
                },
                dynamicFeeEnabled: false,
                collectFeeMode: CollectFeeMode.QuoteToken, // quote-only
                creatorTradingFeePercentage: 0, poolCreationFee: 0, enableFirstSwapWithMinFee: false,
            },
            migration: {
                migrationOption: MigrationOption.MET_DAMM_V2, // DAMM v2
                migrationFeeOption: MIGRATION_FEE_OPTION,     // FixedBps100 = 1% migrated pool fee
                migrationFee: { feePercentage: 0, creatorFeePercentage: 0 }, // no one-time fee
            },
            liquidityDistribution: {
                partnerPermanentLockedLiquidityPercentage: 100, // partner gets the locked position
                partnerLiquidityPercentage: 0,
                creatorPermanentLockedLiquidityPercentage: 0, creatorLiquidityPercentage: 0,
            },
            lockedVesting: {
                totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0,
                totalVestingDuration: 0, cliffDurationFromMigrationTime: 0,
            },
            activationType: ActivationType.Timestamp,
            percentageSupplyOnMigration: 20,
            migrationQuoteThreshold: MIGRATION_QUOTE_THRESHOLD_SOL,
        })
        curve.poolFees.baseFee = {
            cliffFeeNumerator: CLIFF_FEE_NUMERATOR, firstFactor: FIRST_FACTOR,
            secondFactor: SECOND_FACTOR, thirdFactor: THIRD_FACTOR, baseFeeMode: BASE_FEE_MODE,
        } as any
        curve.poolFees.dynamicFee = null
        const tx = await client.partner.createConfig({
            config: configKp.publicKey, feeClaimer: feePda, leftoverReceiver: payer.publicKey,
            quoteMint: NATIVE_SOL, payer: payer.publicKey, ...curve,
        })
        await send(conn, tx, [payer, configKp], 'createConfig')
    } else console.log('  config exists, reusing')

    const cfg = await retry('cfg', () => client.state.getPoolConfig(configKp.publicKey))
    console.log(`\nconfig key                  : ${configKp.publicKey.toBase58()}`)
    console.log(`feeClaimer == global PDA    : ${cfg.feeClaimer.equals(feePda)}`)
    console.log(`collectFeeMode              : ${cfg.collectFeeMode} (0=QuoteToken/quote-only)`)
    console.log(`migrationOption             : ${cfg.migrationOption} (1=DAMM v2)`)
    console.log(`migrationFeeOption          : ${cfg.migrationFeeOption}`)
    console.log(`migratedCollectFeeMode      : ${cfg.migratedCollectFeeMode} (DBC 0=QuoteToken -> DAMM v2 OnlyB=quote-only)`)
    console.log(`migratedPoolFeeBps          : ${cfg.migratedPoolFeeBps}`)
    console.log(`migrationQuoteThreshold     : ${cfg.migrationQuoteThreshold.toString()} lamports`)

    // ---------------------------------------------------------------------
    header('Resolved post-migration fee')
    console.log(`migrationFeeOption ${MIGRATION_FEE_OPTION} = FixedBps100 => migrated DAMM v2 pool trades at 100 bps (1%).`)
    console.log(`(one-time migration liquidity fee = ${cfg.migrationFeePercentage ?? 0}%)`)

    // ---------------------------------------------------------------------
    header('collectFeeMode quote-only?')
    console.log('YES. DBC collectFeeMode has QuoteToken(0) and OutputToken(1); we use QuoteToken.')
    console.log('Post-migration: migratedCollectFeeMode QuoteToken(0) maps to DAMM v2 collect_fee_mode OnlyB(1).')
    console.log('Expect partner_base_fee to stay 0 throughout. Verified during trading below.')

    // ---------------------------------------------------------------------
    header('Create pool')
    const mint = persisted('mint')
    const poolAddr = deriveDbcPoolAddress(NATIVE_SOL, mint.publicKey, configKp.publicKey)
    if (!(await retry('pool?', () => conn.getAccountInfo(poolAddr)))) {
        const tx = await client.creator.createPool({
            config: configKp.publicKey, baseMint: mint.publicKey,
            name: 'H2E Grad', symbol: 'H2EG', uri: 'https://example.com/h2e.json',
            payer: payer.publicKey, poolCreator: payer.publicKey,
        })
        await send(conn, tx, [payer, mint], 'createPool')
    } else console.log('  pool exists, reusing')
    console.log(`\npool : ${poolAddr.toBase58()}`)
    console.log(`mint : ${mint.publicKey.toBase58()}`)

    // ---------------------------------------------------------------------
    header('Trade until the bonding curve completes (watch migrationProgress)')
    const trader = load('./wallets/trader.json')
    const NEED = 0.9 * LAMPORTS_PER_SOL
    const tbal = await retry('tbal', () => conn.getBalance(trader.publicKey))
    if (tbal < NEED) {
        const top = NEED - tbal
        await send(conn, new Transaction().add(SystemProgram.transfer({
            fromPubkey: payer.publicKey, toPubkey: trader.publicKey, lamports: top,
        })), [payer], 'fund trader')
    }
    console.log(`trader : ${trader.publicKey.toBase58()}  balance ${(await retry('tbal', () => conn.getBalance(trader.publicKey))) / LAMPORTS_PER_SOL} SOL`)

    const readPool = () => retry('getPool', () => client.state.getPool(poolAddr))
    let st = await readPool()
    let lastProgress = -1
    const showProgress = (s: any, tag: string) => {
        const pr = s.poolState.migrationProgress
        console.log(`  [${tag}] migrationProgress=${pr} (${PROGRESS[pr] ?? '?'})  isMigrated=${s.poolState.isMigrated}  quoteReserve=${s.poolState.quoteReserve.toString()}  partnerQuoteFee=${s.poolState.partnerQuoteFee.toString()}  partnerBaseFee=${s.poolState.partnerBaseFee.toString()}`)
    }
    showProgress(st, 'start')
    lastProgress = st.poolState.migrationProgress

    // DBC exact-input swaps require the whole input to be consumable, so a buy
    // bigger than the curve's remaining capacity reverts with InsufficientLiquidity.
    // Use swap2 in PartialFill mode: it consumes up to capacity and refunds the
    // rest, so a fixed 0.08 SOL buy works every iteration and the last one lands
    // exactly on the migration threshold and completes the curve.
    const BUY = 0.08
    for (let i = 0; i < 30 && st.poolState.migrationProgress === 0; i++) {
        const tx = await client.pool.swap2({
            owner: trader.publicKey, pool: poolAddr, swapBaseForQuote: false,
            referralTokenAccount: null, swapMode: SwapMode.PartialFill,
            amountIn: new BN(Math.round(BUY * LAMPORTS_PER_SOL)), minimumAmountOut: new BN(0),
        })
        await send(conn, tx, [trader], `partialFill buy ${BUY} #${i + 1}`)
        st = await readPool()
        if (st.poolState.migrationProgress !== lastProgress) {
            console.log(`  >>> STATE TRANSITION: ${PROGRESS[lastProgress]} -> ${PROGRESS[st.poolState.migrationProgress]}`)
            lastProgress = st.poolState.migrationProgress
        }
        showProgress(st, `after buy ${i + 1}`)
    }
    if (st.poolState.migrationProgress === 0) throw new Error('curve did not complete within budget')
    console.log(`\ncurve complete. partnerBaseFee during bonding = ${st.poolState.partnerBaseFee.toString()} (expect 0)`)

    // ---------------------------------------------------------------------
    header('Migrate to DAMM v2')

    // 6a. create migration metadata (no SDK wrapper in 1.5.11; build raw).
    const migrationMetadata = deriveDammV2MigrationMetadataAddress(poolAddr)
    const metaExists = await retry('meta?', () => conn.getAccountInfo(migrationMetadata))
    if (!metaExists) {
        const keys = [
            { pubkey: poolAddr, isSigner: false, isWritable: false },
            { pubkey: configKp.publicKey, isSigner: false, isWritable: false },
            { pubkey: migrationMetadata, isSigner: false, isWritable: true },
            { pubkey: payer.publicKey, isSigner: true, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: dbcEventAuthority, isSigner: false, isWritable: false },
            { pubkey: DBC_PROGRAM_ID, isSigner: false, isWritable: false },
        ]
        const ix = new TransactionInstruction({
            programId: DBC_PROGRAM_ID, keys,
            data: Buffer.from([109, 189, 19, 36, 195, 183, 222, 82]), // migration_damm_v2_create_metadata
        })
        await send(conn, new Transaction().add(ix), [payer], 'createDammV2Metadata')
    } else console.log('  migration metadata exists, reusing')
    console.log(`migration metadata : ${migrationMetadata.toBase58()}`)

    // 6b. migrate (SDK builds the tx + returns the position NFT keypairs).
    const dammPool = deriveDammV2PoolAddress(DAMM_V2_CONFIG, mint.publicKey, NATIVE_SOL)
    const alreadyMigrated = await retry('damm?', () => conn.getAccountInfo(dammPool))
    let firstPositionNft: PublicKey
    const nftPath = `${KEY_DIR}/first-position-nft.json`
    if (!alreadyMigrated) {
        const { transaction, firstPositionNftKeypair, secondPositionNftKeypair } =
            await client.migration.migrateToDammV2({ pool: poolAddr, dammConfig: DAMM_V2_CONFIG, payer: payer.publicKey })
        fs.writeFileSync(nftPath, JSON.stringify(Array.from(firstPositionNftKeypair.secretKey)))
        fs.writeFileSync(`${KEY_DIR}/second-position-nft.json`, JSON.stringify(Array.from(secondPositionNftKeypair.secretKey)))
        firstPositionNft = firstPositionNftKeypair.publicKey
        await send(conn, transaction, [payer, firstPositionNftKeypair, secondPositionNftKeypair], 'migrateToDammV2')
    } else {
        firstPositionNft = load(nftPath).publicKey
        console.log('  DAMM v2 pool exists, reusing')
    }

    st = await readPool()
    console.log(`\nafter migration: migrationProgress=${st.poolState.migrationProgress} (${PROGRESS[st.poolState.migrationProgress]})  isMigrated=${st.poolState.isMigrated}`)
    console.log(`DAMM v2 pool : ${dammPool.toBase58()}`)

    // ---------------------------------------------------------------------
    header('Locked LP position: address, owner, locked/claimable/vesting split')
    const firstPosition = derivePositionAddress(firstPositionNft)
    const firstPositionNftAccount = derivePositionNftAccount(firstPositionNft)
    console.log(`first position NFT mint    : ${firstPositionNft.toBase58()}`)
    console.log(`first position            : ${firstPosition.toBase58()}`)
    console.log(`first position NFT account: ${firstPositionNftAccount.toBase58()}`)

    const nftAcc = await retry('nftAcc', () => getAccount(conn, firstPositionNftAccount, undefined, TOKEN_2022_PROGRAM_ID))
    console.log(`NFT account owner         : ${nftAcc.owner.toBase58()}`)
    console.log(`  == global PDA ?         : ${nftAcc.owner.equals(feePda)}`)

    const pos = await retry('pos', () => cpAmm.fetchPositionState(firstPosition))
    console.log(`permanent_locked_liquidity: ${pos.permanentLockedLiquidity.toString()}`)
    console.log(`unlocked_liquidity        : ${pos.unlockedLiquidity.toString()}`)
    console.log(`vested_liquidity          : ${pos.vestedLiquidity.toString()}`)
    console.log(`fee_a_pending (base)      : ${pos.feeAPending.toString()}`)
    console.log(`fee_b_pending (quote)     : ${pos.feeBPending.toString()}`)

    // ---------------------------------------------------------------------
    header('Trade against the migrated DAMM v2 pool to generate post-graduation fees')
    const dammState = await retry('dammState', () => cpAmm.fetchPoolState(dammPool))
    for (let i = 0; i < 3; i++) {
        const inAmount = new BN(Math.round(0.05 * LAMPORTS_PER_SOL))
        const quote = await retry('quote', async () => cpAmm.getQuote({
            inAmount, inputTokenMint: NATIVE_SOL, slippage: 50,
            poolState: dammState, currentTime: Math.floor(Date.now() / 1000), currentSlot: await conn.getSlot(),
            tokenADecimal: 6, tokenBDecimal: 9,
        }))
        const swapTx = await cpAmm.swap({
            payer: trader.publicKey, pool: dammPool, inputTokenMint: NATIVE_SOL,
            outputTokenMint: mint.publicKey, amountIn: inAmount,
            minimumAmountOut: new BN(1), tokenAMint: mint.publicKey, tokenBMint: NATIVE_SOL,
            tokenAVault: deriveDammV2TokenVaultAddress(dammPool, mint.publicKey),
            tokenBVault: deriveDammV2TokenVaultAddress(dammPool, NATIVE_SOL),
            tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID,
            referralTokenAccount: null,
        })
        await send(conn, swapTx as unknown as Transaction, [trader], `DAMM swap #${i + 1} (0.05 SOL)`)
    }

    const posAfter = await retry('pos2', () => cpAmm.fetchPositionState(firstPosition))
    console.log(`\nposition fee_a_pending (base)  : ${posAfter.feeAPending.toString()}  (expect 0 under quote-only)`)
    console.log(`position fee_b_pending (quote) : ${posAfter.feeBPending.toString()}  <- claimable WSOL`)
    console.log('fees are accounted on the POSITION (fee_b_pending), owned by the global PDA.')

    // ---------------------------------------------------------------------
    header('Claim locked-LP fees via our program, signing as the global PDA')
    const receiver = persisted('lp-fee-receiver')
    const rBase = getAssociatedTokenAddressSync(mint.publicKey, receiver.publicKey)
    const rQuote = getAssociatedTokenAddressSync(NATIVE_SOL, receiver.publicKey)
    console.log(`receiver         : ${receiver.publicKey.toBase58()}`)
    console.log(`receiver quote ATA: ${rQuote.toBase58()}`)
    await send(conn, new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, rBase, receiver.publicKey, mint.publicKey),
        createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, rQuote, receiver.publicKey, NATIVE_SOL),
    ), [payer], 'create receiver ATAs')

    const dammPoolAuthority = deriveDammV2PoolAuthority()
    const dammEventAuthority = deriveDammV2EventAuthority()
    const tokenAVault = deriveDammV2TokenVaultAddress(dammPool, mint.publicKey)
    const tokenBVault = deriveDammV2TokenVaultAddress(dammPool, NATIVE_SOL)

    const balBefore = async (a: PublicKey) => { try { return (await getAccount(conn, a)).amount } catch { return 0n } }
    const qBefore = await balBefore(rQuote)
    const feeBefore = (await retry('pos3', () => cpAmm.fetchPositionState(firstPosition))).feeBPending
    console.log(`\nbefore: receiver WSOL=${qBefore}  position fee_b_pending=${feeBefore.toString()}`)

    const keys = [
        { pubkey: feePda, isSigner: false, isWritable: false },
        { pubkey: dammPoolAuthority, isSigner: false, isWritable: false },
        { pubkey: dammPool, isSigner: false, isWritable: false },
        { pubkey: firstPosition, isSigner: false, isWritable: true },
        { pubkey: rBase, isSigner: false, isWritable: true },
        { pubkey: rQuote, isSigner: false, isWritable: true },
        { pubkey: tokenAVault, isSigner: false, isWritable: true },
        { pubkey: tokenBVault, isSigner: false, isWritable: true },
        { pubkey: mint.publicKey, isSigner: false, isWritable: false },
        { pubkey: NATIVE_SOL, isSigner: false, isWritable: false },
        { pubkey: firstPositionNftAccount, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: dammEventAuthority, isSigner: false, isWritable: false },
        { pubkey: new PublicKey('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG'), isSigner: false, isWritable: false },
    ]
    const claimIx = new TransactionInstruction({ programId: H2E_PROGRAM_ID, keys, data: disc('claim_locked_lp_fees') })
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), claimIx)
    await send(conn, tx, [payer], 'claim_locked_lp_fees')

    const qAfter = await balBefore(rQuote)
    const feeAfter = (await retry('pos4', () => cpAmm.fetchPositionState(firstPosition))).feeBPending
    console.log(`\nafter : receiver WSOL=${qAfter}  position fee_b_pending=${feeAfter.toString()}`)
    console.log(`claimed to receiver: ${(qAfter - qBefore).toString()} lamports WSOL`)
    console.log(`claimed == fee_b_pending before ? ${(qAfter - qBefore).toString() === feeBefore.toString()}`)

    header('SUMMARY')
    console.log(`config key        : ${configKp.publicKey.toBase58()}`)
    console.log(`DBC pool          : ${poolAddr.toBase58()}`)
    console.log(`DAMM v2 pool      : ${dammPool.toBase58()}`)
    console.log(`locked position   : ${firstPosition.toBase58()} (owner = global PDA ${feePda.toBase58()})`)
    console.log(`post-grad fee claimed to receiver: ${(qAfter - qBefore).toString()} lamports`)
}

main().catch(e => {
    console.error('\n!!! FATAL !!!'); console.error(e)
    const logs = e?.logs ?? e?.transactionLogs
    if (logs) console.error('logs:\n' + logs.join('\n'))
    process.exit(1)
})
