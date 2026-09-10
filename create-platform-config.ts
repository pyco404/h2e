// One-time: create a DBC partner config on devnet whose feeClaimer is THIS
// program's global ["fee"] PDA, so it can be cloned into the local validator.
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import BN from 'bn.js'
import fs from 'fs'
import {
    DynamicBondingCurveClient, buildCurve, BaseFeeMode, CollectFeeMode, ActivationType,
    MigrationOption, MigrationFeeOption, TokenType, TokenDecimal, TokenAuthorityOption,
} from '@meteora-ag/dynamic-bonding-curve-sdk'

const RPC = fs.readFileSync('.helius-url', 'utf8').trim()
const NATIVE_SOL = new PublicKey('So11111111111111111111111111111111111111112')
const FEE_PDA = new PublicKey('Dk6GekyVy1U9FUkD8X8UXQzisq3EuTxi1FPKmHwTU3wD') // ["fee"] of 6SnKPT...
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync('wallets/payer.json', 'utf8'))))

async function main() {
    const conn = new Connection(RPC, 'confirmed')
    const client = DynamicBondingCurveClient.create(conn, 'confirmed')
    const cfgPath = 'h2e/wallets/platform-config.json'
    const configKp = fs.existsSync(cfgPath)
        ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(cfgPath, 'utf8'))))
        : Keypair.generate()
    fs.mkdirSync('h2e/wallets', { recursive: true })
    fs.writeFileSync(cfgPath, JSON.stringify(Array.from(configKp.secretKey)))

    if (await conn.getAccountInfo(configKp.publicKey)) {
        console.log('config already exists:', configKp.publicKey.toBase58())
    } else {
        const curve = buildCurve({
            token: { tokenType: TokenType.SPLToken, tokenBaseDecimal: TokenDecimal.SIX, tokenQuoteDecimal: TokenDecimal.NINE, tokenAuthorityOption: TokenAuthorityOption.Immutable, totalTokenSupply: 1_000_000_000, leftover: 0 },
            fee: { baseFeeParams: { baseFeeMode: BaseFeeMode.FeeSchedulerExponential, feeSchedulerParam: { startingFeeBps: 1000, endingFeeBps: 200, numberOfPeriod: 30, totalDuration: 300 } }, dynamicFeeEnabled: false, collectFeeMode: CollectFeeMode.QuoteToken, creatorTradingFeePercentage: 0, poolCreationFee: 0, enableFirstSwapWithMinFee: false },
            migration: { migrationOption: MigrationOption.MET_DAMM_V2, migrationFeeOption: MigrationFeeOption.FixedBps100, migrationFee: { feePercentage: 0, creatorFeePercentage: 0 } },
            liquidityDistribution: { partnerPermanentLockedLiquidityPercentage: 100, partnerLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: 0, creatorLiquidityPercentage: 0 },
            lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
            activationType: ActivationType.Timestamp, percentageSupplyOnMigration: 20, migrationQuoteThreshold: 5,
        })
        curve.poolFees.baseFee = { cliffFeeNumerator: new BN(100_000_000), firstFactor: 30, secondFactor: new BN(10), thirdFactor: new BN(522), baseFeeMode: BaseFeeMode.FeeSchedulerExponential } as any
        curve.poolFees.dynamicFee = null
        const tx = await client.partner.createConfig({ config: configKp.publicKey, feeClaimer: FEE_PDA, leftoverReceiver: payer.publicKey, quoteMint: NATIVE_SOL, payer: payer.publicKey, ...curve })
        const { blockhash } = await conn.getLatestBlockhash('finalized')
        tx.recentBlockhash = blockhash; tx.feePayer = payer.publicKey
        const sig = await conn.sendTransaction(tx, [payer, configKp]); await conn.confirmTransaction(sig, 'confirmed')
        console.log('created config tx:', sig)
    }
    const cfg = await client.state.getPoolConfig(configKp.publicKey)
    console.log('platform config :', configKp.publicKey.toBase58())
    console.log('feeClaimer      :', cfg.feeClaimer.toBase58(), '== fee PDA?', cfg.feeClaimer.equals(FEE_PDA))
    fs.writeFileSync('h2e/tests/fixtures/platform-config.txt', configKp.publicKey.toBase58())
}
main().catch(e => { console.error(e); process.exit(1) })
