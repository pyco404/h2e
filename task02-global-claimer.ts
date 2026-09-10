/**
 * Task 0.2 — one config key, one global fee-claimer PDA, many pools.
 *
 * Proves:
 *   1. A CPI claim with invoke_signed works using a GLOBAL ["fee"] PDA signer.
 *   2. Claiming pool A moves only pool A's fees; B and C are untouched.
 *   3. `receiver` routes proceeds to an arbitrary account.
 *   4. One config key serves all three pools.
 *   5. Negative: the minimal program has no authority check, so anyone can call
 *      it and redirect the claim.
 *
 * Devnet, Helius RPC. Every keypair is written to disk BEFORE it is funded.
 */

import {
    Connection,
    Keypair,
    PublicKey,
    SystemProgram,
    Transaction,
    TransactionInstruction,
    LAMPORTS_PER_SOL,
    sendAndConfirmTransaction,
} from '@solana/web3.js'
import {
    getAssociatedTokenAddressSync,
    createAssociatedTokenAccountIdempotentInstruction,
    getAccount,
    TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import BN from 'bn.js'
import fs from 'fs'
import crypto from 'crypto'
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
} from '@meteora-ag/dynamic-bonding-curve-sdk'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RPC = process.env.HELIUS_RPC_URL
if (!RPC || !RPC.includes('helius')) {
    throw new Error('set HELIUS_RPC_URL to a Helius devnet endpoint')
}

const H2E_PROGRAM_ID = new PublicKey(
    fs.readFileSync('./.program-id', 'utf8').trim()
)
const DBC_PROGRAM_ID = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN')
const DBC_POOL_AUTHORITY = new PublicKey('FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM')
const NATIVE_SOL = new PublicKey('So11111111111111111111111111111111111111112')

const KEY_DIR = './wallets/task02'

// Fee scheduler under test (thirdFactor 522 per Task 0.1's correction).
const CLIFF_FEE_NUMERATOR = new BN(100_000_000) // 10%
const FIRST_FACTOR = 30                          // numberOfPeriod
const SECOND_FACTOR = new BN(10)                 // periodFrequency, seconds
const THIRD_FACTOR = new BN(522)                 // reductionFactor
const BASE_FEE_MODE = BaseFeeMode.FeeSchedulerExponential

// Different trade sizes per pool so the three fee balances are clearly distinct.
const POOL_PLAN = [
    { label: 'A', buys: [0.05, 0.03] },
    { label: 'B', buys: [0.10] },
    { label: 'C', buys: [0.16] },
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let stepNo = 0
function header(title: string) {
    stepNo++
    console.log('\n' + '='.repeat(76))
    console.log(`STEP ${stepNo}: ${title}`)
    console.log('='.repeat(76))
}

function explorer(sig: string) {
    return `https://solscan.io/tx/${sig}?cluster=devnet`
}

/** Load a keypair, or create AND PERSIST one before it is ever funded. */
function persistedKeypair(name: string): Keypair {
    const path = `${KEY_DIR}/${name}.json`
    if (fs.existsSync(path)) {
        return Keypair.fromSecretKey(
            Uint8Array.from(JSON.parse(fs.readFileSync(path, 'utf8')))
        )
    }
    const kp = Keypair.generate()
    fs.mkdirSync(KEY_DIR, { recursive: true })
    fs.writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)))
    return kp
}

async function retry<T>(label: string, fn: () => Promise<T>): Promise<T> {
    let lastErr: any
    for (let i = 1; i <= 5; i++) {
        try {
            return await fn()
        } catch (e: any) {
            lastErr = e
            const m = String(e?.message ?? '') + String(e?.cause?.code ?? '')
            const transient =
                m.includes('fetch failed') || m.includes('TIMEOUT') ||
                m.includes('ECONNRESET') || m.includes('socket hang up') ||
                m.includes('502') || m.includes('503') || m.includes('429')
            if (!transient) throw e
            console.log(`  [rpc:${label}] transient, retry ${i}/5`)
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
    let lastErr: any
    for (let i = 1; i <= 4; i++) {
        try {
            const { blockhash } = await retry('blockhash', () =>
                conn.getLatestBlockhash('finalized')
            )
            tx.recentBlockhash = blockhash
            tx.feePayer = signers[0].publicKey
            tx.signatures = []
            const sig = await sendAndConfirmTransaction(conn, tx, signers, {
                commitment: 'confirmed',
            })
            console.log(`  tx [${label}]: ${sig}`)
            console.log(`     ${explorer(sig)}`)
            return sig
        } catch (e: any) {
            lastErr = e
            const m = String(e?.message ?? '')
            if (!m.includes('Blockhash not found') && !m.includes('block height exceeded')) throw e
            console.log(`  [${label}] blockhash stale, retry ${i}/4`)
        }
    }
    throw lastErr
}

/** Anchor discriminator: first 8 bytes of sha256("global:<ix_name>"). */
function anchorDiscriminator(name: string): Buffer {
    return crypto.createHash('sha256').update(`global:${name}`).digest().subarray(0, 8)
}

/**
 * Build our program's claim_partner_fees instruction. Account order must match
 * the ClaimPartnerFees struct in programs/h2e_fee_claimer/src/lib.rs.
 */
function buildClaimIx(args: {
    feeAuthority: PublicKey
    config: PublicKey
    pool: PublicKey
    tokenAAccount: PublicKey
    tokenBAccount: PublicKey
    baseVault: PublicKey
    quoteVault: PublicKey
    baseMint: PublicKey
    eventAuthority: PublicKey
}): TransactionInstruction {
    const data = Buffer.concat([
        anchorDiscriminator('claim_partner_fees'),
        Buffer.from(new BN('18446744073709551615').toArray('le', 8)), // max_base
        Buffer.from(new BN('18446744073709551615').toArray('le', 8)), // max_quote
    ])
    const keys = [
        { pubkey: args.feeAuthority, isSigner: false, isWritable: false },
        { pubkey: DBC_POOL_AUTHORITY, isSigner: false, isWritable: false },
        { pubkey: args.config, isSigner: false, isWritable: false },
        { pubkey: args.pool, isSigner: false, isWritable: true },
        { pubkey: args.tokenAAccount, isSigner: false, isWritable: true },
        { pubkey: args.tokenBAccount, isSigner: false, isWritable: true },
        { pubkey: args.baseVault, isSigner: false, isWritable: true },
        { pubkey: args.quoteVault, isSigner: false, isWritable: true },
        { pubkey: args.baseMint, isSigner: false, isWritable: false },
        { pubkey: NATIVE_SOL, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: args.eventAuthority, isSigner: false, isWritable: false },
        { pubkey: DBC_PROGRAM_ID, isSigner: false, isWritable: false },
    ]
    return new TransactionInstruction({ programId: H2E_PROGRAM_ID, keys, data })
}

// ---------------------------------------------------------------------------

async function main() {
    const conn = new Connection(RPC, 'confirmed')
    const client = DynamicBondingCurveClient.create(conn, 'confirmed')
    const payer = Keypair.fromSecretKey(
        Uint8Array.from(JSON.parse(fs.readFileSync('./wallets/payer.json', 'utf8')))
    )

    console.log(`RPC        : ${RPC.replace(/api-key=.*/, 'api-key=<redacted>')}`)
    console.log(`payer      : ${payer.publicKey.toBase58()}`)
    const bal = await retry('bal', () => conn.getBalance(payer.publicKey))
    console.log(`balance    : ${bal / LAMPORTS_PER_SOL} SOL`)
    console.log(`h2e program: ${H2E_PROGRAM_ID.toBase58()}`)

    const [feePda, feeBump] = PublicKey.findProgramAddressSync(
        [Buffer.from('fee')],
        H2E_PROGRAM_ID
    )
    const [dbcEventAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from('__event_authority')],
        DBC_PROGRAM_ID
    )
    console.log(`global fee PDA  : ${feePda.toBase58()} (bump ${feeBump})  <-- seeds ["fee"], NO mint`)
    console.log(`dbc eventAuthority: ${dbcEventAuthority.toBase58()}`)

    // -----------------------------------------------------------------------
    header('Create ONE config key with the global PDA as feeClaimer')

    const configKp = persistedKeypair('config')
    const configExists = await retry('cfgInfo', () => conn.getAccountInfo(configKp.publicKey))

    if (!configExists) {
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
                        startingFeeBps: 1000,
                        endingFeeBps: 200,
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
            migrationQuoteThreshold: 5,
        })

        curveConfig.poolFees.baseFee = {
            cliffFeeNumerator: CLIFF_FEE_NUMERATOR,
            firstFactor: FIRST_FACTOR,
            secondFactor: SECOND_FACTOR,
            thirdFactor: THIRD_FACTOR,
            baseFeeMode: BASE_FEE_MODE,
        } as any
        curveConfig.poolFees.dynamicFee = null

        const tx = await client.partner.createConfig({
            config: configKp.publicKey,
            feeClaimer: feePda,          // the GLOBAL pda
            leftoverReceiver: payer.publicKey,
            quoteMint: NATIVE_SOL,
            payer: payer.publicKey,
            ...curveConfig,
        })
        await send(conn, tx, [payer, configKp], 'createConfig')
    } else {
        console.log('  config already exists, reusing')
    }

    const cfg = await retry('cfg', () => client.state.getPoolConfig(configKp.publicKey))
    console.log(`\nconfig key                  : ${configKp.publicKey.toBase58()}`)
    console.log(`config.feeClaimer           : ${cfg.feeClaimer.toBase58()}`)
    console.log(`  == global PDA ?           : ${cfg.feeClaimer.equals(feePda)}`)
    console.log(`creatorTradingFeePercentage : ${cfg.creatorTradingFeePercentage}`)
    console.log(`baseFee.cliffFeeNumerator   : ${cfg.poolFees.baseFee.cliffFeeNumerator.toString()}`)
    console.log(`baseFee.firstFactor         : ${cfg.poolFees.baseFee.firstFactor}`)
    console.log(`baseFee.secondFactor        : ${cfg.poolFees.baseFee.secondFactor.toString()}`)
    console.log(`baseFee.thirdFactor         : ${cfg.poolFees.baseFee.thirdFactor.toString()}`)
    console.log(`baseFee.baseFeeMode         : ${cfg.poolFees.baseFee.baseFeeMode}`)

    // -----------------------------------------------------------------------
    header('Create THREE pools from that ONE config key')

    type PoolInfo = {
        label: string
        mint: Keypair
        pool: PublicKey
        dest: Keypair
        destBaseAta: PublicKey
        destQuoteAta: PublicKey
        buys: number[]
    }
    const pools: PoolInfo[] = []

    for (const plan of POOL_PLAN) {
        const mint = persistedKeypair(`mint-${plan.label}`)
        const dest = persistedKeypair(`dest-${plan.label}`)
        const poolAddr = deriveDbcPoolAddress(NATIVE_SOL, mint.publicKey, configKp.publicKey)

        const exists = await retry('poolInfo', () => conn.getAccountInfo(poolAddr))
        if (!exists) {
            const tx = await client.creator.createPool({
                config: configKp.publicKey,
                baseMint: mint.publicKey,
                name: `H2E Pool ${plan.label}`,
                symbol: `H2E${plan.label}`,
                uri: 'https://example.com/h2e.json',
                payer: payer.publicKey,
                poolCreator: payer.publicKey,
            })
            await send(conn, tx, [payer, mint], `createPool ${plan.label}`)
        } else {
            console.log(`  pool ${plan.label} already exists, reusing`)
        }

        pools.push({
            label: plan.label,
            mint,
            pool: poolAddr,
            dest,
            destBaseAta: getAssociatedTokenAddressSync(mint.publicKey, dest.publicKey),
            destQuoteAta: getAssociatedTokenAddressSync(NATIVE_SOL, dest.publicKey),
            buys: plan.buys,
        })
    }

    console.log('')
    for (const p of pools) {
        console.log(`pool ${p.label}: ${p.pool.toBase58()}`)
        console.log(`  mint       : ${p.mint.publicKey.toBase58()}`)
        console.log(`  config     : ${configKp.publicKey.toBase58()}  <-- same for all`)
    }

    // -----------------------------------------------------------------------
    header('Trade different amounts against each pool')

    const trader = Keypair.fromSecretKey(
        Uint8Array.from(JSON.parse(fs.readFileSync('./wallets/trader.json', 'utf8')))
    )
    console.log(`trader : ${trader.publicKey.toBase58()}`)
    const traderBal = await retry('bal', () => conn.getBalance(trader.publicKey))
    console.log(`trader balance : ${traderBal / LAMPORTS_PER_SOL} SOL`)

    for (const p of pools) {
        console.log(`\n-- pool ${p.label}: buys ${p.buys.join(' + ')} SOL --`)
        for (const amt of p.buys) {
            const tx = await client.pool.swap({
                owner: trader.publicKey,
                pool: p.pool,
                amountIn: new BN(Math.round(amt * LAMPORTS_PER_SOL)),
                minimumAmountOut: new BN(0),
                swapBaseForQuote: false,
                referralTokenAccount: null,
            })
            await send(conn, tx, [trader], `buy ${amt} on ${p.label}`)
        }
    }

    async function feesOf(p: PoolInfo): Promise<BN> {
        const st = await retry('getPool', () => client.state.getPool(p.pool))
        return st!.poolState.partnerQuoteFee
    }

    console.log('\n--- partnerQuoteFee after trading ---')
    const feesAfterTrading: Record<string, BN> = {}
    for (const p of pools) {
        const f = await feesOf(p)
        feesAfterTrading[p.label] = f
        console.log(`  pool ${p.label}: ${f.toString()} lamports (${f.toNumber() / LAMPORTS_PER_SOL} SOL)`)
    }

    // -----------------------------------------------------------------------
    header('Destination accounts (one per mint, arbitrary keypairs)')

    for (const p of pools) {
        console.log(`dest ${p.label} : ${p.dest.publicKey.toBase58()}`)
        console.log(`  base ATA  : ${p.destBaseAta.toBase58()}`)
        console.log(`  quote ATA : ${p.destQuoteAta.toBase58()} (WSOL)`)
    }

    // Create the destination ATAs (payer funds the rent; destinations hold no SOL).
    const ataTx = new Transaction()
    for (const p of pools) {
        ataTx.add(
            createAssociatedTokenAccountIdempotentInstruction(
                payer.publicKey, p.destBaseAta, p.dest.publicKey, p.mint.publicKey
            ),
            createAssociatedTokenAccountIdempotentInstruction(
                payer.publicKey, p.destQuoteAta, p.dest.publicKey, NATIVE_SOL
            )
        )
    }
    await send(conn, ataTx, [payer], 'create destination ATAs')

    // -----------------------------------------------------------------------
    header('CPI claim: pool A -> dest A, then pool B -> dest B')

    async function quoteAtaBalance(ata: PublicKey): Promise<bigint> {
        try {
            const acc = await retry('ata', () => getAccount(conn, ata))
            return acc.amount
        } catch {
            return 0n
        }
    }

    async function snapshot(tag: string) {
        console.log(`\n  --- ${tag} ---`)
        for (const p of pools) {
            const f = await feesOf(p)
            const b = await quoteAtaBalance(p.destQuoteAta)
            console.log(`    pool ${p.label}: partnerQuoteFee=${f.toString().padStart(10)}   dest${p.label} WSOL=${b.toString()}`)
        }
    }

    await snapshot('before any claim')

    async function claim(p: PoolInfo, signer: Keypair, receiverBase: PublicKey, receiverQuote: PublicKey, label: string) {
        const st = await retry('getPool', () => client.state.getPool(p.pool))
        const ix = buildClaimIx({
            feeAuthority: feePda,
            config: configKp.publicKey,
            pool: p.pool,
            tokenAAccount: receiverBase,
            tokenBAccount: receiverQuote,
            baseVault: st!.poolState.baseVault,
            quoteVault: st!.poolState.quoteVault,
            baseMint: p.mint.publicKey,
            eventAuthority: dbcEventAuthority,
        })
        const tx = new Transaction().add(ix)
        return send(conn, tx, [signer], label)
    }

    for (const label of ['A', 'B']) {
        const p = pools.find((x) => x.label === label)!
        const before = await feesOf(p)
        console.log(`\n>> claiming pool ${label} (accrued ${before.toString()} lamports) -> dest ${label}`)
        await claim(p, payer, p.destBaseAta, p.destQuoteAta, `claim ${label}`)
        const after = await feesOf(p)
        const got = await quoteAtaBalance(p.destQuoteAta)
        console.log(`   partnerQuoteFee before : ${before.toString()}`)
        console.log(`   partnerQuoteFee after  : ${after.toString()}`)
        console.log(`   dest ${label} WSOL balance : ${got.toString()}`)
        console.log(`   claimed == accrued ?   : ${got.toString() === before.toString()}`)
        await snapshot(`after claiming ${label}`)
    }

    // -----------------------------------------------------------------------
    header('NEGATIVE TEST: non-keeper wallet claims pool C to an attacker receiver')

    const attacker = persistedKeypair('attacker')
    console.log(`attacker wallet : ${attacker.publicKey.toBase58()}`)
    const attBal = await retry('bal', () => conn.getBalance(attacker.publicKey))
    if (attBal < 0.02 * LAMPORTS_PER_SOL) {
        const fund = new Transaction().add(
            SystemProgram.transfer({
                fromPubkey: payer.publicKey,
                toPubkey: attacker.publicKey,
                lamports: 0.02 * LAMPORTS_PER_SOL,
            })
        )
        await send(conn, fund, [payer], 'fund attacker')
    }

    const poolC = pools.find((p) => p.label === 'C')!
    const attackerBaseAta = getAssociatedTokenAddressSync(poolC.mint.publicKey, attacker.publicKey)
    const attackerQuoteAta = getAssociatedTokenAddressSync(NATIVE_SOL, attacker.publicKey)
    console.log(`attacker quote ATA : ${attackerQuoteAta.toBase58()}`)

    const mkAta = new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(
            attacker.publicKey, attackerBaseAta, attacker.publicKey, poolC.mint.publicKey
        ),
        createAssociatedTokenAccountIdempotentInstruction(
            attacker.publicKey, attackerQuoteAta, attacker.publicKey, NATIVE_SOL
        )
    )
    await send(conn, mkAta, [attacker], 'attacker creates own ATAs')

    const cBefore = await feesOf(poolC)
    console.log(`\npool C accrued before attack : ${cBefore.toString()} lamports`)
    console.log('attacker calls claim_partner_fees(pool C) with THEIR OWN receiver...')

    let attackSucceeded = false
    try {
        await claim(poolC, attacker, attackerBaseAta, attackerQuoteAta, 'ATTACKER claim C')
        attackSucceeded = true
    } catch (e: any) {
        console.log(`  attack FAILED: ${e?.message}`)
        const logs = e?.logs ?? e?.transactionLogs
        if (logs) console.log(`  logs:\n    ${logs.join('\n    ')}`)
    }

    const cAfter = await feesOf(poolC)
    const attackerGot = await quoteAtaBalance(attackerQuoteAta)
    console.log(`\n  attack succeeded          : ${attackSucceeded}`)
    console.log(`  pool C partnerQuoteFee now: ${cAfter.toString()}`)
    console.log(`  attacker WSOL balance     : ${attackerGot.toString()}`)
    console.log(`  attacker stole            : ${attackerGot.toString()} lamports`)

    // -----------------------------------------------------------------------
    header('Final state')

    await snapshot('final')
    console.log('\n--- summary table ---')
    console.log('pool | accrued after trading | partnerQuoteFee now | destination WSOL')
    for (const p of pools) {
        const f = await feesOf(p)
        const b = await quoteAtaBalance(p.destQuoteAta)
        console.log(
            `  ${p.label}  | ${feesAfterTrading[p.label].toString().padStart(21)} | ${f.toString().padStart(19)} | ${b.toString()}`
        )
    }
    console.log(`\nattacker WSOL: ${(await quoteAtaBalance(attackerQuoteAta)).toString()}`)
    console.log(`one config key for all pools: ${configKp.publicKey.toBase58()}`)
    console.log(`one global fee PDA         : ${feePda.toBase58()}`)
}

main().catch((e) => {
    console.error('\n!!! FATAL !!!')
    console.error(e)
    const logs = e?.logs ?? e?.transactionLogs
    if (logs) console.error('logs:\n' + logs.join('\n'))
    process.exit(1)
})
