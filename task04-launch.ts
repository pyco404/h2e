/**
 * Task 0.4 — program-created pools with an atomic capped dev buy.
 *
 * launch_coin(name, symbol, uri, dev_buy_lamports) CPIs DBC to create a pool from
 * the platform's global config (so the platform PDA is fee claimer) and, in the
 * same instruction, performs an optional dev buy capped at 3% of total supply.
 *
 * Cases:
 *   1. dev_buy = 0            -> pool created, caller holds nothing.
 *   2. dev_buy just under 3%  -> succeeds; print exact %.
 *   3. dev_buy over 3%        -> whole tx fails, no pool created.
 * Plus: CU + serialized tx size for cases 1 & 2; config/feeClaimer check;
 * and a post-hoc trade confirming partner_quote_fee accrues to the global PDA.
 *
 * Devnet, Helius. All keypairs persisted before funding.
 */
import {
    Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
    LAMPORTS_PER_SOL, ComputeBudgetProgram, sendAndConfirmTransaction,
} from '@solana/web3.js'
import {
    getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
    createSyncNativeInstruction, createCloseAccountInstruction, getAccount, TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import BN from 'bn.js'
import fs from 'fs'
import crypto from 'crypto'
import {
    DynamicBondingCurveClient, buildCurve, deriveDbcPoolAddress, deriveDbcTokenVaultAddress,
    deriveMintMetadata, BaseFeeMode, CollectFeeMode, ActivationType, MigrationOption,
    MigrationFeeOption, TokenType, TokenDecimal, TokenAuthorityOption,
} from '@meteora-ag/dynamic-bonding-curve-sdk'

const RPC = process.env.HELIUS_RPC_URL
if (!RPC || !RPC.includes('helius')) throw new Error('set HELIUS_RPC_URL')

const H2E_PROGRAM_ID = new PublicKey(fs.readFileSync('./.program-id', 'utf8').trim())
const DBC_PROGRAM_ID = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN')
const DBC_POOL_AUTHORITY = new PublicKey('FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM')
const DBC_EVENT_AUTHORITY = new PublicKey('8Ks12pbrD6PXxfty1hVQiE9sc289zgU1zHkvXhrSdriF')
const METADATA_PROGRAM = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s')
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
const NATIVE_SOL = new PublicKey('So11111111111111111111111111111111111111112')
const KEY_DIR = './wallets/task04'

const CLIFF_FEE_NUMERATOR = new BN(100_000_000)
const FIRST_FACTOR = 30, SECOND_FACTOR = new BN(10), THIRD_FACTOR = new BN(522)
const BASE_FEE_MODE = BaseFeeMode.FeeSchedulerExponential
const TOTAL_SUPPLY = 1_000_000_000        // tokens
const BASE_DECIMALS = 6
const TOTAL_SUPPLY_BASE_UNITS = new BN(TOTAL_SUPPLY).mul(new BN(10 ** BASE_DECIMALS))

let stepNo = 0
const header = (t: string) => { stepNo++; console.log('\n' + '='.repeat(78)); console.log(`STEP ${stepNo}: ${t}`); console.log('='.repeat(78)) }
const explorer = (s: string) => `https://solscan.io/tx/${s}?cluster=devnet`
const disc = (n: string) => crypto.createHash('sha256').update(`global:${n}`).digest().subarray(0, 8)

function persisted(name: string): Keypair {
    const p = `${KEY_DIR}/${name}.json`
    if (fs.existsSync(p)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, 'utf8'))))
    const kp = Keypair.generate(); fs.mkdirSync(KEY_DIR, { recursive: true })
    fs.writeFileSync(p, JSON.stringify(Array.from(kp.secretKey))); return kp
}
const load = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, 'utf8'))))

async function retry<T>(label: string, fn: () => Promise<T>): Promise<T> {
    let last: any
    for (let i = 1; i <= 6; i++) {
        try { return await fn() } catch (e: any) {
            last = e; const m = String(e?.message ?? '') + String(e?.cause?.code ?? '')
            if (!/fetch failed|TIMEOUT|ECONNRESET|socket hang up|502|503|429/.test(m)) throw e
            console.log(`  [rpc:${label}] retry ${i}/6`); await new Promise(r => setTimeout(r, 800))
        }
    }
    throw last
}
async function send(conn: Connection, tx: Transaction, signers: Keypair[], label: string): Promise<string> {
    let last: any
    for (let i = 1; i <= 4; i++) {
        try {
            const { blockhash } = await retry('blockhash', () => conn.getLatestBlockhash('finalized'))
            tx.recentBlockhash = blockhash; tx.feePayer = signers[0].publicKey; tx.signatures = []
            const sig = await sendAndConfirmTransaction(conn, tx, signers, { commitment: 'confirmed' })
            console.log(`  tx [${label}]: ${sig}`); console.log(`     ${explorer(sig)}`); return sig
        } catch (e: any) {
            last = e; const m = String(e?.message ?? '')
            if (!m.includes('Blockhash not found') && !m.includes('block height exceeded')) throw e
            console.log(`  [${label}] blockhash stale, retry ${i}/4`)
        }
    }
    throw last
}

/** Build the launch_coin instruction (account order matches the program). */
function launchIx(a: {
    payer: PublicKey, baseMint: PublicKey, config: PublicKey, pool: PublicKey,
    baseVault: PublicKey, quoteVault: PublicKey, mintMetadata: PublicKey,
    devQuoteAta: PublicKey, devBaseAta: PublicKey,
    name: string, symbol: string, uri: string, devBuyLamports: BN,
}): TransactionInstruction {
    const enc = (s: string) => { const b = Buffer.from(s, 'utf8'); const len = Buffer.alloc(4); len.writeUInt32LE(b.length); return Buffer.concat([len, b]) }
    const data = Buffer.concat([
        disc('launch_coin'), enc(a.name), enc(a.symbol), enc(a.uri),
        Buffer.from(a.devBuyLamports.toArray('le', 8)),
    ])
    const keys = [
        { pubkey: a.payer, isSigner: true, isWritable: true },   // payer
        { pubkey: a.payer, isSigner: true, isWritable: true },   // creator (same)
        { pubkey: a.baseMint, isSigner: true, isWritable: true },
        { pubkey: a.config, isSigner: false, isWritable: false },
        { pubkey: DBC_POOL_AUTHORITY, isSigner: false, isWritable: false },
        { pubkey: NATIVE_SOL, isSigner: false, isWritable: false }, // quote_mint
        { pubkey: a.pool, isSigner: false, isWritable: true },
        { pubkey: a.baseVault, isSigner: false, isWritable: true },
        { pubkey: a.quoteVault, isSigner: false, isWritable: true },
        { pubkey: a.mintMetadata, isSigner: false, isWritable: true },
        { pubkey: METADATA_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: a.devQuoteAta, isSigner: false, isWritable: true },
        { pubkey: a.devBaseAta, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // token_program
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // token_quote_program
        { pubkey: ATA_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: DBC_EVENT_AUTHORITY, isSigner: false, isWritable: false },
        { pubkey: DBC_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ]
    return new TransactionInstruction({ programId: H2E_PROGRAM_ID, keys, data })
}

async function main() {
    const conn = new Connection(RPC, 'confirmed')
    const client = DynamicBondingCurveClient.create(conn, 'confirmed')
    const payer = load('./wallets/payer.json')
    const [feePda, feeBump] = PublicKey.findProgramAddressSync([Buffer.from('fee')], H2E_PROGRAM_ID)

    console.log(`payer      : ${payer.publicKey.toBase58()}  balance ${(await retry('bal', () => conn.getBalance(payer.publicKey))) / LAMPORTS_PER_SOL} SOL`)
    console.log(`h2e program: ${H2E_PROGRAM_ID.toBase58()}`)
    console.log(`global PDA  : ${feePda.toBase58()} (bump ${feeBump})`)

    // ---------------------------------------------------------------------
    header('Create the platform config (feeClaimer = global PDA)')
    const configKp = persisted('config')
    console.log(`config: ${configKp.publicKey.toBase58()}`)
    if (!(await retry('cfg?', () => conn.getAccountInfo(configKp.publicKey)))) {
        const curve = buildCurve({
            token: { tokenType: TokenType.SPLToken, tokenBaseDecimal: TokenDecimal.SIX, tokenQuoteDecimal: TokenDecimal.NINE, tokenAuthorityOption: TokenAuthorityOption.Immutable, totalTokenSupply: TOTAL_SUPPLY, leftover: 0 },
            fee: { baseFeeParams: { baseFeeMode: BASE_FEE_MODE, feeSchedulerParam: { startingFeeBps: 1000, endingFeeBps: 200, numberOfPeriod: FIRST_FACTOR, totalDuration: 300 } }, dynamicFeeEnabled: false, collectFeeMode: CollectFeeMode.QuoteToken, creatorTradingFeePercentage: 0, poolCreationFee: 0, enableFirstSwapWithMinFee: false },
            migration: { migrationOption: MigrationOption.MET_DAMM_V2, migrationFeeOption: MigrationFeeOption.FixedBps100, migrationFee: { feePercentage: 0, creatorFeePercentage: 0 } },
            liquidityDistribution: { partnerPermanentLockedLiquidityPercentage: 100, partnerLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: 0, creatorLiquidityPercentage: 0 },
            lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
            activationType: ActivationType.Timestamp, percentageSupplyOnMigration: 20, migrationQuoteThreshold: 5,
        })
        curve.poolFees.baseFee = { cliffFeeNumerator: CLIFF_FEE_NUMERATOR, firstFactor: FIRST_FACTOR, secondFactor: SECOND_FACTOR, thirdFactor: THIRD_FACTOR, baseFeeMode: BASE_FEE_MODE } as any
        curve.poolFees.dynamicFee = null
        const tx = await client.partner.createConfig({ config: configKp.publicKey, feeClaimer: feePda, leftoverReceiver: payer.publicKey, quoteMint: NATIVE_SOL, payer: payer.publicKey, ...curve })
        await send(conn, tx, [payer, configKp], 'createConfig')
    } else console.log('  config exists, reusing')
    const cfg = await retry('cfg', () => client.state.getPoolConfig(configKp.publicKey))
    console.log(`feeClaimer == global PDA : ${cfg.feeClaimer.equals(feePda)}`)

    // helper to assemble one launch_coin transaction
    function buildLaunchTx(baseMint: Keypair, name: string, symbol: string, devBuy: BN, cuLimit: number) {
        const pool = deriveDbcPoolAddress(NATIVE_SOL, baseMint.publicKey, configKp.publicKey)
        const baseVault = deriveDbcTokenVaultAddress(pool, baseMint.publicKey)
        const quoteVault = deriveDbcTokenVaultAddress(pool, NATIVE_SOL)
        const mintMetadata = deriveMintMetadata(baseMint.publicKey)
        const devQuoteAta = getAssociatedTokenAddressSync(NATIVE_SOL, payer.publicKey)
        const devBaseAta = getAssociatedTokenAddressSync(baseMint.publicKey, payer.publicKey)
        const tx = new Transaction()
        tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }))
        if (devBuy.gtn(0)) {
            // wrap SOL for the dev buy input (ancillary; the buy itself is in launch_coin)
            tx.add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, devQuoteAta, payer.publicKey, NATIVE_SOL))
            tx.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: devQuoteAta, lamports: BigInt(devBuy.toString()) }))
            tx.add(createSyncNativeInstruction(devQuoteAta))
        }
        tx.add(launchIx({ payer: payer.publicKey, baseMint: baseMint.publicKey, config: configKp.publicKey, pool, baseVault, quoteVault, mintMetadata, devQuoteAta, devBaseAta, name, symbol, uri: 'https://example.com/h2e.json', devBuyLamports: devBuy }))
        if (devBuy.gtn(0)) tx.add(createCloseAccountInstruction(devQuoteAta, payer.publicKey, payer.publicKey))
        return { tx, pool, devBaseAta }
    }

    async function txStats(sig: string) {
        const t = await retry('txmeta', () => conn.getTransaction(sig, { maxSupportedTransactionVersion: 0 }))
        return { cu: t?.meta?.computeUnitsConsumed, err: t?.meta?.err }
    }

    // ---------------------------------------------------------------------
    header('CASE 1: dev_buy = 0  (pool created, no buy)')
    const mint1 = persisted('mint-case1')
    const { tx: tx1, pool: pool1, devBaseAta: ata1 } = buildLaunchTx(mint1, 'H2E One', 'H2E1', new BN(0), 400_000)
    tx1.feePayer = payer.publicKey
    tx1.recentBlockhash = (await retry('bh', () => conn.getLatestBlockhash('finalized'))).blockhash
    tx1.sign(payer, mint1)
    const size1 = tx1.serialize().length
    const sig1 = await send(conn, tx1, [payer, mint1], 'launch case1 (dev_buy=0)')
    const st1 = await txStats(sig1)
    let bal1 = 0n; try { bal1 = (await getAccount(conn, ata1)).amount } catch {}
    console.log(`pool1               : ${pool1.toBase58()}`)
    console.log(`caller base balance : ${bal1} (expect 0 / no ATA)`)
    console.log(`CU consumed         : ${st1.cu}`)
    console.log(`serialized tx size  : ${size1} bytes (limit 1232)`)

    // confirm config + fee claimer on the created pool
    const poolState1 = await retry('pool1', () => client.state.getPool(pool1))
    console.log(`pool1.config        : ${poolState1!.poolState.config.toBase58()}  == platform config ? ${poolState1!.poolState.config.equals(configKp.publicKey)}`)
    console.log(`config.feeClaimer   : ${cfg.feeClaimer.toBase58()}  == global PDA ? ${cfg.feeClaimer.equals(feePda)}`)

    // ---------------------------------------------------------------------
    header('Size the dev buy from pool1 quote (find lamports for ~2.9% and ~3.1%)')
    const cap = TOTAL_SUPPLY_BASE_UNITS.muln(3).divn(100)
    console.log(`total supply (base units) : ${TOTAL_SUPPLY_BASE_UNITS.toString()}`)
    console.log(`3% cap (base units)       : ${cap.toString()}`)
    const cfgState = await retry('cfgs', () => client.state.getPoolConfig(configKp.publicKey))
    async function tokensFor(lamports: number): Promise<BN> {
        const q = client.pool.swapQuote({ virtualPool: poolState1!, config: cfgState, swapBaseForQuote: false, amountIn: new BN(lamports), slippageBps: 5000, hasReferral: false, eligibleForFirstSwapWithMinFee: false, currentPoint: new BN(Math.floor(Date.now() / 1000)) }) as any
        return q.outputAmount as BN
    }
    // binary search lamports so acquired ~= 2.9% (under) for case 2
    const target2 = TOTAL_SUPPLY_BASE_UNITS.muln(29).divn(1000) // 2.9%
    let lo = 1000, hi = 200_000_000, under = 1000
    for (let i = 0; i < 40; i++) {
        const mid = Math.floor((lo + hi) / 2)
        let out: BN; try { out = await tokensFor(mid) } catch { hi = mid; continue }
        if (out.lte(target2)) { under = mid; lo = mid + 1 } else hi = mid - 1
        if (lo > hi) break
    }
    const case2Lamports = under
    const case2Tokens = await tokensFor(case2Lamports)
    // for case 3: lamports that yield > 3%
    let over = case2Lamports
    for (let i = 0; i < 40; i++) {
        over = Math.floor(over * 1.15) + 1000
        let out: BN; try { out = await tokensFor(over) } catch { break }
        if (out.gt(cap)) break
    }
    const case3Lamports = over
    const case3Tokens = await tokensFor(case3Lamports)
    console.log(`case2: ${case2Lamports} lamports -> ${case2Tokens.toString()} tokens = ${(case2Tokens.toNumber() / TOTAL_SUPPLY_BASE_UNITS.toNumber() * 100).toFixed(4)}% (under 3%)`)
    console.log(`case3: ${case3Lamports} lamports -> ${case3Tokens.toString()} tokens = ${(case3Tokens.toNumber() / TOTAL_SUPPLY_BASE_UNITS.toNumber() * 100).toFixed(4)}% (over 3%)`)

    // ---------------------------------------------------------------------
    header('CASE 2: dev buy just under 3% (succeeds)')
    const mint2 = persisted('mint-case2')
    const { tx: tx2, pool: pool2, devBaseAta: ata2 } = buildLaunchTx(mint2, 'H2E Two', 'H2E2', new BN(case2Lamports), 600_000)
    tx2.feePayer = payer.publicKey
    tx2.recentBlockhash = (await retry('bh', () => conn.getLatestBlockhash('finalized'))).blockhash
    tx2.sign(payer, mint2)
    const size2 = tx2.serialize().length
    const sig2 = await send(conn, tx2, [payer, mint2], 'launch case2 (under 3%)')
    const st2 = await txStats(sig2)
    const bal2 = (await getAccount(conn, ata2)).amount
    const pct2 = Number(bal2) / TOTAL_SUPPLY_BASE_UNITS.toNumber() * 100
    console.log(`pool2               : ${pool2.toBase58()}`)
    console.log(`dev acquired        : ${bal2} base units = ${pct2.toFixed(4)}% of supply`)
    console.log(`CU consumed         : ${st2.cu}`)
    console.log(`serialized tx size  : ${size2} bytes (limit 1232)`)

    // ---------------------------------------------------------------------
    header('CASE 3: dev buy over 3% (whole tx must fail, no pool created)')
    const mint3 = persisted('mint-case3')
    const { tx: tx3, pool: pool3 } = buildLaunchTx(mint3, 'H2E Three', 'H2E3', new BN(case3Lamports), 600_000)
    let case3Failed = false, case3Err = ''
    try {
        await send(conn, tx3, [payer, mint3], 'launch case3 (over 3%)')
    } catch (e: any) {
        case3Failed = true
        const logs = (e?.logs ?? e?.transactionLogs ?? []) as string[]
        const anchorLine = logs.find(l => /DevBuyExceedsCap|Error Code|custom program error/.test(l))
        case3Err = anchorLine ?? e?.message?.split('\n')[0] ?? String(e)
    }
    const pool3Info = await retry('pool3?', () => conn.getAccountInfo(pool3))
    console.log(`case3 failed        : ${case3Failed}`)
    console.log(`case3 error         : ${case3Err}`)
    console.log(`pool3 account exists : ${pool3Info !== null} (expect false — atomic rollback)`)

    // ---------------------------------------------------------------------
    header('Confirm pool2 behaves like earlier pools: trade -> partner_quote_fee to PDA')
    const before = (await retry('p2a', () => client.state.getPool(pool2)))!.poolState.partnerQuoteFee
    const buyTx = await client.pool.swap({ owner: payer.publicKey, pool: pool2, amountIn: new BN(0.02 * LAMPORTS_PER_SOL), minimumAmountOut: new BN(0), swapBaseForQuote: false, referralTokenAccount: null })
    await send(conn, buyTx, [payer], 'trade on pool2')
    const after = (await retry('p2b', () => client.state.getPool(pool2)))!.poolState
    console.log(`partner_quote_fee before : ${before.toString()}`)
    console.log(`partner_quote_fee after  : ${after.partnerQuoteFee.toString()}`)
    console.log(`partner_base_fee         : ${after.partnerBaseFee.toString()} (expect 0)`)
    console.log(`fee accrues to config.feeClaimer = global PDA ? ${cfg.feeClaimer.equals(feePda)}`)

    header('SUMMARY')
    console.log(`case1 (dev_buy=0)  : CU=${st1.cu}  size=${size1}B  pool=${pool1.toBase58()}`)
    console.log(`case2 (under 3%)   : CU=${st2.cu}  size=${size2}B  acquired=${pct2.toFixed(4)}%  pool=${pool2.toBase58()}`)
    console.log(`case3 (over 3%)    : failed=${case3Failed}  pool_created=${pool3Info !== null}`)
    console.log(`CU limit 1,400,000 ; tx size limit 1232 bytes`)
}

main().catch(e => { console.error('\n!!! FATAL !!!'); console.error(e); const l = e?.logs ?? e?.transactionLogs; if (l) console.error('logs:\n' + l.join('\n')); process.exit(1) })
