//! H2E launchpad — Phase 1, Task 1.1.
//!
//! Scope is deliberately exactly one account type (`GlobalConfig`) and one
//! instruction (`initialize_global`). Everything else — CoinConfig, vaults,
//! launch, claim, epochs, keeper — arrives in later tasks. No code carries over
//! from the Phase 0 throwaway (spec §9.13); only the verified findings do.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::{invoke, invoke_signed};
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};
use anchor_lang::system_program;

declare_id!("6SnKPT4rQy7beCiYXsWfLNeva6oh7nH5mHhsKwJ6E2BS");

// ---- External program ids and CPI discriminators (Task 1.3) ----
/// Meteora Dynamic Bonding Curve program (devnet-verified, spec §3).
pub const DBC_PROGRAM: Pubkey = pubkey!("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
/// DBC pool authority (fixed program constant).
pub const DBC_POOL_AUTHORITY: Pubkey = pubkey!("FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM");
/// DBC event_cpi authority (fixed).
pub const DBC_EVENT_AUTHORITY: Pubkey = pubkey!("8Ks12pbrD6PXxfty1hVQiE9sc289zgU1zHkvXhrSdriF");
/// Metaplex token-metadata program.
pub const METADATA_PROGRAM: Pubkey = pubkey!("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
/// Associated token program.
pub const ATA_PROGRAM: Pubkey = pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
/// SPL token program.
pub const SPL_TOKEN_PROGRAM: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
/// Wrapped SOL mint — the only quote asset H2E handles.
pub const WSOL_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");

/// DBC `initialize_virtual_pool_with_spl_token` discriminator (from DBC IDL).
const INIT_POOL_SPL_DISCRIMINATOR: [u8; 8] = [140, 85, 215, 176, 102, 54, 104, 79];
/// DBC `swap` discriminator (from DBC IDL).
const SWAP_DISCRIMINATOR: [u8; 8] = [248, 198, 158, 145, 225, 117, 135, 200];
/// DBC `claim_trading_fee` discriminator (from DBC IDL, verified Phase 0).
const CLAIM_TRADING_FEE_DISCRIMINATOR: [u8; 8] = [8, 236, 89, 49, 152, 125, 177, 81];
/// Meteora DAMM v2 (cp-amm) program and its fixed authorities (spec §3).
pub const CP_AMM_PROGRAM: Pubkey = pubkey!("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
pub const CP_AMM_POOL_AUTHORITY: Pubkey = pubkey!("HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC");
pub const CP_AMM_EVENT_AUTHORITY: Pubkey = pubkey!("3rmHSu74h1ZcmAisVcWerTCiRDQbUrBKmcwptYGjHfet");
/// cp-amm `claim_position_fee` discriminator (from cp-amm IDL, re-derived Task 1.6).
const CLAIM_POSITION_FEE_DISCRIMINATOR: [u8; 8] = [180, 38, 154, 17, 133, 33, 162, 211];
// Byte offsets read on-chain (from the DBC / cp-amm account layouts).
const DBC_BASE_MINT_OFF: usize = 136;
const DBC_IS_MIGRATED_OFF: usize = 305;
const CP_POOL_TOKEN_A_MINT_OFF: usize = 168;
const CP_POOL_TOKEN_B_MINT_OFF: usize = 200;
const CP_POS_POOL_OFF: usize = 8;
const CP_POS_NFT_MINT_OFF: usize = 40;
const BPS_DENOMINATOR: u128 = 10_000;

#[program]
pub mod h2e {
    use super::*;

    /// Create the singleton `GlobalConfig` PDA (seeds `["global"]`).
    ///
    /// Checks (spec §6):
    /// - Signer must be the program's upgrade authority.
    /// - `holder_bps + h2e_bps + platform_bps` must equal 10_000.
    /// - `h2e_mint` is forced to `None`; `revenue_distribution_enabled` to
    ///   `false`. Everything else is stored from `params`.
    ///
    /// Every split and fee value is a field here, never a constant (spec §9.5),
    /// so migrating `admin` to a multisig later stays a config change, not an
    /// upgrade.
    pub fn initialize_global(
        ctx: Context<InitializeGlobal>,
        params: InitializeGlobalParams,
    ) -> Result<()> {
        require_bps_sum(params.holder_bps, params.h2e_bps, params.platform_bps)?;

        let gc = &mut ctx.accounts.global_config;
        gc.admin = params.admin;
        gc.keeper = params.keeper;
        gc.platform_wallet = params.platform_wallet;
        gc.platform_config_key = params.platform_config_key;
        gc.h2e_mint = None;
        gc.revenue_distribution_enabled = false;
        gc.usdc_mint = params.usdc_mint;
        gc.holder_bps = params.holder_bps;
        gc.h2e_bps = params.h2e_bps;
        gc.platform_bps = params.platform_bps;
        gc.dev_buy_cap_bps = params.dev_buy_cap_bps;
        gc.holder_cap_bps = params.holder_cap_bps;
        gc.epoch_seconds = params.epoch_seconds;
        gc.h2e_epoch_seconds = params.h2e_epoch_seconds;
        gc.max_slippage_bps = params.max_slippage_bps;
        gc.min_sweep_lamports = params.min_sweep_lamports;
        gc.pool_creation_fee_lamports = params.pool_creation_fee_lamports;
        gc.paused = params.paused;
        gc.pause_launches = params.pause_launches;
        gc.bump = ctx.bumps.global_config;

        Ok(())
    }

    /// Launch a coin: create a DBC pool from the platform config (pinned), do an
    /// optional dev buy capped at `dev_buy_cap_bps` of supply, collect the pool
    /// creation fee, and record `CoinConfig`. One atomic instruction (spec §6).
    pub fn launch_coin(
        ctx: Context<LaunchCoin>,
        name: String,
        symbol: String,
        uri: String,
        dev_buy_lamports: u64,
        default_payout_mint: Pubkey,
    ) -> Result<()> {
        let gc = &ctx.accounts.global_config;
        require!(!gc.pause_launches, H2eError::LaunchesPaused);
        // The creator's permanent pairing choice must come from the standing
        // allowlist, never a free-text mint (spec §7.3) — otherwise a creator could
        // point the majority of their holders' fees at their own illiquid token.
        // Checked before the pool-creation CPI so a bad mint rejects cheaply.
        require!(
            ctx.accounts.platform_allowlist.mints.contains(&default_payout_mint),
            H2eError::OutMintNotAllowed
        );
        // The config is pinned to the platform config: a creator cannot launch
        // against another config and redirect fees away from the platform PDA.
        require_keys_eq!(
            ctx.accounts.config.key(),
            gc.platform_config_key,
            H2eError::WrongConfig
        );
        require_keys_eq!(
            ctx.accounts.platform_wallet.key(),
            gc.platform_wallet,
            H2eError::WrongPlatformWallet
        );
        let dev_buy_cap_bps = gc.dev_buy_cap_bps;
        let pool_creation_fee = gc.pool_creation_fee_lamports;

        // ---- 1. CPI: create the DBC pool (mint + vaults + metadata) ----
        let mut cp_data = Vec::with_capacity(64);
        cp_data.extend_from_slice(&INIT_POOL_SPL_DISCRIMINATOR);
        write_string(&mut cp_data, &name);
        write_string(&mut cp_data, &symbol);
        write_string(&mut cp_data, &uri);
        let cp_metas = vec![
            AccountMeta::new_readonly(ctx.accounts.config.key(), false),
            AccountMeta::new_readonly(ctx.accounts.pool_authority.key(), false),
            AccountMeta::new_readonly(ctx.accounts.payer.key(), true), // creator
            AccountMeta::new(ctx.accounts.base_mint.key(), true),
            AccountMeta::new_readonly(ctx.accounts.quote_mint.key(), false),
            AccountMeta::new(ctx.accounts.pool.key(), false),
            AccountMeta::new(ctx.accounts.base_vault.key(), false),
            AccountMeta::new(ctx.accounts.quote_vault.key(), false),
            AccountMeta::new(ctx.accounts.mint_metadata.key(), false),
            AccountMeta::new_readonly(ctx.accounts.metadata_program.key(), false),
            AccountMeta::new(ctx.accounts.payer.key(), true), // payer
            AccountMeta::new_readonly(ctx.accounts.token_quote_program.key(), false),
            AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
            AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
            AccountMeta::new_readonly(ctx.accounts.dbc_event_authority.key(), false),
            AccountMeta::new_readonly(ctx.accounts.dbc_program.key(), false),
        ];
        invoke(
            &Instruction { program_id: ctx.accounts.dbc_program.key(), accounts: cp_metas, data: cp_data },
            &[
                ctx.accounts.config.to_account_info(),
                ctx.accounts.pool_authority.to_account_info(),
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.base_mint.to_account_info(),
                ctx.accounts.quote_mint.to_account_info(),
                ctx.accounts.pool.to_account_info(),
                ctx.accounts.base_vault.to_account_info(),
                ctx.accounts.quote_vault.to_account_info(),
                ctx.accounts.mint_metadata.to_account_info(),
                ctx.accounts.metadata_program.to_account_info(),
                ctx.accounts.token_quote_program.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.dbc_event_authority.to_account_info(),
                ctx.accounts.dbc_program.to_account_info(),
            ],
        )?;

        // ---- 2. optional dev buy, capped by supply * dev_buy_cap_bps ----
        if dev_buy_lamports > 0 {
            // Supply is read from the freshly created mint (DBC mints the full
            // supply at creation); no caller value enters this figure.
            let supply = read_mint_supply(&ctx.accounts.base_mint.to_account_info())?;
            // u128 throughout: DBC allows supply * decimals large enough to
            // overflow u64 when multiplied by bps (spec §9.14).
            let max_dev_tokens: u128 = dev_buy_cap_tokens(supply, dev_buy_cap_bps)?;

            // Create the creator's base ATA in-instruction so the delta below is
            // measured on an account we control the initial state of.
            let ata_metas = vec![
                AccountMeta::new(ctx.accounts.payer.key(), true),
                AccountMeta::new(ctx.accounts.dev_base_ata.key(), false),
                AccountMeta::new_readonly(ctx.accounts.payer.key(), false),
                AccountMeta::new_readonly(ctx.accounts.base_mint.key(), false),
                AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
                AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
            ];
            invoke(
                &Instruction { program_id: ctx.accounts.ata_program.key(), accounts: ata_metas, data: vec![1u8] },
                &[
                    ctx.accounts.payer.to_account_info(),
                    ctx.accounts.dev_base_ata.to_account_info(),
                    ctx.accounts.payer.to_account_info(),
                    ctx.accounts.base_mint.to_account_info(),
                    ctx.accounts.system_program.to_account_info(),
                    ctx.accounts.token_program.to_account_info(),
                    ctx.accounts.ata_program.to_account_info(),
                ],
            )?;

            let before = read_token_amount(&ctx.accounts.dev_base_ata.to_account_info())?;

            let mut sw_data = Vec::with_capacity(24);
            sw_data.extend_from_slice(&SWAP_DISCRIMINATOR);
            sw_data.extend_from_slice(&dev_buy_lamports.to_le_bytes());
            sw_data.extend_from_slice(&0u64.to_le_bytes());
            let sw_metas = vec![
                AccountMeta::new_readonly(ctx.accounts.pool_authority.key(), false),
                AccountMeta::new_readonly(ctx.accounts.config.key(), false),
                AccountMeta::new(ctx.accounts.pool.key(), false),
                AccountMeta::new(ctx.accounts.dev_quote_ata.key(), false), // input WSOL
                AccountMeta::new(ctx.accounts.dev_base_ata.key(), false),  // output base
                AccountMeta::new(ctx.accounts.base_vault.key(), false),
                AccountMeta::new(ctx.accounts.quote_vault.key(), false),
                AccountMeta::new_readonly(ctx.accounts.base_mint.key(), false),
                AccountMeta::new_readonly(ctx.accounts.quote_mint.key(), false),
                AccountMeta::new_readonly(ctx.accounts.payer.key(), true),
                AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
                AccountMeta::new_readonly(ctx.accounts.token_quote_program.key(), false),
                // referral_token_account is optional; program id signals None.
                AccountMeta::new_readonly(ctx.accounts.dbc_program.key(), false),
                AccountMeta::new_readonly(ctx.accounts.dbc_event_authority.key(), false),
                AccountMeta::new_readonly(ctx.accounts.dbc_program.key(), false),
            ];
            invoke(
                &Instruction { program_id: ctx.accounts.dbc_program.key(), accounts: sw_metas, data: sw_data },
                &[
                    ctx.accounts.pool_authority.to_account_info(),
                    ctx.accounts.config.to_account_info(),
                    ctx.accounts.pool.to_account_info(),
                    ctx.accounts.dev_quote_ata.to_account_info(),
                    ctx.accounts.dev_base_ata.to_account_info(),
                    ctx.accounts.base_vault.to_account_info(),
                    ctx.accounts.quote_vault.to_account_info(),
                    ctx.accounts.base_mint.to_account_info(),
                    ctx.accounts.quote_mint.to_account_info(),
                    ctx.accounts.payer.to_account_info(),
                    ctx.accounts.token_program.to_account_info(),
                    ctx.accounts.token_quote_program.to_account_info(),
                    ctx.accounts.dbc_event_authority.to_account_info(),
                    ctx.accounts.dbc_program.to_account_info(),
                ],
            )?;

            let after = read_token_amount(&ctx.accounts.dev_base_ata.to_account_info())?;
            let acquired = after.checked_sub(before).ok_or(H2eError::MathOverflow)?;
            require!((acquired as u128) <= max_dev_tokens, H2eError::DevBuyExceedsCap);
            msg!("dev acquired {} of max {} base units", acquired, max_dev_tokens);
        }

        // ---- 3. pool creation fee to platform_wallet ----
        if pool_creation_fee > 0 {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.payer.to_account_info(),
                        to: ctx.accounts.platform_wallet.to_account_info(),
                    },
                ),
                pool_creation_fee,
            )?;
        }

        // ---- 4. record CoinConfig ----
        let cc = &mut ctx.accounts.coin_config;
        cc.mint = ctx.accounts.base_mint.key();
        cc.dbc_pool = ctx.accounts.pool.key();
        cc.damm_pool = None;
        cc.locked_position = None;
        cc.creator_wallet = ctx.accounts.payer.key();
        cc.default_payout_mint = default_payout_mint; // permanent; validated above
        cc.launch_ts = Clock::get()?.unix_timestamp;
        cc.current_epoch = 0;
        cc.total_claimed = 0;
        cc.total_paid_out = 0;
        cc.status = CoinStatus::Bonding;
        cc.bump = ctx.bumps.coin_config;

        Ok(())
    }

    // ---------------------------------------------------------------------
    // Admin instructions (spec §6). All gated on GlobalConfig.admin via
    // has_one; the keeper and upgrade authority cannot call them (spec §9.9).
    // ---------------------------------------------------------------------

    /// Update the economic / config parameters. Rejects a split that does not
    /// sum to 10_000. Does not touch admin, keeper, h2e_mint or the pause flags
    /// (each has its own instruction).
    pub fn set_params(ctx: Context<AdminOnly>, args: SetParamsArgs) -> Result<()> {
        require_bps_sum(args.holder_bps, args.h2e_bps, args.platform_bps)?;
        let gc = &mut ctx.accounts.global_config;
        gc.holder_bps = args.holder_bps;
        gc.h2e_bps = args.h2e_bps;
        gc.platform_bps = args.platform_bps;
        gc.dev_buy_cap_bps = args.dev_buy_cap_bps;
        gc.holder_cap_bps = args.holder_cap_bps;
        gc.epoch_seconds = args.epoch_seconds;
        gc.h2e_epoch_seconds = args.h2e_epoch_seconds;
        gc.max_slippage_bps = args.max_slippage_bps;
        gc.min_sweep_lamports = args.min_sweep_lamports;
        gc.pool_creation_fee_lamports = args.pool_creation_fee_lamports;
        gc.usdc_mint = args.usdc_mint;
        Ok(())
    }

    /// Dedicated: a wrong value sends the platform's 10% to a stranger (spec §6).
    pub fn set_platform_wallet(ctx: Context<AdminOnly>, new_wallet: Pubkey) -> Result<()> {
        ctx.accounts.global_config.platform_wallet = new_wallet;
        Ok(())
    }

    /// Dedicated: a wrong value means later launches use a config whose feeClaimer
    /// is not H2E's PDA, and those fees are unrecoverable (spec §6).
    pub fn set_platform_config_key(ctx: Context<AdminOnly>, new_config: Pubkey) -> Result<()> {
        ctx.accounts.global_config.platform_config_key = new_config;
        Ok(())
    }

    /// Change the keeper hot key. Keeper touches only this field.
    pub fn set_keeper(ctx: Context<AdminOnly>, new_keeper: Pubkey) -> Result<()> {
        ctx.accounts.global_config.keeper = new_keeper;
        Ok(())
    }

    /// Replace the admin (e.g. migrate to a multisig) without a program upgrade.
    /// The current admin signs; afterwards only the new admin can call admin ixs.
    pub fn set_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
        ctx.accounts.global_config.admin = new_admin;
        Ok(())
    }

    /// Set (or clear) `h2e_mint` and the `revenue_distribution_enabled` flag.
    /// Enabling distribution while the mint is None is rejected: there is nothing
    /// to distribute to (spec §8).
    pub fn set_h2e_mint(ctx: Context<AdminOnly>, mint: Option<Pubkey>, enable: bool) -> Result<()> {
        require!(!(enable && mint.is_none()), H2eError::CannotEnableWithoutMint);
        let gc = &mut ctx.accounts.global_config;
        gc.h2e_mint = mint;
        gc.revenue_distribution_enabled = enable;
        Ok(())
    }

    /// Set the two independent pause flags. `paused` stops distribution;
    /// `pause_launches` stops new launches.
    pub fn pause(ctx: Context<AdminOnly>, paused: bool, pause_launches: bool) -> Result<()> {
        let gc = &mut ctx.accounts.global_config;
        gc.paused = paused;
        gc.pause_launches = pause_launches;
        Ok(())
    }

    /// Create the denylist singleton (once). Explicit, not init_if_needed, so
    /// the crate-wide feature stays off (spec §6).
    pub fn init_denylist(ctx: Context<InitDenylist>) -> Result<()> {
        ctx.accounts.denylist.bump = ctx.bumps.denylist;
        Ok(())
    }

    /// Add or remove one denylist entry (an excluded payout address or a blocked
    /// payout mint). Requires the denylist to exist (init_denylist first). Read
    /// off-chain by the keeper/round-builder (spec §7.2/§7.3).
    pub fn set_denylist(ctx: Context<SetDenylist>, kind: DenyKind, key: Pubkey, add: bool) -> Result<()> {
        let dl = &mut ctx.accounts.denylist;
        let list = match kind {
            DenyKind::PayoutAddress => &mut dl.addresses,
            DenyKind::PayoutMint => &mut dl.mints,
        };
        if add {
            if !list.contains(&key) {
                require!(list.len() < DENY_MAX, H2eError::DenylistFull);
                list.push(key);
            }
        } else {
            list.retain(|k| k != &key);
        }
        Ok(())
    }

    /// Create the platform allowlist singleton (once). Explicit init, not
    /// init_if_needed (spec §6). Admin-gated.
    pub fn init_platform_allowlist(ctx: Context<InitPlatformAllowlist>) -> Result<()> {
        ctx.accounts.platform_allowlist.bump = ctx.bumps.platform_allowlist;
        Ok(())
    }

    /// Add or remove one standing payout-asset mint (spec §4, Task 1.9). Admin-gated;
    /// the keeper must never write this — it is what constrains the keeper. Requires
    /// the allowlist to exist (init first).
    pub fn set_platform_allowlist(ctx: Context<SetPlatformAllowlist>, mint: Pubkey, add: bool) -> Result<()> {
        let al = &mut ctx.accounts.platform_allowlist;
        if add {
            if !al.mints.contains(&mint) {
                require!(al.mints.len() < MAX_PLATFORM_ALLOWLIST, H2eError::AllowlistTooLong);
                al.mints.push(mint);
            }
        } else {
            al.mints.retain(|m| m != &mint);
        }
        Ok(())
    }

    /// Dedicated: usdc_mint is the default payout asset for every non-elector
    /// (spec §6) — a wrong value pays the majority of every round in a random mint.
    pub fn set_usdc_mint(ctx: Context<AdminOnly>, new_usdc_mint: Pubkey) -> Result<()> {
        ctx.accounts.global_config.usdc_mint = new_usdc_mint;
        Ok(())
    }

    /// Admin-gated: mark a coin Retired. Retired stops sweeps and (implicitly) any
    /// future graduation, but does NOT touch funds already in the vaults — holders
    /// keep what they are owed (distribution instructions do not check status).
    pub fn retire_coin(ctx: Context<RetireCoin>) -> Result<()> {
        ctx.accounts.coin_config.status = CoinStatus::Retired;
        Ok(())
    }

    /// Keeper-signed: freeze a coin's epoch. `payout_amount` is snapshotted from
    /// the PayoutAuthority WSOL ATA balance, so fees arriving after settle belong
    /// to the next epoch. Duplicate settle is rejected by `init` on EpochState.
    pub fn settle_epoch(ctx: Context<SettleEpoch>, epoch_index: u32, total_weight: u128, merkle_root: [u8; 32], bucket_count: u16, allowed_mints: Vec<Pubkey>) -> Result<()> {
        let gc = &ctx.accounts.global_config;
        let cc = &ctx.accounts.coin_config;
        let start_ts = cc.launch_ts
            .checked_add((epoch_index as i64).checked_mul(gc.epoch_seconds).ok_or(H2eError::MathOverflow)?)
            .ok_or(H2eError::MathOverflow)?;
        let end_ts = start_ts.checked_add(gc.epoch_seconds).ok_or(H2eError::MathOverflow)?;
        require!(Clock::get()?.unix_timestamp >= end_ts, H2eError::EpochNotEnded);
        // Bound the allowlist to the account's reserved space; the round's distinct
        // elected assets are far fewer in practice.
        require!(allowed_mints.len() <= MAX_ALLOWLIST, H2eError::AllowlistTooLong);
        // The keeper writes allowed_mints, so it must not also define the permitted
        // set: every entry must be in the standing admin-maintained PlatformAllowlist
        // (spec §4, Task 1.9). This is what actually constrains a compromised keeper.
        for m in allowed_mints.iter() {
            require!(ctx.accounts.platform_allowlist.mints.contains(m), H2eError::OutMintNotAllowed);
        }

        let es = &mut ctx.accounts.epoch_state;
        es.mint = ctx.accounts.mint.key();
        es.epoch_index = epoch_index;
        es.start_ts = start_ts;
        es.end_ts = end_ts;
        es.payout_amount = ctx.accounts.payout_wsol_ata.amount; // frozen
        es.swapped_in = 0;
        es.total_weight = total_weight;
        es.merkle_root = merkle_root;
        es.bucket_count = bucket_count;
        es.buckets_complete = 0;
        es.settled = true;
        es.bump = ctx.bumps.epoch_state;

        // Atomic with settlement: settled ⟺ allowlist exists.
        let al = &mut ctx.accounts.allowlist_state;
        al.mint = ctx.accounts.mint.key();
        al.epoch_index = epoch_index;
        al.mints = allowed_mints;
        al.bump = ctx.bumps.allowlist_state;
        Ok(())
    }

    /// Keeper-signed: swap one elected-asset bucket's WSOL into `out_mint` via the
    /// pinned Jupiter program, creating that bucket's `BucketState` (spec §6). The
    /// bucket is `init`, so a second swap of the same (mint, epoch, out_mint) is
    /// structurally impossible — that is the "already swapped" rejection.
    ///
    /// `amount_out` is the **measured token-balance delta**, never `quoted_out`:
    /// `distribute_batch` bounds payments by `amount_out`, so an inflated value
    /// would let distribution exceed what the bucket actually holds. The keeper
    /// supplies the opaque Jupiter swap instruction data (`jup_data`) and its route
    /// accounts as `remaining_accounts`; the program forwards them only to
    /// `JUPITER_PROGRAM`, signed by the PayoutAuthority PDA.
    ///
    /// Signature deviates from spec §6 (`amount_in, min_out`) by adding
    /// `quoted_out`, `recipient_count` and `jup_data` — flagged in the report:
    /// `quoted_out` is required because the on-chain slippage floor cannot be
    /// checked without the quote; `recipient_count` initialises the bucket's
    /// completion bound; `jup_data` is the venue's opaque swap payload.
    pub fn swap_payout<'info>(
        ctx: Context<'_, '_, '_, 'info, SwapPayout<'info>>,
        _epoch_index: u32,
        amount_in: u64,
        quoted_out: u64,
        min_out: u64,
        recipient_count: u32,
        jup_data: Vec<u8>,
    ) -> Result<()> {
        require!(ctx.accounts.epoch_state.settled, H2eError::NotSettled);
        require!(amount_in > 0, H2eError::ZeroAmountIn);
        require_keys_eq!(ctx.accounts.allowlist_state.mint, ctx.accounts.epoch_state.mint, H2eError::WrongAllowlist);

        let out_mint_key = ctx.accounts.out_mint.key();
        require!(
            ctx.accounts.allowlist_state.mints.iter().any(|m| *m == out_mint_key),
            H2eError::OutMintNotAllowed
        );

        // Σ amount_in across this epoch's buckets must not exceed the frozen payout.
        let new_swapped_in = ctx.accounts.epoch_state.swapped_in
            .checked_add(amount_in).ok_or(H2eError::MathOverflow)?;
        require!(new_swapped_in <= ctx.accounts.epoch_state.payout_amount, H2eError::SwapExceedsPayout);

        // Slippage floor: min_out ≥ quoted_out × (1 − max_slippage_bps).
        let slip = ctx.accounts.global_config.max_slippage_bps as u128;
        let floor = (quoted_out as u128)
            .checked_mul(10_000u128.checked_sub(slip).ok_or(H2eError::MathOverflow)?)
            .ok_or(H2eError::MathOverflow)?
            / 10_000u128;
        require!((min_out as u128) >= floor, H2eError::SlippageTooLoose);

        // Guard the 64-account tx lock ceiling on-chain, independent of the keeper.
        require!(ctx.remaining_accounts.len() <= MAX_SWAP_REMAINING, H2eError::TooManySwapAccounts);

        let mint_key = ctx.accounts.mint.key();
        let payout_bump = ctx.bumps.payout_authority;
        let payout_key = ctx.accounts.payout_authority.key();

        let amount_out: u64 = if out_mint_key == WSOL_MINT {
            // No swap: the WSOL already sits in the payout ATA. The bucket pays in
            // WSOL directly. amount_out == amount_in.
            amount_in
        } else {
            let out_before = ctx.accounts.payout_out_ata.amount;
            // Reconstruct the venue instruction from the keeper-supplied route.
            // The PayoutAuthority PDA is forced signer; invoke_signed provides its
            // signature via seeds. All other flags are taken as passed.
            let mut metas = Vec::with_capacity(ctx.remaining_accounts.len());
            let mut infos = Vec::with_capacity(ctx.remaining_accounts.len());
            for acc in ctx.remaining_accounts.iter() {
                let is_signer = acc.is_signer || acc.key() == payout_key;
                metas.push(AccountMeta { pubkey: acc.key(), is_signer, is_writable: acc.is_writable });
                infos.push(acc.clone());
            }
            let ix = Instruction { program_id: JUPITER_PROGRAM, accounts: metas, data: jup_data };
            let signer: &[&[&[u8]]] = &[&[PAYOUT_SEED, mint_key.as_ref(), &[payout_bump]]];
            invoke_signed(&ix, &infos, signer)?;

            ctx.accounts.payout_out_ata.reload()?;
            let out_after = ctx.accounts.payout_out_ata.amount;
            let delta = out_after.checked_sub(out_before).ok_or(H2eError::MathOverflow)?;
            require!(delta > 0, H2eError::SwapNoOutput);
            require!(delta >= min_out, H2eError::SlippageTooLoose); // venue floor, re-checked on the measured delta
            delta
        };

        ctx.accounts.epoch_state.swapped_in = new_swapped_in;

        let b = &mut ctx.accounts.bucket_state;
        b.epoch = ctx.accounts.epoch_state.key();
        b.out_mint = out_mint_key;
        b.amount_in = amount_in;
        b.amount_out = amount_out; // frozen: the measured delta
        b.recipient_count = recipient_count;
        b.cursor = 0;
        b.paid_amount = 0;
        b.swapped = true;
        b.complete = false;
        b.bump = ctx.bumps.bucket_state;
        Ok(())
    }

    /// Keeper-signed: pay a batch of recipients from one BucketState, resumably.
    /// recipients[] are wallet pubkeys (ascending); remaining_accounts[i] is that
    /// wallet's out_mint ATA (verified by derivation). See the report for the
    /// no-double-payment argument.
    pub fn distribute_batch<'info>(
        ctx: Context<'_, '_, '_, 'info, DistributeBatch<'info>>,
        _epoch_index: u32,
        start_index: u32,
        recipients: Vec<Pubkey>,
        amounts: Vec<u64>,
    ) -> Result<()> {
        {
            let b = &ctx.accounts.bucket_state;
            require!(b.swapped, H2eError::BucketNotSwapped);
            require!(!b.complete, H2eError::BucketComplete);
            require_keys_eq!(b.epoch, ctx.accounts.epoch_state.key(), H2eError::WrongEpoch);
            require!(start_index == b.cursor, H2eError::CursorMismatch);
        }
        let n = recipients.len();
        require!(n == amounts.len() && n == ctx.remaining_accounts.len(), H2eError::LengthMismatch);
        require!(n > 0, H2eError::EmptyBatch);

        let mut sum: u64 = 0;
        for &a in &amounts {
            require!(a > 0, H2eError::ZeroAmount); // round-builder drops sub-rent shares; a zero is a keeper bug
            sum = sum.checked_add(a).ok_or(H2eError::MathOverflow)?;
        }
        let b = &ctx.accounts.bucket_state;
        let new_paid = b.paid_amount.checked_add(sum).ok_or(H2eError::MathOverflow)?;
        require!(new_paid <= b.amount_out, H2eError::Overpayment); // per-bucket bound, bucket's own mint
        let new_cursor = b.cursor.checked_add(n as u32).ok_or(H2eError::MathOverflow)?;
        require!(new_cursor <= b.recipient_count, H2eError::TooManyRecipients);

        let mint_key = ctx.accounts.mint.key();
        let payout_bump = ctx.bumps.payout_authority;
        let signer: &[&[&[u8]]] = &[&[PAYOUT_SEED, mint_key.as_ref(), &[payout_bump]]];
        let decimals = ctx.accounts.out_mint.decimals;
        let out_mint_key = ctx.accounts.out_mint.key();
        for i in 0..n {
            let expected = anchor_spl::associated_token::get_associated_token_address(&recipients[i], &out_mint_key);
            require_keys_eq!(ctx.remaining_accounts[i].key(), expected, H2eError::WrongRecipientAta);
            token::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.payout_out_ata.to_account_info(),
                        mint: ctx.accounts.out_mint.to_account_info(),
                        to: ctx.remaining_accounts[i].clone(),
                        authority: ctx.accounts.payout_authority.to_account_info(),
                    },
                    signer,
                ),
                amounts[i],
                decimals,
            )?;
        }

        let b = &mut ctx.accounts.bucket_state;
        b.cursor = new_cursor;
        b.paid_amount = new_paid;
        if b.cursor == b.recipient_count {
            b.complete = true;
            let es = &mut ctx.accounts.epoch_state;
            es.buckets_complete = es.buckets_complete.checked_add(1).ok_or(H2eError::MathOverflow)?;
        }
        Ok(())
    }

    /// Admin override for a coin's status/damm_pool/locked_position. Escape hatch
    /// for a corrupted sync_graduation (permissionless, one-way, raw offset reads).
    pub fn set_graduation(ctx: Context<SetGraduation>, status: CoinStatus, damm_pool: Option<Pubkey>, locked_position: Option<Pubkey>) -> Result<()> {
        let cc = &mut ctx.accounts.coin_config;
        cc.status = status;
        cc.damm_pool = damm_pool;
        cc.locked_position = locked_position;
        Ok(())
    }

    /// Permissionless: on `is_migrated == 1`, record the DAMM pool and the
    /// partner locked position and flip status to Graduated. Verifies rather than
    /// trusts every caller-supplied account (spec §6).
    pub fn sync_graduation(ctx: Context<SyncGraduation>) -> Result<()> {
        require!(ctx.accounts.coin_config.status == CoinStatus::Bonding, H2eError::NotBondingForSync);

        // 1. The DBC pool genuinely corresponds to this mint.
        require_keys_eq!(ctx.accounts.dbc_pool.key(), ctx.accounts.coin_config.dbc_pool, H2eError::WrongPool);
        let mint_key = ctx.accounts.mint.key();
        {
            let dbc = ctx.accounts.dbc_pool.try_borrow_data()?;
            require!(dbc.len() > DBC_IS_MIGRATED_OFF, H2eError::BadAccount);
            require!(read_pubkey(&dbc, DBC_BASE_MINT_OFF) == mint_key, H2eError::WrongMint);
            // 2. is_migrated == 1, else reject.
            require!(dbc[DBC_IS_MIGRATED_OFF] == 1, H2eError::NotMigrated);
        }

        // 3. The DAMM pool is the one this coin migrated into: token A = base mint,
        //    token B = WSOL. Ties damm_pool to THIS coin (not another graduated coin).
        {
            let dp = ctx.accounts.damm_pool.try_borrow_data()?;
            require!(dp.len() >= CP_POOL_TOKEN_B_MINT_OFF + 32, H2eError::BadAccount);
            require!(read_pubkey(&dp, CP_POOL_TOKEN_A_MINT_OFF) == mint_key, H2eError::WrongDammPool);
            require!(read_pubkey(&dp, CP_POOL_TOKEN_B_MINT_OFF) == WSOL_MINT, H2eError::WrongDammPool);
        }

        // 4. The locked position belongs to this DAMM pool and its NFT is held by
        //    the global ["fee"] PDA (so H2E controls the fee claim).
        let nft_mint = {
            let pos = ctx.accounts.locked_position.try_borrow_data()?;
            require!(pos.len() >= CP_POS_NFT_MINT_OFF + 32, H2eError::BadAccount);
            require!(read_pubkey(&pos, CP_POS_POOL_OFF) == ctx.accounts.damm_pool.key(), H2eError::WrongLockedPosition);
            read_pubkey(&pos, CP_POS_NFT_MINT_OFF)
        };
        {
            let nfta = ctx.accounts.position_nft_account.try_borrow_data()?;
            require!(nfta.len() >= 72, H2eError::BadAccount);
            require!(read_pubkey(&nfta, 0) == nft_mint, H2eError::WrongLockedPosition);
            require!(read_pubkey(&nfta, 32) == ctx.accounts.fee_claimer.key(), H2eError::WrongPositionOwner);
            require!(u64::from_le_bytes(nfta[64..72].try_into().unwrap()) == 1, H2eError::WrongLockedPosition);
        }

        let cc = &mut ctx.accounts.coin_config;
        cc.damm_pool = Some(ctx.accounts.damm_pool.key());
        cc.locked_position = Some(ctx.accounts.locked_position.key());
        cc.status = CoinStatus::Graduated;
        msg!("graduated: damm_pool {} position {}", ctx.accounts.damm_pool.key(), ctx.accounts.locked_position.key());
        Ok(())
    }

    /// Claim a bonding coin's DBC partner fees into the FeeAuthority WSOL ATA and
    /// split them 60/30/10 (spec §6, bonding path). Permissionless — safety comes
    /// from the destination being constrained (spec §5), not from gating callers.
    pub fn claim_and_sweep<'info>(ctx: Context<'_, '_, '_, 'info, ClaimAndSweep<'info>>) -> Result<()> {
        let gc = &ctx.accounts.global_config;
        require!(!gc.paused, H2eError::Paused);
        require_keys_eq!(ctx.accounts.config.key(), gc.platform_config_key, H2eError::WrongConfig);
        require_keys_eq!(ctx.accounts.platform_wallet.key(), gc.platform_wallet, H2eError::WrongPlatformWallet);

        let holder_bps = gc.holder_bps as u128;
        let h2e_bps = gc.h2e_bps as u128;
        let min_sweep = gc.min_sweep_lamports;
        let decimals = ctx.accounts.quote_mint.decimals;

        // ---- 1. CPI DBC claim_trading_fee, signed by the global ["fee"] PDA ----
        let fee_bump = ctx.bumps.fee_claimer;
        let fee_signer: &[&[&[u8]]] = &[&[FEE_SEED, &[fee_bump]]];

        if ctx.accounts.coin_config.status == CoinStatus::Bonding {
        let mut data = CLAIM_TRADING_FEE_DISCRIMINATOR.to_vec();
        data.extend_from_slice(&u64::MAX.to_le_bytes()); // max_amount_a
        data.extend_from_slice(&u64::MAX.to_le_bytes()); // max_amount_b
        let metas = vec![
            AccountMeta::new_readonly(ctx.accounts.dbc_pool_authority.key(), false),
            AccountMeta::new_readonly(ctx.accounts.config.key(), false),
            AccountMeta::new(ctx.accounts.dbc_pool.key(), false),
            AccountMeta::new(ctx.accounts.fee_base_ata.key(), false), // token_a (base, 0 under quote-only)
            AccountMeta::new(ctx.accounts.fee_wsol_ata.key(), false), // token_b (quote receiver)
            AccountMeta::new(ctx.accounts.base_vault.key(), false),
            AccountMeta::new(ctx.accounts.quote_vault.key(), false),
            AccountMeta::new_readonly(ctx.accounts.mint.key(), false),
            AccountMeta::new_readonly(ctx.accounts.quote_mint.key(), false),
            AccountMeta::new_readonly(ctx.accounts.fee_claimer.key(), true), // required signer
            AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
            AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
            AccountMeta::new_readonly(ctx.accounts.dbc_event_authority.key(), false),
            AccountMeta::new_readonly(ctx.accounts.dbc_program.key(), false),
        ];
        invoke_signed(
            &Instruction { program_id: ctx.accounts.dbc_program.key(), accounts: metas, data },
            &[
                ctx.accounts.dbc_pool_authority.to_account_info(),
                ctx.accounts.config.to_account_info(),
                ctx.accounts.dbc_pool.to_account_info(),
                ctx.accounts.fee_base_ata.to_account_info(),
                ctx.accounts.fee_wsol_ata.to_account_info(),
                ctx.accounts.base_vault.to_account_info(),
                ctx.accounts.quote_vault.to_account_info(),
                ctx.accounts.mint.to_account_info(),
                ctx.accounts.quote_mint.to_account_info(),
                ctx.accounts.fee_claimer.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
                ctx.accounts.dbc_event_authority.to_account_info(),
                ctx.accounts.dbc_program.to_account_info(),
            ],
            fee_signer,
        )?;
        } else {
            // Graduated: cp-amm claim_position_fee. Rail-specific accounts arrive
            // as remaining_accounts so the struct stays one shape for both rails.
            let ra = ctx.remaining_accounts;
            require!(ra.len() == 8, H2eError::WrongCpAmm);
            let (cp_pool_auth, damm_pool, position, ta_vault, tb_vault, nft_acc, cp_event, cp_prog) =
                (&ra[0], &ra[1], &ra[2], &ra[3], &ra[4], &ra[5], &ra[6], &ra[7]);
            require_keys_eq!(cp_prog.key(), CP_AMM_PROGRAM, H2eError::WrongCpAmm);
            require_keys_eq!(cp_pool_auth.key(), CP_AMM_POOL_AUTHORITY, H2eError::WrongCpAmm);
            require_keys_eq!(cp_event.key(), CP_AMM_EVENT_AUTHORITY, H2eError::WrongCpAmm);
            require!(ctx.accounts.coin_config.damm_pool == Some(damm_pool.key()), H2eError::WrongDammPool);
            require!(ctx.accounts.coin_config.locked_position == Some(position.key()), H2eError::WrongLockedPosition);
            let metas = vec![
                AccountMeta::new_readonly(cp_pool_auth.key(), false),
                AccountMeta::new_readonly(damm_pool.key(), false),
                AccountMeta::new(position.key(), false),
                AccountMeta::new(ctx.accounts.fee_base_ata.key(), false),
                AccountMeta::new(ctx.accounts.fee_wsol_ata.key(), false),
                AccountMeta::new(ta_vault.key(), false),
                AccountMeta::new(tb_vault.key(), false),
                AccountMeta::new_readonly(ctx.accounts.mint.key(), false),
                AccountMeta::new_readonly(ctx.accounts.quote_mint.key(), false),
                AccountMeta::new_readonly(nft_acc.key(), false),
                AccountMeta::new_readonly(ctx.accounts.fee_claimer.key(), true),
                AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
                AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
                AccountMeta::new_readonly(cp_event.key(), false),
                AccountMeta::new_readonly(cp_prog.key(), false),
            ];
            invoke_signed(
                &Instruction { program_id: cp_prog.key(), accounts: metas, data: CLAIM_POSITION_FEE_DISCRIMINATOR.to_vec() },
                &[
                    cp_pool_auth.clone(), damm_pool.clone(), position.clone(),
                    ctx.accounts.fee_base_ata.to_account_info(), ctx.accounts.fee_wsol_ata.to_account_info(),
                    ta_vault.clone(), tb_vault.clone(),
                    ctx.accounts.mint.to_account_info(), ctx.accounts.quote_mint.to_account_info(),
                    nft_acc.clone(),
                    ctx.accounts.fee_claimer.to_account_info(),
                    ctx.accounts.token_program.to_account_info(),
                    cp_event.clone(), cp_prog.clone(),
                ],
                fee_signer,
            )?;
        }

        // ---- 2. the claimed amount is the full WSOL ATA balance ----
        ctx.accounts.fee_wsol_ata.reload()?;
        let claimed = ctx.accounts.fee_wsol_ata.amount;
        require!(claimed >= min_sweep, H2eError::BelowMinSweep);

        // ---- 3. split in u128; floor holder + h2e, remainder to platform, so the
        //         three transfers sum to exactly `claimed` (nothing lost/created) ----
        let holder_amount = (claimed as u128)
            .checked_mul(holder_bps)
            .and_then(|v| v.checked_div(BPS_DENOMINATOR))
            .ok_or_else(|| error!(H2eError::MathOverflow))? as u64;
        let h2e_amount = (claimed as u128)
            .checked_mul(h2e_bps)
            .and_then(|v| v.checked_div(BPS_DENOMINATOR))
            .ok_or_else(|| error!(H2eError::MathOverflow))? as u64;
        let platform_amount = claimed
            .checked_sub(holder_amount)
            .and_then(|v| v.checked_sub(h2e_amount))
            .ok_or_else(|| error!(H2eError::MathOverflow))?;

        // ---- 4. transfers signed by FeeAuthority ["vault", mint] ----
        let mint_key = ctx.accounts.mint.key();
        let va_bump = ctx.bumps.fee_authority;
        let va_signer: &[&[&[u8]]] = &[&[VAULT_SEED, mint_key.as_ref(), &[va_bump]]];
        for (to, amount) in [
            (ctx.accounts.payout_wsol_ata.to_account_info(), holder_amount),
            (ctx.accounts.revenue_wsol_ata.to_account_info(), h2e_amount),
            (ctx.accounts.platform_wsol_ata.to_account_info(), platform_amount),
        ] {
            if amount == 0 {
                continue;
            }
            token::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.fee_wsol_ata.to_account_info(),
                        mint: ctx.accounts.quote_mint.to_account_info(),
                        to,
                        authority: ctx.accounts.fee_authority.to_account_info(),
                    },
                    va_signer,
                ),
                amount,
                decimals,
            )?;
        }

        // ---- 5. accounting + empty-vault invariant ----
        let cc = &mut ctx.accounts.coin_config;
        cc.total_claimed = cc.total_claimed.checked_add(claimed).ok_or_else(|| error!(H2eError::MathOverflow))?;
        ctx.accounts.fee_wsol_ata.reload()?;
        require!(ctx.accounts.fee_wsol_ata.amount == 0, H2eError::FeeAtaNotEmpty);
        msg!("swept {} = holder {} + h2e {} + platform {}", claimed, holder_amount, h2e_amount, platform_amount);
        Ok(())
    }
}

/// Global program configuration. Seeds `["global"]`. Fields per spec §4 — exact
/// set, order, names and types; none added, omitted or renamed.
#[account]
#[derive(InitSpace)]
pub struct GlobalConfig {
    pub admin: Pubkey,                    // hardware wallet, signs rarely
    pub keeper: Pubkey,                   // hot key, cranks only
    pub platform_wallet: Pubkey,          // receives the 10%
    pub platform_config_key: Pubkey,      // the DBC partner config
    pub h2e_mint: Option<Pubkey>,         // None until $H2E launches
    pub revenue_distribution_enabled: bool, // false until h2e_mint is set
    pub usdc_mint: Pubkey,
    pub holder_bps: u16,                  // 6000
    pub h2e_bps: u16,                     // 3000
    pub platform_bps: u16,                // 1000
    pub dev_buy_cap_bps: u16,             // 300
    pub holder_cap_bps: u16,              // 300
    pub epoch_seconds: i64,               // 86400
    pub h2e_epoch_seconds: i64,           // 604800
    pub max_slippage_bps: u16,
    pub min_sweep_lamports: u64,
    pub pool_creation_fee_lamports: u64,  // 0 initially
    pub paused: bool,
    pub pause_launches: bool,
    pub bump: u8,
}

/// Inputs to `initialize_global`. Carries every stored field except the two the
/// instruction forces (`h2e_mint`, `revenue_distribution_enabled`) and `bump`
/// (taken from the PDA derivation).
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializeGlobalParams {
    pub admin: Pubkey,
    pub keeper: Pubkey,
    pub platform_wallet: Pubkey,
    pub platform_config_key: Pubkey,
    pub usdc_mint: Pubkey,
    pub holder_bps: u16,
    pub h2e_bps: u16,
    pub platform_bps: u16,
    pub dev_buy_cap_bps: u16,
    pub holder_cap_bps: u16,
    pub epoch_seconds: i64,
    pub h2e_epoch_seconds: i64,
    pub max_slippage_bps: u16,
    pub min_sweep_lamports: u64,
    pub pool_creation_fee_lamports: u64,
    pub paused: bool,
    pub pause_launches: bool,
}

#[derive(Accounts)]
pub struct InitializeGlobal<'info> {
    /// Must be the program's upgrade authority.
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + GlobalConfig::INIT_SPACE,
        seeds = [b"global"],
        bump
    )]
    pub global_config: Account<'info, GlobalConfig>,

    /// The H2E program account; ties `program_data` to this program.
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ H2eError::InvalidProgramData)]
    pub program: Program<'info, crate::program::H2e>,

    /// The program's ProgramData; its upgrade authority must be the signer.
    #[account(constraint = program_data.upgrade_authority_address == Some(authority.key()) @ H2eError::NotUpgradeAuthority)]
    pub program_data: Account<'info, ProgramData>,

    pub system_program: Program<'info, System>,
}

#[error_code]
pub enum H2eError {
    #[msg("holder_bps + h2e_bps + platform_bps must equal 10000")]
    InvalidSplit,
    #[msg("signer is not the program upgrade authority")]
    NotUpgradeAuthority,
    #[msg("program account does not match its program data")]
    InvalidProgramData,
    #[msg("launches are paused")]
    LaunchesPaused,
    #[msg("config is not the platform config")]
    WrongConfig,
    #[msg("platform_wallet does not match GlobalConfig")]
    WrongPlatformWallet,
    #[msg("dev buy exceeds the supply cap")]
    DevBuyExceedsCap,
    #[msg("account data too small")]
    BadAccount,
    #[msg("arithmetic overflow")]
    MathOverflow,
    #[msg("signer is not the admin")]
    NotAdmin,
    #[msg("cannot enable revenue distribution while h2e_mint is None")]
    CannotEnableWithoutMint,
    #[msg("denylist is full")]
    DenylistFull,
    #[msg("distribution is paused")]
    Paused,
    #[msg("coin is not in the Bonding state")]
    NotBonding,
    #[msg("claimed balance is below min_sweep_lamports")]
    BelowMinSweep,
    #[msg("pool does not match CoinConfig.dbc_pool")]
    WrongPool,
    #[msg("mint does not match CoinConfig.mint")]
    WrongMint,
    #[msg("fee vault not empty after sweep")]
    FeeAtaNotEmpty,
    #[msg("coin is retired")]
    CoinRetired,
    #[msg("coin is not Bonding; cannot sync graduation")]
    NotBondingForSync,
    #[msg("DBC pool is not migrated yet")]
    NotMigrated,
    #[msg("damm_pool does not belong to this coin")]
    WrongDammPool,
    #[msg("locked_position is invalid for this pool")]
    WrongLockedPosition,
    #[msg("position NFT is not held by the fee PDA")]
    WrongPositionOwner,
    #[msg("wrong cp-amm account")]
    WrongCpAmm,
    #[msg("signer is not the keeper")]
    NotKeeper,
    #[msg("epoch has not ended yet")]
    EpochNotEnded,
    #[msg("bucket has not been swapped")]
    BucketNotSwapped,
    #[msg("bucket already complete")]
    BucketComplete,
    #[msg("bucket does not belong to this epoch")]
    WrongEpoch,
    #[msg("batch start index does not match cursor")]
    CursorMismatch,
    #[msg("recipients and amounts length mismatch")]
    LengthMismatch,
    #[msg("empty batch")]
    EmptyBatch,
    #[msg("zero-amount recipient")]
    ZeroAmount,
    #[msg("distribution exceeds bucket amount_out")]
    Overpayment,
    #[msg("batch exceeds recipient_count")]
    TooManyRecipients,
    #[msg("recipient ATA does not match recipient")]
    WrongRecipientAta,
    #[msg("allowlist exceeds the maximum length")]
    AllowlistTooLong,
    #[msg("epoch is not settled")]
    NotSettled,
    #[msg("bucket has already been swapped")]
    AlreadySwapped,
    #[msg("out_mint is not in this round's allowlist")]
    OutMintNotAllowed,
    #[msg("swap would exceed the epoch payout amount")]
    SwapExceedsPayout,
    #[msg("min_out is below the slippage floor")]
    SlippageTooLoose,
    #[msg("too many swap accounts for the account-lock bound")]
    TooManySwapAccounts,
    #[msg("CPI target is not the pinned Jupiter program")]
    WrongJupiterProgram,
    #[msg("swap produced no measurable output")]
    SwapNoOutput,
    #[msg("amount_in must be greater than zero")]
    ZeroAmountIn,
    #[msg("allowlist does not match this epoch")]
    WrongAllowlist,
}

// ==========================================================================
// Task 1.2 — CoinConfig and the vault authority PDAs
//
// Definitions and derivations only. No instruction uses these yet; launch_coin,
// claim_and_sweep, vault initialisation and CPIs arrive in later tasks.
// ==========================================================================

/// PDA seeds. Split and fee VALUES live in GlobalConfig (spec §9.5); these are
/// just address seeds, not economic constants.
pub const GLOBAL_SEED: &[u8] = b"global";
pub const COIN_SEED: &[u8] = b"coin";
pub const FEE_SEED: &[u8] = b"fee"; // global FeeClaimer
pub const VAULT_SEED: &[u8] = b"vault"; // per-mint FeeAuthority
pub const PAYOUT_SEED: &[u8] = b"payout"; // per-mint PayoutAuthority
pub const REVENUE_SEED: &[u8] = b"revenue"; // global RevenueAuthority
pub const EPOCH_SEED: &[u8] = b"epoch";
pub const BUCKET_SEED: &[u8] = b"bucket";
pub const ALLOW_SEED: &[u8] = b"allow"; // per-round AllowlistState
pub const PLATFORM_ALLOWLIST_SEED: &[u8] = b"allowlist"; // standing admin allowlist

// ---- Payout-asset bounds (Task 1.9, per updated §4) ----------------------
// One capacity constant governs BOTH allowlists. `AllowlistState` (the per-round
// snapshot) is sized EQUAL to `PlatformAllowlist`, not smaller: a holder can only
// elect a mint that is already in the platform allowlist, so an equal bound makes
// "a round has too many distinct assets to settle" structurally impossible rather
// than merely unlikely — the failure it removes would strand payouts for the most
// popular coins. The §7.3 electable list is then bounded by `PlatformAllowlist` by
// construction, with nothing to keep in sync.
pub const MAX_PLATFORM_ALLOWLIST: usize = 32;
/// Per-round electable-set capacity — deliberately equal to the platform bound.
pub const MAX_ROUND_ASSETS: usize = MAX_PLATFORM_ALLOWLIST;
const _: () = assert!(MAX_ROUND_ASSETS == MAX_PLATFORM_ALLOWLIST, "per-round allowlist must match the platform allowlist capacity");
/// Alias used by `settle_epoch`'s length bound.
pub const MAX_ALLOWLIST: usize = MAX_ROUND_ASSETS;

// ---- swap_payout account budget (Task 1.9 item 1; widened in Task 4.2) ----
/// The Solana per-transaction account-lock ceiling. Every DISTINCT account a
/// transaction touches counts against it; ALTs compress size, not this.
pub const TX_ACCOUNT_LOCK_LIMIT: usize = 64;
/// `SwapPayout`'s named accounts that do NOT also appear in the Jupiter route
/// (`remaining_accounts`). Four of the 15 named accounts — `payout_authority`,
/// `payout_wsol_ata`, `payout_out_ata`, and `token_program` — are always part of
/// Jupiter's own swap-instruction account list, so they are counted there, not
/// here. Counting them in both was the double-count that pinned the budget at 44
/// with no headroom (Task 4.2). Measurement (offchain/scripts/measure-xstock.ts):
/// live WSOL→NVDAx/AAPLx routes build 34–44-account instructions regardless of the
/// off-chain maxAccounts cap, so the fix is a wider on-chain budget, not a lower
/// cap (which would only risk excluding the stocks without shrinking the count).
pub const SWAP_FIXED_ACCOUNTS: usize = 11; // 15 named − 4 guaranteed route overlaps
/// Slack kept below the lock ceiling so a max-length route plus the fixed set
/// never reaches 64. Worst-case distinct locks = SWAP_FIXED_ACCOUNTS + a full
/// remaining set = 11 + 48 = 59 ≤ 64.
pub const SWAP_ACCOUNT_SLACK: usize = 5;
/// Upper bound on `remaining_accounts` in `swap_payout`, enforced on-chain so a
/// compromised keeper cannot route through an unbounded set. = 48, which clears
/// the measured 44-account worst case with headroom; a route that still exceeds
/// it reverts with `TooManySwapAccounts` and the keeper falls back to USDC (§7.3).
pub const MAX_SWAP_REMAINING: usize = TX_ACCOUNT_LOCK_LIMIT - SWAP_FIXED_ACCOUNTS - SWAP_ACCOUNT_SLACK; // = 48
const _: () = assert!(SWAP_FIXED_ACCOUNTS + MAX_SWAP_REMAINING + SWAP_ACCOUNT_SLACK <= TX_ACCOUNT_LOCK_LIMIT, "swap_payout account budget exceeds the tx lock limit");

/// The venue `swap_payout` may CPI into. Pinned, not stored in `GlobalConfig`
/// (spec §4 is an exact field set). Switchable to the local stub via the
/// `stub-jupiter` feature so the same tests run against the real ID later.
#[cfg(feature = "stub-jupiter")]
pub const JUPITER_PROGRAM: Pubkey = pubkey!("FzTPacLNTLbxtVfHyjWofffuiSf41iYuESjsqnkwNjqD");
#[cfg(not(feature = "stub-jupiter"))]
pub const JUPITER_PROGRAM: Pubkey = pubkey!("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"); // Jupiter v6 aggregator

/// `CoinConfig` — per-coin state. Seeds `["coin", mint]`. Fields per spec §4,
/// exact set/order/names/types. `damm_pool` and `locked_position` are `None`
/// while bonding and populated at graduation.
#[account]
#[derive(InitSpace)]
pub struct CoinConfig {
    pub mint: Pubkey,
    pub dbc_pool: Pubkey,
    pub damm_pool: Option<Pubkey>,
    pub locked_position: Option<Pubkey>,
    pub creator_wallet: Pubkey,      // informational; earns nothing
    pub default_payout_mint: Pubkey, // creator's pairing choice, permanent, from PlatformAllowlist (spec §4)
    pub launch_ts: i64,
    pub current_epoch: u32,
    pub total_claimed: u64,
    pub total_paid_out: u64,
    pub status: CoinStatus,
    pub bump: u8,
}

/// Lifecycle of a launched coin.
#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, PartialEq, Eq, Debug)]
pub enum CoinStatus {
    Bonding,
    Graduated,
    Retired,
}

/// PDA derivation helpers. `FeeClaimer` and `RevenueAuthority` are global (no
/// mint); `FeeAuthority` and `PayoutAuthority` are per-mint. Each authority owns
/// its token account(s); the PDA is the authority, not the token account itself.
pub mod pda {
    use super::*;

    pub fn global_config() -> (Pubkey, u8) {
        Pubkey::find_program_address(&[GLOBAL_SEED], &crate::ID)
    }
    pub fn coin_config(mint: &Pubkey) -> (Pubkey, u8) {
        Pubkey::find_program_address(&[COIN_SEED, mint.as_ref()], &crate::ID)
    }
    /// Global DBC fee claimer; signs all claims, owns locked positions.
    pub fn fee_claimer() -> (Pubkey, u8) {
        Pubkey::find_program_address(&[FEE_SEED], &crate::ID)
    }
    /// Per-coin authority over the claimed-fees (pre-split) WSOL ATA.
    pub fn fee_authority(mint: &Pubkey) -> (Pubkey, u8) {
        Pubkey::find_program_address(&[VAULT_SEED, mint.as_ref()], &crate::ID)
    }
    /// Per-coin authority over the 60% payout ATAs (WSOL + one per elected asset).
    pub fn payout_authority(mint: &Pubkey) -> (Pubkey, u8) {
        Pubkey::find_program_address(&[PAYOUT_SEED, mint.as_ref()], &crate::ID)
    }
    /// Global authority over the 30% revenue accruing for $H2E holders.
    pub fn revenue_authority() -> (Pubkey, u8) {
        Pubkey::find_program_address(&[REVENUE_SEED], &crate::ID)
    }
}

#[derive(Accounts)]
pub struct LaunchCoin<'info> {
    /// Creator + payer + dev buyer. Signs the transaction.
    #[account(mut)]
    pub payer: Signer<'info>,
    /// Fresh base-mint keypair; created by the DBC CPI.
    /// CHECK: created by DBC.
    #[account(mut)]
    pub base_mint: Signer<'info>,

    #[account(seeds = [GLOBAL_SEED], bump = global_config.bump)]
    pub global_config: Account<'info, GlobalConfig>,

    /// Standing payout-asset allowlist; the creator's `default_payout_mint` is
    /// validated against it (Task 1.9).
    #[account(seeds = [PLATFORM_ALLOWLIST_SEED], bump = platform_allowlist.bump)]
    pub platform_allowlist: Box<Account<'info, PlatformAllowlist>>,

    /// CHECK: pinned to global_config.platform_config_key in the handler; DBC
    /// deserialises and validates it.
    pub config: UncheckedAccount<'info>,

    /// CHECK: DBC pool authority const.
    #[account(address = DBC_POOL_AUTHORITY)]
    pub pool_authority: UncheckedAccount<'info>,
    /// CHECK: WSOL quote mint.
    #[account(address = WSOL_MINT)]
    pub quote_mint: UncheckedAccount<'info>,
    /// CHECK: DBC pool PDA; validated by DBC.
    #[account(mut)]
    pub pool: UncheckedAccount<'info>,
    /// CHECK: DBC base vault PDA.
    #[account(mut)]
    pub base_vault: UncheckedAccount<'info>,
    /// CHECK: DBC quote vault PDA.
    #[account(mut)]
    pub quote_vault: UncheckedAccount<'info>,
    /// CHECK: metaplex metadata PDA.
    #[account(mut)]
    pub mint_metadata: UncheckedAccount<'info>,
    /// CHECK: metaplex program const.
    #[account(address = METADATA_PROGRAM)]
    pub metadata_program: UncheckedAccount<'info>,

    /// CHECK: creator's WSOL ATA (dev-buy input); wrapped by the client as
    /// pre-instructions. Unused when dev_buy_lamports == 0.
    #[account(mut)]
    pub dev_quote_ata: UncheckedAccount<'info>,
    /// CHECK: creator's base-token ATA (dev-buy output); created in-handler.
    #[account(mut)]
    pub dev_base_ata: UncheckedAccount<'info>,

    /// Per-coin state. Created here; None pools/positions until graduation.
    #[account(
        init,
        payer = payer,
        space = 8 + CoinConfig::INIT_SPACE,
        seeds = [COIN_SEED, base_mint.key().as_ref()],
        bump
    )]
    pub coin_config: Account<'info, CoinConfig>,

    /// CHECK: pinned to global_config.platform_wallet in the handler; receives
    /// the pool creation fee.
    #[account(mut)]
    pub platform_wallet: UncheckedAccount<'info>,

    /// CHECK: SPL token program for base.
    #[account(address = SPL_TOKEN_PROGRAM)]
    pub token_program: UncheckedAccount<'info>,
    /// CHECK: SPL token program for quote.
    #[account(address = SPL_TOKEN_PROGRAM)]
    pub token_quote_program: UncheckedAccount<'info>,
    /// CHECK: associated token program.
    #[account(address = ATA_PROGRAM)]
    pub ata_program: UncheckedAccount<'info>,
    /// CHECK: DBC event authority const.
    #[account(address = DBC_EVENT_AUTHORITY)]
    pub dbc_event_authority: UncheckedAccount<'info>,
    /// CHECK: DBC program, pinned.
    #[account(address = DBC_PROGRAM)]
    pub dbc_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Max dev-buy tokens = supply * bps / 10_000, computed in u128 so a large
/// supply * bps cannot wrap (spec §9.14).
pub fn dev_buy_cap_tokens(supply: u64, bps: u16) -> Result<u128> {
    (supply as u128)
        .checked_mul(bps as u128)
        .and_then(|v| v.checked_div(BPS_DENOMINATOR))
        .ok_or_else(|| error!(H2eError::MathOverflow))
}

/// The three payout shares must sum to exactly 10_000 bps. u32 sum of three u16
/// cannot overflow, but this centralises the invariant for initialize_global and
/// set_params.
pub fn require_bps_sum(holder_bps: u16, h2e_bps: u16, platform_bps: u16) -> Result<()> {
    let sum = holder_bps as u32 + h2e_bps as u32 + platform_bps as u32;
    require!(sum == 10_000, H2eError::InvalidSplit);
    Ok(())
}

/// Borsh string: u32 little-endian length prefix + UTF-8 bytes.
fn write_string(buf: &mut Vec<u8>, s: &str) {
    buf.extend_from_slice(&(s.len() as u32).to_le_bytes());
    buf.extend_from_slice(s.as_bytes());
}

/// SPL mint `supply` is a u64 at byte offset 36.
fn read_mint_supply(ai: &AccountInfo) -> Result<u64> {
    let data = ai.try_borrow_data()?;
    require!(data.len() >= 44, H2eError::BadAccount);
    Ok(u64::from_le_bytes(data[36..44].try_into().unwrap()))
}

/// SPL token-account `amount` is a u64 at byte offset 64.
fn read_token_amount(ai: &AccountInfo) -> Result<u64> {
    let data = ai.try_borrow_data()?;
    require!(data.len() >= 72, H2eError::BadAccount);
    Ok(u64::from_le_bytes(data[64..72].try_into().unwrap()))
}

/// Denylist seed and capacity. Read off-chain by the keeper; small by design.
pub const DENYLIST_SEED: &[u8] = b"denylist";
pub const DENY_MAX: usize = 64;

/// Admin-gated instruction context. `has_one = admin` ties the signer to
/// GlobalConfig.admin — not the upgrade authority, not the keeper.
#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(mut, seeds = [GLOBAL_SEED], bump = global_config.bump, has_one = admin @ H2eError::NotAdmin)]
    pub global_config: Account<'info, GlobalConfig>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct InitDenylist<'info> {
    #[account(seeds = [GLOBAL_SEED], bump = global_config.bump, has_one = admin @ H2eError::NotAdmin)]
    pub global_config: Account<'info, GlobalConfig>,
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + Denylist::INIT_SPACE,
        seeds = [DENYLIST_SEED],
        bump
    )]
    pub denylist: Account<'info, Denylist>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetDenylist<'info> {
    #[account(seeds = [GLOBAL_SEED], bump = global_config.bump, has_one = admin @ H2eError::NotAdmin)]
    pub global_config: Account<'info, GlobalConfig>,
    pub admin: Signer<'info>,
    #[account(mut, seeds = [DENYLIST_SEED], bump = denylist.bump)]
    pub denylist: Account<'info, Denylist>,
}

#[derive(Accounts)]
pub struct InitPlatformAllowlist<'info> {
    #[account(seeds = [GLOBAL_SEED], bump = global_config.bump, has_one = admin @ H2eError::NotAdmin)]
    pub global_config: Account<'info, GlobalConfig>,
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + PlatformAllowlist::INIT_SPACE,
        seeds = [PLATFORM_ALLOWLIST_SEED],
        bump
    )]
    pub platform_allowlist: Account<'info, PlatformAllowlist>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetPlatformAllowlist<'info> {
    #[account(seeds = [GLOBAL_SEED], bump = global_config.bump, has_one = admin @ H2eError::NotAdmin)]
    pub global_config: Account<'info, GlobalConfig>,
    pub admin: Signer<'info>,
    #[account(mut, seeds = [PLATFORM_ALLOWLIST_SEED], bump = platform_allowlist.bump)]
    pub platform_allowlist: Account<'info, PlatformAllowlist>,
}

/// Parameters set by `set_params`. Every mutable economic/config value except the
/// key-separation fields (admin, keeper, h2e_mint) and the pause flags, which
/// have dedicated instructions.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SetParamsArgs {
    pub holder_bps: u16,
    pub h2e_bps: u16,
    pub platform_bps: u16,
    pub dev_buy_cap_bps: u16,
    pub holder_cap_bps: u16,
    pub epoch_seconds: i64,
    pub h2e_epoch_seconds: i64,
    pub max_slippage_bps: u16,
    pub min_sweep_lamports: u64,
    pub pool_creation_fee_lamports: u64,
    pub usdc_mint: Pubkey,
}

/// Admin-managed denylist. Seeds `["denylist"]`. Two bounded lists: excluded
/// payout addresses and blocked payout mints. Read off-chain (spec §7).
#[account]
#[derive(InitSpace)]
pub struct Denylist {
    #[max_len(64)]
    pub addresses: Vec<Pubkey>,
    #[max_len(64)]
    pub mints: Vec<Pubkey>,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, PartialEq, Eq, Debug)]
pub enum DenyKind {
    PayoutAddress,
    PayoutMint,
}

/// `claim_and_sweep` (bonding path). Every WSOL destination is pinned by an
/// `associated_token` constraint to the ATA of the correct authority PDA — a
/// caller cannot substitute their own account (spec §5). The caller is any
/// signer; safety is in the destinations, not a caller allowlist.
#[derive(Accounts)]
pub struct ClaimAndSweep<'info> {
    /// Permissionless caller; pays transaction fees only.
    pub caller: Signer<'info>,

    #[account(seeds = [GLOBAL_SEED], bump = global_config.bump)]
    pub global_config: Box<Account<'info, GlobalConfig>>,

    #[account(
        mut,
        seeds = [COIN_SEED, mint.key().as_ref()],
        bump = coin_config.bump,
        constraint = coin_config.status != CoinStatus::Retired @ H2eError::CoinRetired,
        constraint = coin_config.mint == mint.key() @ H2eError::WrongMint,
        constraint = coin_config.dbc_pool == dbc_pool.key() @ H2eError::WrongPool,
    )]
    pub coin_config: Box<Account<'info, CoinConfig>>,

    /// Base mint of the coin.
    pub mint: Box<Account<'info, Mint>>,
    /// WSOL. The only asset swept.
    #[account(address = WSOL_MINT)]
    pub quote_mint: Box<Account<'info, Mint>>,

    /// CHECK: global ["fee"] PDA — DBC feeClaimer; signs the claim CPI.
    #[account(seeds = [FEE_SEED], bump)]
    pub fee_claimer: UncheckedAccount<'info>,
    /// CHECK: ["vault", mint] PDA — authority over the fee ATAs; signs the split.
    #[account(seeds = [VAULT_SEED, mint.key().as_ref()], bump)]
    pub fee_authority: UncheckedAccount<'info>,

    /// The §5 constrained receiver: WSOL ATA of FeeAuthority(mint).
    #[account(mut, associated_token::mint = quote_mint, associated_token::authority = fee_authority)]
    pub fee_wsol_ata: Box<Account<'info, TokenAccount>>,
    /// Base ATA of FeeAuthority(mint) — DBC's token_a slot (0 under quote-only).
    #[account(mut, associated_token::mint = mint, associated_token::authority = fee_authority)]
    pub fee_base_ata: Box<Account<'info, TokenAccount>>,

    /// CHECK: ["payout", mint] PDA.
    #[account(seeds = [PAYOUT_SEED, mint.key().as_ref()], bump)]
    pub payout_authority: UncheckedAccount<'info>,
    #[account(mut, associated_token::mint = quote_mint, associated_token::authority = payout_authority)]
    pub payout_wsol_ata: Box<Account<'info, TokenAccount>>,

    /// CHECK: ["revenue"] PDA.
    #[account(seeds = [REVENUE_SEED], bump)]
    pub revenue_authority: UncheckedAccount<'info>,
    #[account(mut, associated_token::mint = quote_mint, associated_token::authority = revenue_authority)]
    pub revenue_wsol_ata: Box<Account<'info, TokenAccount>>,

    /// CHECK: pinned to global_config.platform_wallet in the handler.
    pub platform_wallet: UncheckedAccount<'info>,
    #[account(mut, associated_token::mint = quote_mint, associated_token::authority = platform_wallet)]
    pub platform_wsol_ata: Box<Account<'info, TokenAccount>>,

    /// CHECK: pinned to global_config.platform_config_key; DBC deserialises it.
    pub config: UncheckedAccount<'info>,
    /// CHECK: DBC pool authority const.
    #[account(address = DBC_POOL_AUTHORITY)]
    pub dbc_pool_authority: UncheckedAccount<'info>,
    /// CHECK: pinned to coin_config.dbc_pool; validated by DBC.
    #[account(mut)]
    pub dbc_pool: UncheckedAccount<'info>,
    /// CHECK: DBC base vault; validated by DBC.
    #[account(mut)]
    pub base_vault: UncheckedAccount<'info>,
    /// CHECK: DBC quote vault; validated by DBC.
    #[account(mut)]
    pub quote_vault: UncheckedAccount<'info>,
    /// CHECK: DBC event authority const.
    #[account(address = DBC_EVENT_AUTHORITY)]
    pub dbc_event_authority: UncheckedAccount<'info>,
    /// CHECK: DBC program, pinned.
    #[account(address = DBC_PROGRAM)]
    pub dbc_program: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RetireCoin<'info> {
    #[account(seeds = [GLOBAL_SEED], bump = global_config.bump, has_one = admin @ H2eError::NotAdmin)]
    pub global_config: Account<'info, GlobalConfig>,
    pub admin: Signer<'info>,
    #[account(mut, seeds = [COIN_SEED, coin_config.mint.as_ref()], bump = coin_config.bump)]
    pub coin_config: Account<'info, CoinConfig>,
}

#[derive(Accounts)]
pub struct SyncGraduation<'info> {
    /// Permissionless caller.
    pub caller: Signer<'info>,
    #[account(mut, seeds = [COIN_SEED, mint.key().as_ref()], bump = coin_config.bump,
        constraint = coin_config.mint == mint.key() @ H2eError::WrongMint)]
    pub coin_config: Account<'info, CoinConfig>,
    /// CHECK: base mint pubkey; matched against the DBC pool's base_mint and coin_config.
    pub mint: UncheckedAccount<'info>,
    /// CHECK: global ["fee"] PDA; the position NFT must be held by it.
    #[account(seeds = [FEE_SEED], bump)]
    pub fee_claimer: UncheckedAccount<'info>,
    /// CHECK: pinned to coin_config.dbc_pool; read for is_migrated + base_mint.
    pub dbc_pool: UncheckedAccount<'info>,
    /// CHECK: verified in-handler (token mints tie it to this coin).
    pub damm_pool: UncheckedAccount<'info>,
    /// CHECK: verified in-handler (pool + NFT ownership).
    pub locked_position: UncheckedAccount<'info>,
    /// CHECK: verified in-handler (holds the position NFT, owner = fee PDA).
    pub position_nft_account: UncheckedAccount<'info>,
}

/// Read a Pubkey from raw account bytes at `off`. Works for SPL and Token-2022
/// token accounts alike (identical layout for mint/owner/amount).
fn read_pubkey(data: &[u8], off: usize) -> Pubkey {
    Pubkey::new_from_array(data[off..off + 32].try_into().unwrap())
}

#[account]
#[derive(InitSpace)]
pub struct EpochState {
    pub mint: Pubkey,
    pub epoch_index: u32,
    pub start_ts: i64,
    pub end_ts: i64,
    pub payout_amount: u64, // WSOL frozen at settle, before any swap
    pub swapped_in: u64,    // running Σ of buckets' amount_in — bounds swap_payout exactly (§4)
    pub total_weight: u128,
    pub merkle_root: [u8; 32],
    pub bucket_count: u16,
    pub buckets_complete: u16,
    pub settled: bool,
    pub bump: u8,
}

/// The round's snapshotted electable mints (spec §4). Seeds
/// `["allow", mint, epoch_index]`. Written atomically inside `settle_epoch`, so
/// `settled ⟺ allowlist exists`: there is no window in which an epoch is settled
/// but the set of mints `swap_payout` may route into is unconstrained. Chosen over
/// a Merkle root deliberately — a proof would fight the 64-account tx lock limit.
/// The list is exactly the round's distinct elected assets (≈ `bucket_count`), so
/// the `max_len(24)` bound is comfortable; a round electing more distinct assets
/// than that would move the list to a separate chunked instruction (not built).
#[account]
#[derive(InitSpace)]
pub struct AllowlistState {
    pub mint: Pubkey,
    pub epoch_index: u32,
    #[max_len(MAX_ROUND_ASSETS)]
    pub mints: Vec<Pubkey>,
    pub bump: u8,
}

/// Standing admin-maintained set of mints that may ever be a payout asset
/// (spec §4). Seeds `["allowlist"]`. Two consumers: `launch_coin` validates a
/// creator's `default_payout_mint` against it, and `settle_epoch` requires the
/// round's `allowed_mints` to be a subset of it. This is the account that stops a
/// compromised keeper routing funds into an arbitrary mint — the per-round list is
/// keeper-written and would otherwise constrain nothing. Mutate-only after an
/// explicit `init` (no `init_if_needed`, spec §6).
#[account]
#[derive(InitSpace)]
pub struct PlatformAllowlist {
    #[max_len(MAX_PLATFORM_ALLOWLIST)]
    pub mints: Vec<Pubkey>,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct BucketState {
    pub epoch: Pubkey,
    pub out_mint: Pubkey,
    pub amount_in: u64,
    pub amount_out: u64,
    pub recipient_count: u32,
    pub cursor: u32,
    pub paid_amount: u64,
    pub swapped: bool,
    pub complete: bool,
    pub bump: u8,
}

#[derive(Accounts)]
#[instruction(epoch_index: u32)]
pub struct SettleEpoch<'info> {
    #[account(seeds = [GLOBAL_SEED], bump = global_config.bump, has_one = keeper @ H2eError::NotKeeper)]
    pub global_config: Account<'info, GlobalConfig>,
    #[account(mut)]
    pub keeper: Signer<'info>,
    #[account(seeds = [COIN_SEED, mint.key().as_ref()], bump = coin_config.bump, constraint = coin_config.mint == mint.key() @ H2eError::WrongMint)]
    pub coin_config: Account<'info, CoinConfig>,
    /// CHECK: base mint; used in seeds.
    pub mint: UncheckedAccount<'info>,
    /// CHECK: PayoutAuthority PDA.
    #[account(seeds = [PAYOUT_SEED, mint.key().as_ref()], bump)]
    pub payout_authority: UncheckedAccount<'info>,
    #[account(address = WSOL_MINT)]
    pub quote_mint: Box<Account<'info, Mint>>,
    #[account(associated_token::mint = quote_mint, associated_token::authority = payout_authority)]
    pub payout_wsol_ata: Box<Account<'info, TokenAccount>>,
    #[account(init, payer = keeper, space = 8 + EpochState::INIT_SPACE, seeds = [EPOCH_SEED, mint.key().as_ref(), &epoch_index.to_le_bytes()], bump)]
    pub epoch_state: Box<Account<'info, EpochState>>,
    #[account(init, payer = keeper, space = 8 + AllowlistState::INIT_SPACE, seeds = [ALLOW_SEED, mint.key().as_ref(), &epoch_index.to_le_bytes()], bump)]
    pub allowlist_state: Box<Account<'info, AllowlistState>>,
    #[account(seeds = [PLATFORM_ALLOWLIST_SEED], bump = platform_allowlist.bump)]
    pub platform_allowlist: Box<Account<'info, PlatformAllowlist>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(epoch_index: u32)]
pub struct SwapPayout<'info> {
    #[account(seeds = [GLOBAL_SEED], bump = global_config.bump, has_one = keeper @ H2eError::NotKeeper)]
    pub global_config: Account<'info, GlobalConfig>,
    #[account(mut)]
    pub keeper: Signer<'info>,
    #[account(seeds = [COIN_SEED, mint.key().as_ref()], bump = coin_config.bump, constraint = coin_config.mint == mint.key() @ H2eError::WrongMint)]
    pub coin_config: Account<'info, CoinConfig>,
    /// CHECK: base mint; used in seeds.
    pub mint: UncheckedAccount<'info>,
    /// CHECK: PayoutAuthority PDA (swap authority).
    #[account(seeds = [PAYOUT_SEED, mint.key().as_ref()], bump)]
    pub payout_authority: UncheckedAccount<'info>,
    #[account(mut, seeds = [EPOCH_SEED, mint.key().as_ref(), &epoch_index.to_le_bytes()], bump = epoch_state.bump)]
    pub epoch_state: Box<Account<'info, EpochState>>,
    #[account(seeds = [ALLOW_SEED, mint.key().as_ref(), &epoch_index.to_le_bytes()], bump = allowlist_state.bump)]
    pub allowlist_state: Box<Account<'info, AllowlistState>>,
    #[account(init, payer = keeper, space = 8 + BucketState::INIT_SPACE, seeds = [BUCKET_SEED, mint.key().as_ref(), &epoch_index.to_le_bytes(), out_mint.key().as_ref()], bump)]
    pub bucket_state: Box<Account<'info, BucketState>>,
    /// `token::Mint` deserialisation requires the classic SPL Token program as
    /// owner, so Token-2022 mints are rejected here — the §7.3 v1 restriction,
    /// enforced structurally rather than by a runtime owner check.
    pub out_mint: Box<Account<'info, Mint>>,
    #[account(address = WSOL_MINT)]
    pub quote_mint: Box<Account<'info, Mint>>,
    #[account(mut, associated_token::mint = quote_mint, associated_token::authority = payout_authority)]
    pub payout_wsol_ata: Box<Account<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = out_mint, associated_token::authority = payout_authority)]
    pub payout_out_ata: Box<Account<'info, TokenAccount>>,
    /// CHECK: the pinned Jupiter (or stub) venue; address-gated.
    #[account(address = JUPITER_PROGRAM @ H2eError::WrongJupiterProgram)]
    pub jupiter_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(epoch_index: u32)]
pub struct DistributeBatch<'info> {
    #[account(seeds = [GLOBAL_SEED], bump = global_config.bump, has_one = keeper @ H2eError::NotKeeper)]
    pub global_config: Account<'info, GlobalConfig>,
    pub keeper: Signer<'info>,
    /// CHECK: base mint; used in seeds.
    pub mint: UncheckedAccount<'info>,
    #[account(mut, seeds = [EPOCH_SEED, mint.key().as_ref(), &epoch_index.to_le_bytes()], bump = epoch_state.bump)]
    pub epoch_state: Box<Account<'info, EpochState>>,
    #[account(mut, seeds = [BUCKET_SEED, mint.key().as_ref(), &epoch_index.to_le_bytes(), out_mint.key().as_ref()], bump = bucket_state.bump)]
    pub bucket_state: Box<Account<'info, BucketState>>,
    pub out_mint: Box<Account<'info, Mint>>,
    /// CHECK: PayoutAuthority PDA (transfer authority).
    #[account(seeds = [PAYOUT_SEED, mint.key().as_ref()], bump)]
    pub payout_authority: UncheckedAccount<'info>,
    #[account(mut, associated_token::mint = out_mint, associated_token::authority = payout_authority)]
    pub payout_out_ata: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SetGraduation<'info> {
    #[account(seeds = [GLOBAL_SEED], bump = global_config.bump, has_one = admin @ H2eError::NotAdmin)]
    pub global_config: Account<'info, GlobalConfig>,
    pub admin: Signer<'info>,
    #[account(mut, seeds = [COIN_SEED, coin_config.mint.as_ref()], bump = coin_config.bump)]
    pub coin_config: Account<'info, CoinConfig>,
}

#[cfg(test)]
mod tests {
    //! Layout tests for CoinConfig (spec §4) exercised against the REAL Rust
    //! borsh layout — the source of truth. CoinConfig is pruned from the IDL
    //! until an instruction references it (Task 1.3's launch_coin), so these run
    //! here rather than in TS to avoid a hand-written schema that could drift.
    use super::*;
    use anchor_lang::{AnchorDeserialize, AnchorSerialize, Discriminator};

    fn sample(damm: Option<Pubkey>, locked: Option<Pubkey>, status: CoinStatus) -> CoinConfig {
        CoinConfig {
            mint: Pubkey::new_unique(),
            dbc_pool: Pubkey::new_unique(),
            damm_pool: damm,
            locked_position: locked,
            creator_wallet: Pubkey::new_unique(),
            default_payout_mint: Pubkey::new_unique(),
            launch_ts: 1_700_000_000,
            current_epoch: 7,
            total_claimed: 123,
            total_paid_out: 45,
            status,
            bump: 254,
        }
    }

    #[test]
    fn init_space_and_allocation() {
        // Field bytes (borsh max, options counted as Some = 1 + 32):
        //   mint 32, dbc_pool 32, damm_pool 33, locked_position 33,
        //   creator_wallet 32, default_payout_mint 32, launch_ts 8,
        //   current_epoch 4, total_claimed 8, total_paid_out 8, status 1, bump 1 = 224
        assert_eq!(CoinConfig::INIT_SPACE, 224);
        // On-chain account = 8-byte discriminator + INIT_SPACE.
        assert_eq!(8 + CoinConfig::INIT_SPACE, 232);
        assert_eq!(CoinConfig::DISCRIMINATOR.len(), 8);
    }

    #[test]
    fn option_pubkey_roundtrips_none_and_some() {
        let pk1 = Pubkey::new_unique();
        let pk2 = Pubkey::new_unique();

        let none = sample(None, None, CoinStatus::Bonding);
        let none_bytes = none.try_to_vec().unwrap();
        // borsh (no discriminator): both options None -> 1 tag byte each.
        // 224 - 2*32 (the two absent pubkey bodies) = 160.
        assert_eq!(none_bytes.len(), 160);
        let back = CoinConfig::try_from_slice(&none_bytes).unwrap();
        assert_eq!(back.damm_pool, None);
        assert_eq!(back.locked_position, None);

        let some = sample(Some(pk1), Some(pk2), CoinStatus::Graduated);
        let some_bytes = some.try_to_vec().unwrap();
        // both options Some -> full 224 (== INIT_SPACE, the allocation reserves max).
        assert_eq!(some_bytes.len(), 224);
        let back = CoinConfig::try_from_slice(&some_bytes).unwrap();
        assert_eq!(back.damm_pool, Some(pk1));
        assert_eq!(back.locked_position, Some(pk2));

        // mixed
        let mixed = sample(Some(pk1), None, CoinStatus::Retired);
        let mixed_bytes = mixed.try_to_vec().unwrap();
        assert_eq!(mixed_bytes.len(), 160 + 32); // one Some adds 32
        let back = CoinConfig::try_from_slice(&mixed_bytes).unwrap();
        assert_eq!(back.damm_pool, Some(pk1));
        assert_eq!(back.locked_position, None);
    }

    #[test]
    fn coin_status_roundtrips_all_variants() {
        for (i, s) in [CoinStatus::Bonding, CoinStatus::Graduated, CoinStatus::Retired]
            .into_iter()
            .enumerate()
        {
            let b = s.try_to_vec().unwrap();
            assert_eq!(b.len(), 1, "unit enum variant is one byte");
            assert_eq!(b[0] as usize, i, "discriminant is declaration order");
            assert_eq!(CoinStatus::try_from_slice(&b).unwrap(), s);
        }
        assert_eq!(CoinStatus::INIT_SPACE, 1);
    }

    #[test]
    fn dev_buy_cap_no_u64_overflow() {
        // supply large enough that a naive u64 `supply * bps` overflows:
        // 1e18 base units (e.g. 1e9 tokens at 9 decimals), * 300 = 3e20 > u64::MAX.
        let supply: u64 = 1_000_000_000u64 * 1_000_000_000u64; // 1e18
        assert!(supply.checked_mul(300).is_none(), "naive u64 mul would overflow");
        // u128 path returns the correct cap without wrapping.
        let cap = dev_buy_cap_tokens(supply, 300).unwrap();
        assert_eq!(cap, 30_000_000_000_000_000u128); // 3% of 1e18 = 3e16
        // sanity: an acquisition just over the cap is rejected, just under passes.
        assert!((cap as u128) >= cap);
        assert!((30_000_000_000_000_001u128) > cap);
        assert!((29_999_999_999_999_999u128) < cap);
    }

    #[test]
    fn require_bps_sum_enforced() {
        assert!(require_bps_sum(6000, 3000, 1000).is_ok());
        assert!(require_bps_sum(6000, 3000, 1001).is_err());
        assert!(require_bps_sum(6000, 3000, 999).is_err());
        // extreme values still cannot overflow the u32 sum
        assert!(require_bps_sum(u16::MAX, u16::MAX, u16::MAX).is_err());
    }

    #[test]
    fn pda_seeds_are_distinct_and_global_ones_ignore_mint() {
        let m1 = Pubkey::new_unique();
        let m2 = Pubkey::new_unique();
        assert_eq!(pda::fee_claimer(), pda::fee_claimer()); // stable, global
        assert_eq!(pda::revenue_authority(), pda::revenue_authority());
        assert_ne!(pda::fee_authority(&m1).0, pda::fee_authority(&m2).0);
        assert_ne!(pda::payout_authority(&m1).0, pda::payout_authority(&m2).0);
        // FeeAuthority and PayoutAuthority must never collide for the same mint.
        assert_ne!(pda::fee_authority(&m1).0, pda::payout_authority(&m1).0);
    }
}
