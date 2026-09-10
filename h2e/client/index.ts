/**
 * H2E on-chain client — the single, shared way every caller (tests, keeper,
 * frontend) builds instructions for the H2E program.
 *
 * WHY THIS EXISTS (read before "simplifying" back to program.methods):
 *
 *   Anchor 0.32.1's toolchain is internally inconsistent for struct-arg field
 *   names that contain a digit→letter boundary, e.g. `h2e_bps`:
 *     - the generated TS types (target/types/h2e.ts) name it `h2eBps`
 *     - the runtime `new Program(idl)` IDL loader expects `h2EBps`
 *   So `program.methods.initializeGlobal({ h2eBps })` type-checks against the
 *   generated types yet serializes `h2e_bps = 0` at runtime — silently. That
 *   already happened once (all-zero split → InvalidSplit). There is no 1.x
 *   `@coral-xyz/anchor` on npm to upgrade to, so the client-side bug cannot be
 *   fixed by a toolchain bump.
 *
 * THE FIX: bypass the buggy Program-level camelCase transform. We use Anchor's
 * own `BorshInstructionCoder` / `BorshAccountsCoder` against the RAW JSON IDL,
 * whose field names are the real snake_case Rust names. Encoding/decoding is
 * therefore name-exact and matches the spec's field names verbatim — no casing
 * guesswork. Every encode is round-tripped (encode → decode → compare) so a
 * mismatch throws instead of shipping zeros.
 *
 * This is not hand-rolled byte math: it is the official Anchor coder, invoked
 * with the canonical IDL. All instruction builders live here; nothing else in
 * the codebase encodes program data.
 */
import {
    BorshInstructionCoder, BorshAccountsCoder, BN,
} from '@coral-xyz/anchor'
import {
    PublicKey, TransactionInstruction, SystemProgram, Connection,
} from '@solana/web3.js'
import bs58 from 'bs58'
import {
    getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
    createSyncNativeInstruction, createCloseAccountInstruction, NATIVE_MINT, TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import {
    deriveDbcPoolAddress, deriveDbcTokenVaultAddress, deriveMintMetadata,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import rawIdl from '../target/idl/h2e.json'

export { BN }
export const idl = rawIdl as any
export const PROGRAM_ID = new PublicKey(idl.address)

const BPF_LOADER_UPGRADEABLE = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111')
const ixCoder = new BorshInstructionCoder(idl)
const accCoder = new BorshAccountsCoder(idl)

// ---- PDAs ----------------------------------------------------------------
/** PDA seed strings — must match the program's seed constants exactly. */
export const SEEDS = {
    global: 'global',
    coin: 'coin',
    fee: 'fee',       // global FeeClaimer
    vault: 'vault',   // per-mint FeeAuthority
    payout: 'payout', // per-mint PayoutAuthority
    revenue: 'revenue', // global RevenueAuthority
} as const

/** WSOL mint — the only asset H2E ever holds in the fee/revenue vaults. */
export const WSOL_MINT = NATIVE_MINT

/**
 * PDA derivations. `FeeClaimer` and `RevenueAuthority` are global (no mint);
 * `FeeAuthority` and `PayoutAuthority` are per-mint. Each PDA is an AUTHORITY
 * that owns token account(s); the PDA itself is not a token account (spec §4).
 */
export const pdas = {
    global: (): PublicKey =>
        PublicKey.findProgramAddressSync([Buffer.from(SEEDS.global)], PROGRAM_ID)[0],
    programData: (): PublicKey =>
        PublicKey.findProgramAddressSync([PROGRAM_ID.toBuffer()], BPF_LOADER_UPGRADEABLE)[0],
    coinConfig: (mint: PublicKey): PublicKey =>
        PublicKey.findProgramAddressSync([Buffer.from(SEEDS.coin), mint.toBuffer()], PROGRAM_ID)[0],
    /** Global DBC fee claimer; signs all claims, owns locked positions. */
    feeClaimer: (): PublicKey =>
        PublicKey.findProgramAddressSync([Buffer.from(SEEDS.fee)], PROGRAM_ID)[0],
    /** Per-coin authority over the claimed-fees (pre-split) WSOL ATA. */
    feeAuthority: (mint: PublicKey): PublicKey =>
        PublicKey.findProgramAddressSync([Buffer.from(SEEDS.vault), mint.toBuffer()], PROGRAM_ID)[0],
    /** Per-coin authority over the 60% payout ATAs (WSOL + one per elected asset). */
    payoutAuthority: (mint: PublicKey): PublicKey =>
        PublicKey.findProgramAddressSync([Buffer.from(SEEDS.payout), mint.toBuffer()], PROGRAM_ID)[0],
    /** Global authority over the 30% revenue accruing for $H2E holders. */
    revenueAuthority: (): PublicKey =>
        PublicKey.findProgramAddressSync([Buffer.from(SEEDS.revenue)], PROGRAM_ID)[0],
    /** Admin-managed denylist singleton. */
    denylist: (): PublicKey =>
        PublicKey.findProgramAddressSync([Buffer.from('denylist')], PROGRAM_ID)[0],
    epochState: (mint: PublicKey, epochIndex: number): PublicKey => {
        const b = Buffer.alloc(4); b.writeUInt32LE(epochIndex)
        return PublicKey.findProgramAddressSync([Buffer.from('epoch'), mint.toBuffer(), b], PROGRAM_ID)[0]
    },
    bucketState: (mint: PublicKey, epochIndex: number, outMint: PublicKey): PublicKey => {
        const b = Buffer.alloc(4); b.writeUInt32LE(epochIndex)
        return PublicKey.findProgramAddressSync([Buffer.from('bucket'), mint.toBuffer(), b, outMint.toBuffer()], PROGRAM_ID)[0]
    },
    allowlistState: (mint: PublicKey, epochIndex: number): PublicKey => {
        const b = Buffer.alloc(4); b.writeUInt32LE(epochIndex)
        return PublicKey.findProgramAddressSync([Buffer.from('allow'), mint.toBuffer(), b], PROGRAM_ID)[0]
    },
    /** Standing admin-maintained payout-asset allowlist singleton (Task 1.9). */
    platformAllowlist: (): PublicKey =>
        PublicKey.findProgramAddressSync([Buffer.from('allowlist')], PROGRAM_ID)[0],
}

/** Pinned swap venue — the stub aggregator under the `stub-jupiter` build,
 *  Jupiter v6 in production. Must match the program's `JUPITER_PROGRAM` const. */
export const JUPITER_PROGRAM = new PublicKey('FzTPacLNTLbxtVfHyjWofffuiSf41iYuESjsqnkwNjqD')

/**
 * WSOL ATA owned by `FeeAuthority(mint)`. This is the constrained claim
 * destination from spec §5 — `claim_and_sweep` derives and pins it in-instruction
 * so a claim's proceeds can only land here. `allowOwnerOffCurve = true` because
 * the owner is a PDA.
 */
export function feeAuthorityWsolAta(mint: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(WSOL_MINT, pdas.feeAuthority(mint), true)
}

// ---- encode with round-trip guard ---------------------------------------
/** Normalise a value (PublicKey -> base58, BN -> decimal, enum/struct keys ->
 *  camelCase) so sent and decoded forms compare structurally regardless of the
 *  coder's casing or wrapper types. */
function norm(v: any): any {
    if (v === null || v === undefined) return null
    // Duck-type PublicKey and BN, not instanceof: once this module is bundled
    // (the frontend does this), a value can be a PublicKey/BN from a different
    // copy of the class and fail instanceof, silently falling through to the
    // object branch. toBase58/toString are stable across instances.
    if (v instanceof PublicKey || typeof v?.toBase58 === 'function') return v.toBase58()
    // BN duck-type: `.words` + `.toArray` are BN-internal and absent on PublicKey
    // (already handled above), so this is safe across BN copies.
    if (BN.isBN(v) || (Array.isArray(v?.words) && typeof v?.toArray === 'function' && typeof v?.toString === 'function')) return v.toString()
    if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Array.from(v as any).map(norm)
    if (Array.isArray(v)) return v.map(norm)
    if (typeof v === 'object') {
        const o: Record<string, any> = {}
        for (const [k, val] of Object.entries(v)) o[k.charAt(0).toLowerCase() + k.slice(1)] = norm(val)
        return o
    }
    return v
}
const deepMatch = (a: any, b: any) => JSON.stringify(norm(a)) === JSON.stringify(norm(b))

/**
 * Encode an instruction and immediately decode it back, asserting every input
 * argument survived the round trip. Makes silent mis-serialization impossible
 * (the h2e_bps -> 0 class of bug). Handles struct, enum and Option args.
 */
function encodeChecked(name: string, argFields: Record<string, any>): Buffer {
    const data = ixCoder.encode(name, argFields)
    const decoded = ixCoder.decode(data)
    if (!decoded || decoded.name !== name) {
        throw new Error(`[h2e client] round-trip failed: could not decode "${name}"`)
    }
    for (const [argName, argVal] of Object.entries(argFields)) {
        if (!deepMatch(argVal, (decoded.data as any)[argName])) {
            throw new Error(`[h2e client] round-trip mismatch on "${name}".${argName}: sent ${JSON.stringify(norm(argVal))}, got ${JSON.stringify(norm((decoded.data as any)[argName]))}`)
        }
    }
    return data
}

// ---- initialize_global ----// ---- initialize_global ---------------------------------------------------
/** Params for `initialize_global`. Keys are the spec's field names verbatim. */
export interface InitializeGlobalParams {
    admin: PublicKey
    keeper: PublicKey
    platform_wallet: PublicKey
    platform_config_key: PublicKey
    usdc_mint: PublicKey
    holder_bps: number
    h2e_bps: number
    platform_bps: number
    dev_buy_cap_bps: number
    holder_cap_bps: number
    epoch_seconds: BN
    h2e_epoch_seconds: BN
    max_slippage_bps: number
    min_sweep_lamports: BN
    pool_creation_fee_lamports: BN
    paused: boolean
    pause_launches: boolean
}

/**
 * Build the `initialize_global` instruction. `authority` must be the program's
 * upgrade authority and signs the transaction.
 */
export function initializeGlobalIx(
    params: InitializeGlobalParams,
    authority: PublicKey,
): TransactionInstruction {
    const data = encodeChecked('initialize_global', { params })
    // Account order matches the IDL for initialize_global.
    const keys = [
        { pubkey: authority, isSigner: true, isWritable: true },
        { pubkey: pdas.global(), isSigner: false, isWritable: true },
        { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: pdas.programData(), isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ]
    return new TransactionInstruction({ programId: PROGRAM_ID, keys, data })
}

// ---- account decoders ----------------------------------------------------
/** Decode a `GlobalConfig` account. Returned keys are the spec's snake_case names. */
export function decodeGlobalConfig(accountData: Buffer): any {
    return accCoder.decode('GlobalConfig', accountData)
}

// ---- external program ids (must match the program's constants) ----
export const DBC_PROGRAM = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN')
export const DBC_POOL_AUTHORITY = new PublicKey('FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM')
export const DBC_EVENT_AUTHORITY = new PublicKey('8Ks12pbrD6PXxfty1hVQiE9sc289zgU1zHkvXhrSdriF')
export const METADATA_PROGRAM = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s')
export const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
export const CP_AMM_PROGRAM = new PublicKey('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG')
export const CP_AMM_POOL_AUTHORITY = new PublicKey('HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC')
export const CP_AMM_EVENT_AUTHORITY = new PublicKey('3rmHSu74h1ZcmAisVcWerTCiRDQbUrBKmcwptYGjHfet')

/** Decode a `CoinConfig` account. Returned keys are the spec's snake_case names. */
export function decodeCoinConfig(accountData: Buffer): any {
    return accCoder.decode('CoinConfig', accountData)
}

/** Encode a CoinConfig account (discriminator + borsh) — used to preload a
 *  synthetic non-Bonding coin for testing the status guard. */
export async function encodeCoinConfig(obj: any): Promise<Buffer> {
    return accCoder.encode('CoinConfig', obj)
}

export interface LaunchCoinParams {
    name: string
    symbol: string
    uri: string
    dev_buy_lamports: BN
    /** Creator's permanent payout pairing; must be in PlatformAllowlist (Task 1.9). */
    default_payout_mint: PublicKey
}

export interface LaunchCoinAccounts {
    /** Creator = payer = dev buyer; signs. */
    payer: PublicKey
    /** Fresh base-mint keypair; signs. */
    baseMint: PublicKey
    /** The platform DBC config (must equal GlobalConfig.platform_config_key). */
    config: PublicKey
    /** Must equal GlobalConfig.platform_wallet. */
    platformWallet: PublicKey
}

/** All non-signer addresses this instruction touches — load these into an ALT. */
export function launchCoinAltAddresses(a: LaunchCoinAccounts): PublicKey[] {
    const d = launchCoinDerived(a)
    return [
        pdas.global(), pdas.platformAllowlist(), a.config, DBC_POOL_AUTHORITY, WSOL_MINT, d.pool, d.baseVault,
        d.quoteVault, d.mintMetadata, METADATA_PROGRAM, d.devQuoteAta, d.devBaseAta,
        d.coinConfig, a.platformWallet, TOKEN_PROGRAM_ID, ATA_PROGRAM, DBC_EVENT_AUTHORITY,
        DBC_PROGRAM, SystemProgram.programId, PROGRAM_ID,
    ]
}

function launchCoinDerived(a: LaunchCoinAccounts) {
    const pool = deriveDbcPoolAddress(WSOL_MINT, a.baseMint, a.config)
    return {
        pool,
        baseVault: deriveDbcTokenVaultAddress(pool, a.baseMint),
        quoteVault: deriveDbcTokenVaultAddress(pool, WSOL_MINT),
        mintMetadata: deriveMintMetadata(a.baseMint),
        devQuoteAta: getAssociatedTokenAddressSync(WSOL_MINT, a.payer),
        devBaseAta: getAssociatedTokenAddressSync(a.baseMint, a.payer),
        coinConfig: pdas.coinConfig(a.baseMint),
    }
}

/**
 * Build the `launch_coin` instruction. Account order matches the LaunchCoin
 * struct in the program exactly. The dev-buy WSOL account is funded by the
 * wrap-SOL pre-instructions (see `wrapSolIxs`); the instruction itself creates
 * the dev base ATA, does the buy, and enforces the supply cap.
 */
export function launchCoinIx(params: LaunchCoinParams, accounts: LaunchCoinAccounts): TransactionInstruction {
    const d = launchCoinDerived(accounts)
    const data = encodeChecked('launch_coin', {
        name: params.name, symbol: params.symbol, uri: params.uri,
        dev_buy_lamports: params.dev_buy_lamports,
        default_payout_mint: params.default_payout_mint,
    })
    const rw = (pubkey: PublicKey, isWritable: boolean, isSigner = false) => ({ pubkey, isSigner, isWritable })
    const keys = [
        rw(accounts.payer, true, true),
        rw(accounts.baseMint, true, true),
        rw(pdas.global(), false),
        rw(pdas.platformAllowlist(), false),
        rw(accounts.config, false),
        rw(DBC_POOL_AUTHORITY, false),
        rw(WSOL_MINT, false),
        rw(d.pool, true),
        rw(d.baseVault, true),
        rw(d.quoteVault, true),
        rw(d.mintMetadata, true),
        rw(METADATA_PROGRAM, false),
        rw(d.devQuoteAta, true),
        rw(d.devBaseAta, true),
        rw(d.coinConfig, true),
        rw(accounts.platformWallet, true),
        rw(TOKEN_PROGRAM_ID, false),
        rw(TOKEN_PROGRAM_ID, false),
        rw(ATA_PROGRAM, false),
        rw(DBC_EVENT_AUTHORITY, false),
        rw(DBC_PROGRAM, false),
        rw(SystemProgram.programId, false),
    ]
    return new TransactionInstruction({ programId: PROGRAM_ID, keys, data })
}

/** Pre-instructions that wrap `lamports` of SOL into the payer's WSOL ATA (the
 *  dev-buy input). Returns the ixs and the WSOL ATA address. */
export function wrapSolIxs(payer: PublicKey, lamports: BN): { ixs: TransactionInstruction[]; wsolAta: PublicKey } {
    const wsolAta = getAssociatedTokenAddressSync(WSOL_MINT, payer)
    return {
        wsolAta,
        ixs: [
            createAssociatedTokenAccountIdempotentInstruction(payer, wsolAta, payer, WSOL_MINT),
            SystemProgram.transfer({ fromPubkey: payer, toPubkey: wsolAta, lamports: BigInt(lamports.toString()) }),
            createSyncNativeInstruction(wsolAta),
        ],
    }
}

/** Post-instruction that unwraps the payer's WSOL ATA back to SOL. */
export function closeWsolIx(payer: PublicKey): TransactionInstruction {
    return createCloseAccountInstruction(getAssociatedTokenAddressSync(WSOL_MINT, payer), payer, payer)
}

// ==========================================================================
// Admin instructions (Task 1.4). All gated on GlobalConfig.admin.
// ==========================================================================

const adminKeys = (admin: PublicKey) => [
    { pubkey: pdas.global(), isSigner: false, isWritable: true },
    { pubkey: admin, isSigner: true, isWritable: false },
]

export interface SetParamsArgs {
    holder_bps: number
    h2e_bps: number
    platform_bps: number
    dev_buy_cap_bps: number
    holder_cap_bps: number
    epoch_seconds: BN
    h2e_epoch_seconds: BN
    max_slippage_bps: number
    min_sweep_lamports: BN
    pool_creation_fee_lamports: BN
    usdc_mint: PublicKey
}

export function setParamsIx(args: SetParamsArgs, admin: PublicKey): TransactionInstruction {
    const data = encodeChecked('set_params', { args })
    return new TransactionInstruction({ programId: PROGRAM_ID, keys: adminKeys(admin), data })
}

export function setKeeperIx(newKeeper: PublicKey, admin: PublicKey): TransactionInstruction {
    const data = encodeChecked('set_keeper', { new_keeper: newKeeper })
    return new TransactionInstruction({ programId: PROGRAM_ID, keys: adminKeys(admin), data })
}

export function setAdminIx(newAdmin: PublicKey, admin: PublicKey): TransactionInstruction {
    const data = encodeChecked('set_admin', { new_admin: newAdmin })
    return new TransactionInstruction({ programId: PROGRAM_ID, keys: adminKeys(admin), data })
}

export function setPlatformWalletIx(newWallet: PublicKey, admin: PublicKey): TransactionInstruction {
    const data = encodeChecked('set_platform_wallet', { new_wallet: newWallet })
    return new TransactionInstruction({ programId: PROGRAM_ID, keys: adminKeys(admin), data })
}

export function setPlatformConfigKeyIx(newConfig: PublicKey, admin: PublicKey): TransactionInstruction {
    const data = encodeChecked('set_platform_config_key', { new_config: newConfig })
    return new TransactionInstruction({ programId: PROGRAM_ID, keys: adminKeys(admin), data })
}

export function setUsdcMintIx(newUsdcMint: PublicKey, admin: PublicKey): TransactionInstruction {
    const data = encodeChecked('set_usdc_mint', { new_usdc_mint: newUsdcMint })
    return new TransactionInstruction({ programId: PROGRAM_ID, keys: adminKeys(admin), data })
}

export function retireCoinIx(mint: PublicKey, admin: PublicKey): TransactionInstruction {
    const data = encodeChecked('retire_coin', {})
    const keys = [
        { pubkey: pdas.global(), isSigner: false, isWritable: false },
        { pubkey: admin, isSigner: true, isWritable: false },
        { pubkey: pdas.coinConfig(mint), isSigner: false, isWritable: true },
    ]
    return new TransactionInstruction({ programId: PROGRAM_ID, keys, data })
}

export interface SyncGraduationAccounts {
    caller: PublicKey
    mint: PublicKey
    dbcPool: PublicKey
    dammPool: PublicKey
    lockedPosition: PublicKey
    positionNftAccount: PublicKey
}
export function syncGraduationIx(a: SyncGraduationAccounts): TransactionInstruction {
    const data = encodeChecked('sync_graduation', {})
    const keys = [
        { pubkey: a.caller, isSigner: true, isWritable: false },
        { pubkey: pdas.coinConfig(a.mint), isSigner: false, isWritable: true },
        { pubkey: a.mint, isSigner: false, isWritable: false },
        { pubkey: pdas.feeClaimer(), isSigner: false, isWritable: false },
        { pubkey: a.dbcPool, isSigner: false, isWritable: false },
        { pubkey: a.dammPool, isSigner: false, isWritable: false },
        { pubkey: a.lockedPosition, isSigner: false, isWritable: false },
        { pubkey: a.positionNftAccount, isSigner: false, isWritable: false },
    ]
    return new TransactionInstruction({ programId: PROGRAM_ID, keys, data })
}

/** `mint = null` clears it; `enable` cannot be true while the mint is null. */
export function setH2eMintIx(mint: PublicKey | null, enable: boolean, admin: PublicKey): TransactionInstruction {
    const data = encodeChecked('set_h2e_mint', { mint, enable })
    return new TransactionInstruction({ programId: PROGRAM_ID, keys: adminKeys(admin), data })
}

export function pauseIx(paused: boolean, pauseLaunches: boolean, admin: PublicKey): TransactionInstruction {
    const data = encodeChecked('pause', { paused, pause_launches: pauseLaunches })
    return new TransactionInstruction({ programId: PROGRAM_ID, keys: adminKeys(admin), data })
}

/** Denylist entry kind — encode values for the DenyKind enum arg. */
export const DenyKind = {
    PayoutAddress: { PayoutAddress: {} },
    PayoutMint: { PayoutMint: {} },
} as const

export function initDenylistIx(admin: PublicKey): TransactionInstruction {
    const data = encodeChecked('init_denylist', {})
    const keys = [
        { pubkey: pdas.global(), isSigner: false, isWritable: false },
        { pubkey: admin, isSigner: true, isWritable: true },
        { pubkey: pdas.denylist(), isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ]
    return new TransactionInstruction({ programId: PROGRAM_ID, keys, data })
}

export function setDenylistIx(kind: typeof DenyKind[keyof typeof DenyKind], key: PublicKey, add: boolean, admin: PublicKey): TransactionInstruction {
    const data = encodeChecked('set_denylist', { kind, key, add })
    const keys = [
        { pubkey: pdas.global(), isSigner: false, isWritable: false },
        { pubkey: admin, isSigner: true, isWritable: false },
        { pubkey: pdas.denylist(), isSigner: false, isWritable: true },
    ]
    return new TransactionInstruction({ programId: PROGRAM_ID, keys, data })
}

export function decodeDenylist(accountData: Buffer): any {
    return accCoder.decode('Denylist', accountData)
}

// ---- platform allowlist (Task 1.9) --------------------------------------
export function initPlatformAllowlistIx(admin: PublicKey): TransactionInstruction {
    const data = encodeChecked('init_platform_allowlist', {})
    const keys = [
        { pubkey: pdas.global(), isSigner: false, isWritable: false },
        { pubkey: admin, isSigner: true, isWritable: true },
        { pubkey: pdas.platformAllowlist(), isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ]
    return new TransactionInstruction({ programId: PROGRAM_ID, keys, data })
}

export function setPlatformAllowlistIx(mint: PublicKey, add: boolean, admin: PublicKey): TransactionInstruction {
    const data = encodeChecked('set_platform_allowlist', { mint, add })
    const keys = [
        { pubkey: pdas.global(), isSigner: false, isWritable: false },
        { pubkey: admin, isSigner: true, isWritable: false },
        { pubkey: pdas.platformAllowlist(), isSigner: false, isWritable: true },
    ]
    return new TransactionInstruction({ programId: PROGRAM_ID, keys, data })
}

export function decodePlatformAllowlist(accountData: Buffer): any {
    return accCoder.decode('PlatformAllowlist', accountData)
}

// ==========================================================================
// claim_and_sweep (bonding path) — Task 1.5
// ==========================================================================

const ata = (mint: PublicKey, owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true)

/** The WSOL ATAs and base ATA the sweep reads/writes. */
export function sweepAtas(mint: PublicKey, platformWallet: PublicKey) {
    const feeAuthority = pdas.feeAuthority(mint)
    return {
        feeAuthority,
        feeWsolAta: ata(WSOL_MINT, feeAuthority),
        feeBaseAta: ata(mint, feeAuthority),
        payoutAuthority: pdas.payoutAuthority(mint),
        payoutWsolAta: ata(WSOL_MINT, pdas.payoutAuthority(mint)),
        revenueAuthority: pdas.revenueAuthority(),
        revenueWsolAta: ata(WSOL_MINT, pdas.revenueAuthority()),
        platformWsolAta: ata(WSOL_MINT, platformWallet),
    }
}

/** Idempotent pre-instructions that create the five sweep destination ATAs.
 *  `payer` funds any that do not exist yet (one-time per coin/global). */
export function sweepAtaIxs(mint: PublicKey, platformWallet: PublicKey, payer: PublicKey): TransactionInstruction[] {
    const a = sweepAtas(mint, platformWallet)
    return [
        createAssociatedTokenAccountIdempotentInstruction(payer, a.feeWsolAta, a.feeAuthority, WSOL_MINT),
        createAssociatedTokenAccountIdempotentInstruction(payer, a.feeBaseAta, a.feeAuthority, mint),
        createAssociatedTokenAccountIdempotentInstruction(payer, a.payoutWsolAta, a.payoutAuthority, WSOL_MINT),
        createAssociatedTokenAccountIdempotentInstruction(payer, a.revenueWsolAta, a.revenueAuthority, WSOL_MINT),
        createAssociatedTokenAccountIdempotentInstruction(payer, a.platformWsolAta, platformWallet, WSOL_MINT),
    ]
}

export interface ClaimAndSweepAccounts {
    caller: PublicKey
    mint: PublicKey
    config: PublicKey        // platform config (= GlobalConfig.platform_config_key)
    platformWallet: PublicKey // = GlobalConfig.platform_wallet
}

/** cp-amm rail accounts for the graduated sweep path (remaining_accounts). */
export interface GraduatedRail {
    dammPool: PublicKey
    position: PublicKey
    tokenAVault: PublicKey
    tokenBVault: PublicKey
    positionNftAccount: PublicKey
}

export function claimAndSweepAltAddresses(a: ClaimAndSweepAccounts, g?: GraduatedRail): PublicKey[] {
    const s = sweepAtas(a.mint, a.platformWallet)
    const pool = deriveDbcPoolAddress(WSOL_MINT, a.mint, a.config)
    const base = [
        pdas.global(), pdas.coinConfig(a.mint), a.mint, WSOL_MINT, pdas.feeClaimer(), s.feeAuthority,
        s.feeWsolAta, s.feeBaseAta, s.payoutAuthority, s.payoutWsolAta, s.revenueAuthority, s.revenueWsolAta,
        a.platformWallet, s.platformWsolAta, a.config, DBC_POOL_AUTHORITY, pool,
        deriveDbcTokenVaultAddress(pool, a.mint), deriveDbcTokenVaultAddress(pool, WSOL_MINT),
        DBC_EVENT_AUTHORITY, DBC_PROGRAM, TOKEN_PROGRAM_ID, PROGRAM_ID,
    ]
    if (g) base.push(CP_AMM_POOL_AUTHORITY, g.dammPool, g.position, g.tokenAVault, g.tokenBVault, g.positionNftAccount, CP_AMM_EVENT_AUTHORITY, CP_AMM_PROGRAM)
    return base
}

/** Build claim_and_sweep. Account order matches the ClaimAndSweep struct exactly. */
export function claimAndSweepIx(a: ClaimAndSweepAccounts, g?: GraduatedRail): TransactionInstruction {
    const s = sweepAtas(a.mint, a.platformWallet)
    const pool = deriveDbcPoolAddress(WSOL_MINT, a.mint, a.config)
    const data = encodeChecked('claim_and_sweep', {})
    const ro = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: false })
    const rw = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: true })
    const keys = [
        ro(a.caller, true),
        ro(pdas.global()),
        rw(pdas.coinConfig(a.mint)),
        ro(a.mint),
        ro(WSOL_MINT),
        ro(pdas.feeClaimer()),
        ro(s.feeAuthority),
        rw(s.feeWsolAta),
        rw(s.feeBaseAta),
        ro(s.payoutAuthority),
        rw(s.payoutWsolAta),
        ro(s.revenueAuthority),
        rw(s.revenueWsolAta),
        ro(a.platformWallet),
        rw(s.platformWsolAta),
        ro(a.config),
        ro(DBC_POOL_AUTHORITY),
        rw(pool),
        rw(deriveDbcTokenVaultAddress(pool, a.mint)),
        rw(deriveDbcTokenVaultAddress(pool, WSOL_MINT)),
        ro(DBC_EVENT_AUTHORITY),
        ro(DBC_PROGRAM),
        ro(TOKEN_PROGRAM_ID),
    ]
    if (g) {
        keys.push(
            ro(CP_AMM_POOL_AUTHORITY), ro(g.dammPool), rw(g.position), rw(g.tokenAVault), rw(g.tokenBVault),
            ro(g.positionNftAccount), ro(CP_AMM_EVENT_AUTHORITY), ro(CP_AMM_PROGRAM),
        )
    }
    return new TransactionInstruction({ programId: PROGRAM_ID, keys, data })
}

// ==========================================================================
// Epoch / distribution (Task 1.7)
// ==========================================================================
export function decodeEpochState(d: Buffer): any { return accCoder.decode('EpochState', d) }
export function decodeBucketState(d: Buffer): any { return accCoder.decode('BucketState', d) }

export function decodeAllowlistState(d: Buffer): any { return accCoder.decode('AllowlistState', d) }

export interface SettleEpochArgs { epochIndex: number; totalWeight: BN; merkleRoot: number[]; bucketCount: number; allowedMints: PublicKey[] }
export function settleEpochIx(a: SettleEpochArgs, mint: PublicKey, keeper: PublicKey): TransactionInstruction {
    const data = encodeChecked('settle_epoch', { epoch_index: a.epochIndex, total_weight: a.totalWeight, merkle_root: a.merkleRoot, bucket_count: a.bucketCount, allowed_mints: a.allowedMints })
    const payoutAuthority = pdas.payoutAuthority(mint)
    const keys = [
        { pubkey: pdas.global(), isSigner: false, isWritable: false },
        { pubkey: keeper, isSigner: true, isWritable: true },
        { pubkey: pdas.coinConfig(mint), isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: payoutAuthority, isSigner: false, isWritable: false },
        { pubkey: WSOL_MINT, isSigner: false, isWritable: false },
        { pubkey: getAssociatedTokenAddressSync(WSOL_MINT, payoutAuthority, true), isSigner: false, isWritable: false },
        { pubkey: pdas.epochState(mint, a.epochIndex), isSigner: false, isWritable: true },
        { pubkey: pdas.allowlistState(mint, a.epochIndex), isSigner: false, isWritable: true },
        { pubkey: pdas.platformAllowlist(), isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ]
    return new TransactionInstruction({ programId: PROGRAM_ID, keys, data })
}

export interface DistributeBatchArgs { epochIndex: number; outMint: PublicKey; startIndex: number; recipients: PublicKey[]; amounts: BN[] }
export function distributeBatchIx(a: DistributeBatchArgs, mint: PublicKey, keeper: PublicKey): TransactionInstruction {
    const data = encodeChecked('distribute_batch', { _epoch_index: a.epochIndex, start_index: a.startIndex, recipients: a.recipients, amounts: a.amounts })
    const payoutAuthority = pdas.payoutAuthority(mint)
    const keys = [
        { pubkey: pdas.global(), isSigner: false, isWritable: false },
        { pubkey: keeper, isSigner: true, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: pdas.epochState(mint, a.epochIndex), isSigner: false, isWritable: true },
        { pubkey: pdas.bucketState(mint, a.epochIndex, a.outMint), isSigner: false, isWritable: true },
        { pubkey: a.outMint, isSigner: false, isWritable: false },
        { pubkey: payoutAuthority, isSigner: false, isWritable: false },
        { pubkey: getAssociatedTokenAddressSync(a.outMint, payoutAuthority, true), isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ]
    for (const r of a.recipients) keys.push({ pubkey: getAssociatedTokenAddressSync(a.outMint, r), isSigner: false, isWritable: true })
    return new TransactionInstruction({ programId: PROGRAM_ID, keys, data })
}
/** Addresses for the distribute_batch ALT (static side, excluding recipients). */
export function distributeBatchAltAddresses(a: DistributeBatchArgs, mint: PublicKey): PublicKey[] {
    const payoutAuthority = pdas.payoutAuthority(mint)
    return [pdas.global(), mint, pdas.epochState(mint, a.epochIndex), pdas.bucketState(mint, a.epochIndex, a.outMint), a.outMint, payoutAuthority, getAssociatedTokenAddressSync(a.outMint, payoutAuthority, true), TOKEN_PROGRAM_ID, PROGRAM_ID]
}

// ==========================================================================
// swap_payout (Task 1.8b)
// ==========================================================================

/** A route account for the venue CPI, forwarded verbatim as a remaining account. */
export interface RouteMeta { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }

export interface SwapPayoutArgs {
    epochIndex: number
    outMint: PublicKey
    amountIn: BN
    /** The venue's quoted output — the slippage floor is checked against this. */
    quotedOut: BN
    minOut: BN
    recipientCount: number
    /** Opaque venue swap instruction data (e.g. Jupiter's `swapInstruction.data`). */
    jupData: Buffer
    /** The venue's route accounts (its swap instruction's `keys`). */
    route: RouteMeta[]
}

/**
 * Build `swap_payout`. The keeper obtains `jupData` + `route` from the venue's
 * swap-instruction builder (off-chain), and the program forwards them only to
 * `JUPITER_PROGRAM`, signed by the PayoutAuthority PDA. For `outMint == WSOL`
 * the route is unused (no swap) — pass `[]`.
 */
export function swapPayoutIx(a: SwapPayoutArgs, mint: PublicKey, keeper: PublicKey): TransactionInstruction {
    const data = encodeChecked('swap_payout', {
        _epoch_index: a.epochIndex,
        amount_in: a.amountIn,
        quoted_out: a.quotedOut,
        min_out: a.minOut,
        recipient_count: a.recipientCount,
        jup_data: a.jupData,
    })
    const payoutAuthority = pdas.payoutAuthority(mint)
    const keys = [
        { pubkey: pdas.global(), isSigner: false, isWritable: false },
        { pubkey: keeper, isSigner: true, isWritable: true },
        { pubkey: pdas.coinConfig(mint), isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: payoutAuthority, isSigner: false, isWritable: false },
        { pubkey: pdas.epochState(mint, a.epochIndex), isSigner: false, isWritable: true },
        { pubkey: pdas.allowlistState(mint, a.epochIndex), isSigner: false, isWritable: false },
        { pubkey: pdas.bucketState(mint, a.epochIndex, a.outMint), isSigner: false, isWritable: true },
        { pubkey: a.outMint, isSigner: false, isWritable: false },
        { pubkey: WSOL_MINT, isSigner: false, isWritable: false },
        { pubkey: getAssociatedTokenAddressSync(WSOL_MINT, payoutAuthority, true), isSigner: false, isWritable: true },
        { pubkey: getAssociatedTokenAddressSync(a.outMint, payoutAuthority, true), isSigner: false, isWritable: true },
        { pubkey: JUPITER_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ]
    // The venue route accounts follow as remaining_accounts, flags preserved.
    for (const m of a.route) keys.push({ pubkey: m.pubkey, isSigner: m.isSigner, isWritable: m.isWritable })
    return new TransactionInstruction({ programId: PROGRAM_ID, keys, data })
}

export function setGraduationIx(mint: PublicKey, status: 'Bonding' | 'Graduated' | 'Retired', dammPool: PublicKey | null, lockedPosition: PublicKey | null, admin: PublicKey): TransactionInstruction {
    const data = encodeChecked('set_graduation', { status: { [status]: {} }, damm_pool: dammPool, locked_position: lockedPosition })
    const keys = [
        { pubkey: pdas.global(), isSigner: false, isWritable: false },
        { pubkey: admin, isSigner: true, isWritable: false },
        { pubkey: pdas.coinConfig(mint), isSigner: false, isWritable: true },
    ]
    return new TransactionInstruction({ programId: PROGRAM_ID, keys, data })
}

// ==========================================================================
// On-chain discovery (Task 3.0) — real coin list, payout history, and buckets
// via getProgramAccounts, so the app is browsable and its round data is real
// without an indexer. Decoding stays here; nothing outside client/ decodes.
// ==========================================================================

function acctDiscriminator(name: string): Buffer {
    const a = idl.accounts.find((x: any) => x.name === name)
    if (!a || !a.discriminator) throw new Error(`no discriminator for ${name}`)
    return Buffer.from(a.discriminator)
}
const memcmp = (offset: number, bytes: Buffer) => ({ memcmp: { offset, bytes: bs58.encode(bytes) } })

/** Every launched coin, decoded. Real coin discovery (spec §7.5b) from chain. */
export async function allCoinConfigs(conn: Connection): Promise<Array<{ pubkey: PublicKey } & Record<string, any>>> {
    const accs = await conn.getProgramAccounts(PROGRAM_ID, { filters: [memcmp(0, acctDiscriminator('CoinConfig'))] })
    return accs.map((a) => ({ pubkey: a.pubkey, ...decodeCoinConfig(a.account.data as Buffer) }))
}

/** Every settled EpochState for a coin (payout history), by mint. mint is at
 *  offset 8 (after the 8-byte discriminator). */
export async function epochsForMint(conn: Connection, mint: PublicKey): Promise<Array<{ pubkey: PublicKey } & Record<string, any>>> {
    const accs = await conn.getProgramAccounts(PROGRAM_ID, { filters: [memcmp(0, acctDiscriminator('EpochState')), memcmp(8, mint.toBuffer())] })
    return accs.map((a) => ({ pubkey: a.pubkey, ...decodeEpochState(a.account.data as Buffer) }))
        .sort((x, y) => x.epoch_index - y.epoch_index)
}

/** Every BucketState for one epoch. bucket.epoch (the EpochState pubkey) is at
 *  offset 8. Pass `pdas.epochState(mint, epochIndex)`. */
export async function bucketsForEpoch(conn: Connection, epochStatePk: PublicKey): Promise<Array<{ pubkey: PublicKey } & Record<string, any>>> {
    const accs = await conn.getProgramAccounts(PROGRAM_ID, { filters: [memcmp(0, acctDiscriminator('BucketState')), memcmp(8, epochStatePk.toBuffer())] })
    return accs.map((a) => ({ pubkey: a.pubkey, ...decodeBucketState(a.account.data as Buffer) }))
}

/** Fees accrued for the current (unsettled) round = the PayoutAuthority WSOL ATA
 *  balance. Real, on-chain, no indexer. Returns lamports (bigint) or 0n. */
export async function payoutVaultBalance(conn: Connection, mint: PublicKey): Promise<bigint> {
    const ata = getAssociatedTokenAddressSync(WSOL_MINT, pdas.payoutAuthority(mint), true)
    try { const r = await conn.getTokenAccountBalance(ata); return BigInt(r.value.amount) } catch { return 0n }
}

/** Standing platform allowlist mints (the round's electable set source). */
export async function platformAllowlistMints(conn: Connection): Promise<PublicKey[]> {
    const info = await conn.getAccountInfo(pdas.platformAllowlist())
    if (!info) return []
    return (decodePlatformAllowlist(info.data).mints as any[]).map((m) => new PublicKey(m))
}
