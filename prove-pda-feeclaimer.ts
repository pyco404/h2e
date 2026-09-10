/**
 * Task 0.1 — Prove a PDA can be the DBC `feeClaimer`.
 *
 * Devnet feasibility test. No program, no scaffolding.
 *
 * Flow:
 *   1. Derive PDA ["fee", mint] from a placeholder program ID.
 *   2. Create a DBC config key with feeClaimer = that PDA.
 *   3. Create a pool from that config.
 *   4. Buy/sell to generate partner fees.
 *   5. Read back accrued partner fees and confirm the claimer address.
 *   6. Attempt to claim, and characterise exactly how it fails.
 */

import {
    Connection,
    Keypair,
    PublicKey,
    SystemProgram,
    Transaction,
    LAMPORTS_PER_SOL,
    sendAndConfirmTransaction,
} from '@solana/web3.js'
import BN from 'bn.js'
import fs from 'fs'
import {
    DynamicBondingCurveClient,
    buildCurve,
    deriveDbcPoolAddress,
    BaseFeeMode,
    CollectFeeMode,
    ActivationType,
    MigrationOption,
    MigrationFeeOption,
    TokenType,
    TokenDecimal,
    TokenAuthorityOption,
    getBaseFeeNumeratorByPeriod,
} from '@meteora-ag/dynamic-bonding-curve-sdk'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Placeholder for the program that will eventually own the fee PDA. */
const PLACEHOLDER_PROGRAM_ID = new PublicKey(
    'H2E1111111111111111111111111111111111111111'
)

const RPC = 'https://api.devnet.solana.com'

/** Payer / partner / pool-creator wallet. */
const KEYPAIR_PATH = './wallets/payer.json'
const NATIVE_SOL = new PublicKey('So11111111111111111111111111111111111111112')

// Fee scheduler parameters under test (exponential, baseFeeMode = 1).
const CLIFF_FEE_NUMERATOR = new BN(100_000_000) // 10% of 1e9
const FIRST_FACTOR = 30 // numberOfPeriod
const SECOND_FACTOR = new BN(10) // periodFrequency, seconds
const THIRD_FACTOR = new BN(520) // reductionFactor, bps
const BASE_FEE_MODE = BaseFeeMode.FeeSchedulerExponential // 1

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let step = 0
function header(title: string) {
    step++
    console.log('\n' + '='.repeat(74))
    console.log(`STEP ${step}: ${title}`)
    console.log('='.repeat(74))
}

function loadKeypair(path: string): Keypair {
    const raw = JSON.parse(fs.readFileSync(path, 'utf8'))
    return Keypair.fromSecretKey(Uint8Array.from(raw))
}

function explorer(sig: string) {
    return `https://solscan.io/tx/${sig}?cluster=devnet`
}

/**
 * The public devnet RPC intermittently drops connections or serves a stale
 * blockhash. Retry transient transport failures so they cannot abort the run;
 * real program errors surface unchanged.
 */
async function retry<T>(label: string, fn: () => Promise<T>): Promise<T> {
    let lastErr: any
    for (let attempt = 1; attempt <= 5; attempt++) {
        try {
            return await fn()
        } catch (e: any) {
            lastErr = e
            const msg = String(e?.message ?? '') + String(e?.cause?.code ?? '')
            const transient =
                msg.includes('fetch failed') ||
                msg.includes('UND_ERR_CONNECT_TIMEOUT') ||
                msg.includes('ETIMEDOUT') ||
                msg.includes('ECONNRESET') ||
                msg.includes('socket hang up') ||
                msg.includes('502') ||
                msg.includes('503') ||
                msg.includes('429')
            if (!transient) throw e
            console.log(`  [rpc:${label}] transient failure, retry ${attempt}/5`)
        }
    }
    throw lastErr
}

async function send(
    conn: Connection,
    tx: Transaction,
    signers: Keypair[],
    label: string
): Promise<string> {
    // Devnet intermittently returns "Blockhash not found" on an otherwise valid
    // transaction. Retry with a fresh blockhash; any other error is rethrown.
    let lastErr: any
    for (let attempt = 1; attempt <= 4; attempt++) {
        try {
            const { blockhash } = await retry('blockhash', () => conn.getLatestBlockhash('finalized'))
            tx.recentBlockhash = blockhash
            tx.feePayer = signers[0].publicKey
            tx.signatures = []
            const sig = await sendAndConfirmTransaction(conn, tx, signers, {
                commitment: 'confirmed',
                skipPreflight: false,
            })
            console.log(`  tx [${label}]: ${sig}`)
            console.log(`     ${explorer(sig)}`)
            return sig
        } catch (e: any) {
            lastErr = e
            const msg = String(e?.message ?? '')
            if (!msg.includes('Blockhash not found') && !msg.includes('block height exceeded')) {
                throw e
            }
            console.log(`  [${label}] blockhash stale, retry ${attempt}/4`)
        }
    }
    throw lastErr
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
    const conn = new Connection(RPC, 'confirmed')
    const client = DynamicBondingCurveClient.create(conn, 'confirmed')

    const payer = loadKeypair(KEYPAIR_PATH)
    console.log(`payer / partner / creator : ${payer.publicKey.toBase58()}`)
    const payerBal = await retry('getBalance', () => conn.getBalance(payer.publicKey))
    console.log(`payer balance             : ${payerBal / LAMPORTS_PER_SOL} SOL`)
    if (payerBal < 1.0 * LAMPORTS_PER_SOL) {
        throw new Error('payer needs at least 1.0 devnet SOL')
    }

    // -----------------------------------------------------------------------
    header('Derive fee PDA from ["fee", <mint>]')

    // The mint has to exist as a keypair before the config, because the PDA
    // is seeded by it and the config stores the feeClaimer.
    const baseMint = Keypair.generate()
    const [feePda, feeBump] = PublicKey.findProgramAddressSync(
        [Buffer.from('fee'), baseMint.publicKey.toBuffer()],
        PLACEHOLDER_PROGRAM_ID
    )
    console.log(`placeholder program id : ${PLACEHOLDER_PROGRAM_ID.toBase58()}`)
    console.log(`base mint (to be)      : ${baseMint.publicKey.toBase58()}`)
    console.log(`fee PDA                : ${feePda.toBase58()}`)
    console.log(`fee PDA bump           : ${feeBump}`)
    console.log(`PDA is off-curve       : ${!PublicKey.isOnCurve(feePda.toBytes())}`)

    // -----------------------------------------------------------------------
    header('Verify fee scheduler math against SDK before touching the chain')

    console.log('params: cliff=100_000_000 (10%), firstFactor=30, ' +
        'secondFactor=10s, thirdFactor=520, mode=1 (exponential)')
    console.log('\n   t(s)   period   feeNumerator        fee%')
    for (const t of [0, 60, 120, 180, 240, 300, 600]) {
        const period = new BN(Math.floor(t / SECOND_FACTOR.toNumber()))
        const n = getBaseFeeNumeratorByPeriod(
            CLIFF_FEE_NUMERATOR,
            FIRST_FACTOR,
            period,
            THIRD_FACTOR,
            BASE_FEE_MODE
        )
        console.log(
            `  ${String(t).padStart(5)}  ${String(period).padStart(6)}  ` +
            `${String(n).padStart(13)}   ${(n.toNumber() / 1e9 * 100).toFixed(4).padStart(8)}%`
        )
    }

    // -----------------------------------------------------------------------
    header('Create DBC config key with feeClaimer = PDA')

    // buildCurve produces a valid curve + sane defaults; the base fee is then
    // overridden with the exact parameters under test so the on-chain config
    // proves the firstFactor/secondFactor/thirdFactor mapping.
    const curveConfig = buildCurve({
        token: {
            tokenType: TokenType.SPLToken,
            tokenBaseDecimal: TokenDecimal.SIX,
            tokenQuoteDecimal: TokenDecimal.NINE,
            tokenAuthorityOption: TokenAuthorityOption.Immutable,
            totalTokenSupply: 1_000_000_000,
            leftover: 0,
        },
        fee: {
            baseFeeParams: {
                baseFeeMode: BASE_FEE_MODE,
                feeSchedulerParam: {
                    startingFeeBps: 1000, // 10%
                    endingFeeBps: 200,    // 2%
                    numberOfPeriod: FIRST_FACTOR,
                    totalDuration: 300,
                },
            },
            dynamicFeeEnabled: false,
            collectFeeMode: CollectFeeMode.QuoteToken,
            creatorTradingFeePercentage: 0,
            poolCreationFee: 0,
            enableFirstSwapWithMinFee: false,
        },
        migration: {
            migrationOption: MigrationOption.MET_DAMM_V2,
            migrationFeeOption: MigrationFeeOption.FixedBps100,
            migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
        },
        liquidityDistribution: {
            partnerPermanentLockedLiquidityPercentage: 100,
            partnerLiquidityPercentage: 0,
            creatorPermanentLockedLiquidityPercentage: 0,
            creatorLiquidityPercentage: 0,
        },
        lockedVesting: {
            totalLockedVestingAmount: 0,
            numberOfVestingPeriod: 0,
            cliffUnlockAmount: 0,
            totalVestingDuration: 0,
            cliffDurationFromMigrationTime: 0,
        },
        activationType: ActivationType.Timestamp,
        percentageSupplyOnMigration: 20,
        migrationQuoteThreshold: 5, // 5 SOL - low, for devnet
    })

    console.log('\nbuildCurve derived base fee (from 1000bps -> 200bps / 30 periods / 300s):')
    console.log('  ', JSON.stringify(curveConfig.poolFees.baseFee, null, 2).replace(/\n/g, '\n   '))

    // Override with the exact parameters under test.
    curveConfig.poolFees.baseFee = {
        cliffFeeNumerator: CLIFF_FEE_NUMERATOR,
        firstFactor: FIRST_FACTOR,
        secondFactor: SECOND_FACTOR,
        thirdFactor: THIRD_FACTOR,
        baseFeeMode: BASE_FEE_MODE,
    } as any
    curveConfig.poolFees.dynamicFee = null
    ;(curveConfig as any).creatorTradingFeePercentage = 0

    console.log('\noverridden base fee actually sent on-chain:')
    console.log('  ', JSON.stringify(curveConfig.poolFees.baseFee, null, 2).replace(/\n/g, '\n   '))
    console.log(`   dynamicFee: ${curveConfig.poolFees.dynamicFee}`)

    const configKp = Keypair.generate()
    console.log(`\nconfig key : ${configKp.publicKey.toBase58()}`)
    console.log(`feeClaimer : ${feePda.toBase58()}   <-- the PDA`)

    const createConfigTx = await client.partner.createConfig({
        config: configKp.publicKey,
        feeClaimer: feePda,               // <-- the whole point of this test
        leftoverReceiver: payer.publicKey,
        quoteMint: NATIVE_SOL,
        payer: payer.publicKey,
        ...curveConfig,
    })
    await send(conn, createConfigTx, [payer, configKp], 'createConfig')

    const configState = await retry('getPoolConfig', () => client.state.getPoolConfig(configKp.publicKey))
    console.log('\n--- resolved on-chain config ---')
    console.log(`  feeClaimer                  : ${configState.feeClaimer.toBase58()}`)
    console.log(`  quoteMint                   : ${configState.quoteMint.toBase58()}`)
    console.log(`  creatorTradingFeePercentage : ${configState.creatorTradingFeePercentage}`)
    console.log(`  collectFeeMode              : ${configState.collectFeeMode} (0=QuoteToken)`)
    console.log(`  activationType              : ${configState.activationType} (1=Timestamp)`)
    console.log(`  migrationQuoteThreshold     : ${configState.migrationQuoteThreshold.toString()}`)
    console.log('  poolFees.baseFee:')
    console.log(`     cliffFeeNumerator : ${configState.poolFees.baseFee.cliffFeeNumerator.toString()}`)
    console.log(`     firstFactor       : ${configState.poolFees.baseFee.firstFactor}`)
    console.log(`     secondFactor      : ${configState.poolFees.baseFee.secondFactor.toString()}`)
    console.log(`     thirdFactor       : ${configState.poolFees.baseFee.thirdFactor.toString()}`)
    console.log(`     baseFeeMode       : ${configState.poolFees.baseFee.baseFeeMode}`)
    console.log(`  poolFees.dynamicFee : ${JSON.stringify(configState.poolFees.dynamicFee)}`)

    const claimerMatches = configState.feeClaimer.equals(feePda)
    console.log(`\n>>> feeClaimer == PDA ? ${claimerMatches ? 'YES' : 'NO'}`)
    if (!claimerMatches) throw new Error('config did not store the PDA as feeClaimer')

    // -----------------------------------------------------------------------
    header('Create pool from that config key')

    const createPoolTx = await client.creator.createPool({
        config: configKp.publicKey,
        baseMint: baseMint.publicKey,
        name: 'H2E Feasibility',
        symbol: 'H2E',
        uri: 'https://example.com/h2e.json',
        payer: payer.publicKey,
        poolCreator: payer.publicKey,
    })
    await send(conn, createPoolTx, [payer, baseMint], 'createPool')

    const poolAddress = deriveDbcPoolAddress(
        NATIVE_SOL,
        baseMint.publicKey,
        configKp.publicKey
    )
    console.log(`\npool address : ${poolAddress.toBase58()}`)
    console.log(`base mint    : ${baseMint.publicKey.toBase58()}`)

    let pool = await retry('getPool', () => client.state.getPool(poolAddress))
    if (!pool) throw new Error('pool not found after creation')
    console.log(`pool creator : ${pool.poolState.creator.toBase58()}`)
    console.log(`activation   : ${pool.poolState.activationPoint.toString()}`)

    // -----------------------------------------------------------------------
    header('Fund a separate trader wallet and run swaps')

    // Persisted to disk on purpose: an ephemeral in-memory keypair strands its
    // funds unrecoverably if the script dies mid-run.
    const TRADER_PATH = './wallets/trader.json'
    let trader: Keypair
    if (fs.existsSync(TRADER_PATH)) {
        trader = loadKeypair(TRADER_PATH)
        console.log(`trader (reused) : ${trader.publicKey.toBase58()}`)
    } else {
        trader = Keypair.generate()
        fs.writeFileSync(TRADER_PATH, JSON.stringify(Array.from(trader.secretKey)))
        console.log(`trader (new)    : ${trader.publicKey.toBase58()}`)
    }

    const TRADER_TARGET = 0.9 * LAMPORTS_PER_SOL
    const traderBal = await retry('getBalance', () => conn.getBalance(trader.publicKey))
    if (traderBal < TRADER_TARGET) {
        const topUp = TRADER_TARGET - traderBal
        console.log(`topping trader up by ${topUp / LAMPORTS_PER_SOL} SOL`)
        const fundTx = new Transaction().add(
            SystemProgram.transfer({
                fromPubkey: payer.publicKey,
                toPubkey: trader.publicKey,
                lamports: topUp,
            })
        )
        await send(conn, fundTx, [payer], 'fund trader')
    }
    console.log(`trader balance : ${(await retry('getBalance', () => conn.getBalance(trader.publicKey))) / LAMPORTS_PER_SOL} SOL`)

    async function showFees(label: string) {
        const p = await retry('getPool', () => client.state.getPool(poolAddress))
        if (!p) throw new Error('pool vanished')
        console.log(`  [${label}] partnerQuoteFee=${p.poolState.partnerQuoteFee.toString()} ` +
            `partnerBaseFee=${p.poolState.partnerBaseFee.toString()} ` +
            `creatorQuoteFee=${p.poolState.creatorQuoteFee.toString()} ` +
            `protocolQuoteFee=${p.poolState.protocolQuoteFee.toString()}`)
        return p
    }

    await showFees('before any swap')

    // --- BUY 1 -------------------------------------------------------------
    console.log('\n-- BUY 1: 0.15 SOL -> token --')
    const buy1Amount = new BN(0.15 * LAMPORTS_PER_SOL)
    let cfgForQuote = await retry('getPoolConfig', () => client.state.getPoolConfig(configKp.publicKey))
    let poolForQuote = await retry('getPool', () => client.state.getPool(poolAddress))
    let quote = client.pool.swapQuote({
        virtualPool: poolForQuote!,
        config: cfgForQuote,
        swapBaseForQuote: false,
        amountIn: buy1Amount,
        slippageBps: 5000,
        hasReferral: false,
        eligibleForFirstSwapWithMinFee: false,
        currentPoint: new BN(Math.floor(Date.now() / 1000)),
    })
    const q = quote as any
    console.log(`  quote: outputAmount=${q.outputAmount.toString()} ` +
        `tradingFee=${q.tradingFee.toString()} protocolFee=${q.protocolFee.toString()}`)
    const buy1Tx = await client.pool.swap({
        owner: trader.publicKey,
        pool: poolAddress,
        amountIn: buy1Amount,
        minimumAmountOut: new BN(0),
        swapBaseForQuote: false,
        referralTokenAccount: null,
    })
    await send(conn, buy1Tx, [trader], 'buy 1')
    await showFees('after buy 1')

    // --- BUY 2 -------------------------------------------------------------
    console.log('\n-- BUY 2: 0.2 SOL -> token --')
    const buy2Amount = new BN(0.2 * LAMPORTS_PER_SOL)
    const buy2Tx = await client.pool.swap({
        owner: trader.publicKey,
        pool: poolAddress,
        amountIn: buy2Amount,
        minimumAmountOut: new BN(0),
        swapBaseForQuote: false,
        referralTokenAccount: null,
    })
    await send(conn, buy2Tx, [trader], 'buy 2')
    const afterBuy2 = await showFees('after buy 2')

    // --- SELL --------------------------------------------------------------
    const { getAssociatedTokenAddressSync, getAccount } = await import('@solana/spl-token')
    const traderAta = getAssociatedTokenAddressSync(baseMint.publicKey, trader.publicKey)
    const ataInfo = await retry('getAccount', () => getAccount(conn, traderAta))
    const tokenBalance = new BN(ataInfo.amount.toString())
    console.log(`\n-- SELL: half of ${tokenBalance.toString()} tokens -> SOL --`)
    const sellAmount = tokenBalance.div(new BN(2))
    const sellTx = await client.pool.swap({
        owner: trader.publicKey,
        pool: poolAddress,
        amountIn: sellAmount,
        minimumAmountOut: new BN(0),
        swapBaseForQuote: true,
        referralTokenAccount: null,
    })
    await send(conn, sellTx, [trader], 'sell 1')
    await showFees('after sell 1')

    // --- BUY 3 -------------------------------------------------------------
    console.log('\n-- BUY 3: 0.15 SOL -> token --')
    const buy3Tx = await client.pool.swap({
        owner: trader.publicKey,
        pool: poolAddress,
        amountIn: new BN(0.15 * LAMPORTS_PER_SOL),
        minimumAmountOut: new BN(0),
        swapBaseForQuote: false,
        referralTokenAccount: null,
    })
    await send(conn, buy3Tx, [trader], 'buy 3')
    await showFees('after buy 3')

    // -----------------------------------------------------------------------
    header('Read back accrued partner fees and confirm the owning address')

    pool = (await retry('getPool', () => client.state.getPool(poolAddress)))!
    const cfg = await retry('getPoolConfig', () => client.state.getPoolConfig(configKp.publicKey))

    console.log(`  partnerQuoteFee (lamports) : ${pool.poolState.partnerQuoteFee.toString()}`)
    console.log(`  partnerQuoteFee (SOL)      : ${pool.poolState.partnerQuoteFee.toNumber() / LAMPORTS_PER_SOL}`)
    console.log(`  partnerBaseFee             : ${pool.poolState.partnerBaseFee.toString()}`)
    console.log(`  creatorQuoteFee            : ${pool.poolState.creatorQuoteFee.toString()}`)
    console.log(`  creatorBaseFee             : ${pool.poolState.creatorBaseFee.toString()}`)
    console.log(`  protocolQuoteFee           : ${pool.poolState.protocolQuoteFee.toString()}`)
    console.log(`  totalTradingQuoteFee       : ${pool.poolState.metrics.totalTradingQuoteFee.toString()}`)
    console.log('')
    console.log(`  config.feeClaimer          : ${cfg.feeClaimer.toBase58()}`)
    console.log(`  our PDA                    : ${feePda.toBase58()}`)
    console.log(`  pool.creator               : ${pool.poolState.creator.toBase58()}`)
    console.log(`  our wallet                 : ${payer.publicKey.toBase58()}`)
    console.log('')
    console.log(`  >>> partner fees are owned by the PDA : ${cfg.feeClaimer.equals(feePda)}`)
    console.log(`  >>> feeClaimer is NOT the creator     : ${!cfg.feeClaimer.equals(pool.poolState.creator)}`)
    console.log(`  >>> feeClaimer is NOT our wallet      : ${!cfg.feeClaimer.equals(payer.publicKey)}`)
    console.log(`  >>> creator got zero fees             : ${pool.poolState.creatorQuoteFee.isZero() && pool.poolState.creatorBaseFee.isZero()}`)

    // -----------------------------------------------------------------------
    header('Attempt to claim partner fees as the PDA')

    console.log('Building claimPartnerTradingFee with feeClaimer = PDA ...\n')

    const claimTx = await retry('buildClaim', () => client.partner.claimPartnerTradingFee({
        feeClaimer: feePda,
        payer: payer.publicKey,
        pool: poolAddress,
        maxBaseAmount: new BN('18446744073709551615'),
        maxQuoteAmount: new BN('18446744073709551615'),
        receiver: payer.publicKey,
        tempWSolAcc: Keypair.generate().publicKey,
    }))

    console.log('--- account metas of the claim instruction(s) ---')
    claimTx.instructions.forEach((ix, i) => {
        console.log(`\n  ix[${i}] program = ${ix.programId.toBase58()}`)
        ix.keys.forEach((k) => {
            const tag = k.pubkey.equals(feePda) ? '   <== OUR PDA' : ''
            console.log(
                `    ${k.pubkey.toBase58().padEnd(45)} signer=${String(k.isSigner).padEnd(5)} writable=${String(k.isWritable).padEnd(5)}${tag}`
            )
        })
    })

    const pdaMetas = claimTx.instructions.flatMap((ix) =>
        ix.keys.filter((k) => k.pubkey.equals(feePda))
    )
    const pdaMustSign = pdaMetas.some((k) => k.isSigner)
    console.log(`\n>>> PDA appears in ${pdaMetas.length} account meta(s)`)
    console.log(`>>> PDA is marked isSigner = ${pdaMustSign}`)
    console.log(`>>> Therefore the claim ${pdaMustSign ? 'REQUIRES' : 'does NOT require'} feeClaimer to be a transaction signer`)

    console.log('\n--- Attempt A: send the claim signed only by payer (PDA cannot sign) ---')
    try {
        claimTx.feePayer = payer.publicKey
        claimTx.recentBlockhash = (await retry('blockhash', () => conn.getLatestBlockhash())).blockhash
        const sig = await sendAndConfirmTransaction(conn, claimTx, [payer], {
            commitment: 'confirmed',
        })
        console.log(`  UNEXPECTED SUCCESS: ${sig}`)
    } catch (e: any) {
        console.log(`  FAILED (expected).`)
        console.log(`  error name    : ${e?.name}`)
        console.log(`  error message : ${e?.message}`)
        if (e?.logs) console.log(`  logs:\n    ${e.logs.join('\n    ')}`)
    }

    console.log('\n--- Attempt B: force the PDA to a NON-signer and resend ---')
    // The SDK's claim tx also contains a closeAccount instruction whose authority
    // is a throwaway temp-WSOL keypair. Including it would make the tx fail on
    // THAT missing signature and tell us nothing about the PDA. So send only the
    // ATA creations plus the DBC claim itself, leaving payer as the only signer.
    const DBC_PROGRAM = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN'
    const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
    try {
        const dbcIx = claimTx.instructions.find(
            (ix) => ix.programId.toBase58() === DBC_PROGRAM
        )!
        const ataIxs = claimTx.instructions.filter(
            (ix) => ix.programId.toBase58() === ATA_PROGRAM
        )

        const tx2 = new Transaction()
        ataIxs.forEach((ix) => tx2.add(ix))
        tx2.add({
            programId: dbcIx.programId,
            data: dbcIx.data,
            keys: dbcIx.keys.map((k) =>
                k.pubkey.equals(feePda) ? { ...k, isSigner: false } : k
            ),
        })
        tx2.feePayer = payer.publicKey
        tx2.recentBlockhash = (await retry('blockhash', () => conn.getLatestBlockhash())).blockhash

        const msg = tx2.compileMessage()
        const required = msg.accountKeys
            .slice(0, msg.header.numRequiredSignatures)
            .map((k) => k.toBase58())
        console.log(`  required signers: ${JSON.stringify(required)}`)
        console.log(`  payer is the only required signer: ${required.length === 1 && required[0] === payer.publicKey.toBase58()}`)

        const sig = await sendAndConfirmTransaction(conn, tx2, [payer], {
            commitment: 'confirmed',
        })
        console.log(`  UNEXPECTED SUCCESS: ${sig}`)
    } catch (e: any) {
        console.log(`  FAILED (expected).`)
        console.log(`  error message : ${e?.message}`)
        const logs = e?.logs ?? e?.transactionLogs
        if (logs) console.log(`  program logs:\n    ${logs.join('\n    ')}`)
    }

    // -----------------------------------------------------------------------
    console.log('\n' + '='.repeat(74))
    console.log('SUMMARY')
    console.log('='.repeat(74))
    console.log(`config key      : ${configKp.publicKey.toBase58()}`)
    console.log(`pool            : ${poolAddress.toBase58()}`)
    console.log(`base mint       : ${baseMint.publicKey.toBase58()}`)
    console.log(`fee PDA         : ${feePda.toBase58()} (bump ${feeBump})`)
    console.log(`partner fees    : ${pool.poolState.partnerQuoteFee.toString()} lamports accrued to the PDA`)
    console.log(`claim needs sig : ${pdaMustSign}`)
}

main().catch((e) => {
    console.error('\n!!! FATAL !!!')
    console.error(e)
    if (e?.logs) console.error('logs:\n' + e.logs.join('\n'))
    process.exit(1)
})
