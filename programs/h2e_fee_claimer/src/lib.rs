//! H2E fee claimer — Task 0.2 feasibility program.
//!
//! Proves exactly one thing: that a SINGLE global PDA (seeds `["fee"]`) can act
//! as the DBC `feeClaimer` for MANY pools, claiming each pool's partner fees
//! separately via CPI with `invoke_signed`, and routing proceeds to an
//! arbitrary receiver.
//!
//! Deliberately minimal. There is NO authority check on `claim_partner_fees`:
//! that omission is itself part of what the task asks to be demonstrated.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::{invoke, invoke_signed};

declare_id!("BMC4fwHFriXWz34dPgXaBm7yd8MopGh9u47cyMpAKWia");

/// Meteora Dynamic Bonding Curve program.
pub const DBC_PROGRAM_ID: Pubkey = pubkey!("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");

/// Anchor discriminator for DBC `claim_trading_fee`, taken from the DBC IDL.
const CLAIM_TRADING_FEE_DISCRIMINATOR: [u8; 8] = [8, 236, 89, 49, 152, 125, 177, 81];

/// Meteora DAMM v2 (cp-amm) program.
pub const DAMM_V2_PROGRAM_ID: Pubkey = pubkey!("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");

/// Anchor discriminator for DAMM v2 `claim_position_fee`, taken from its IDL.
const CLAIM_POSITION_FEE_DISCRIMINATOR: [u8; 8] = [180, 38, 154, 17, 133, 33, 162, 211];

// ---- launch_coin constants (Task 0.4) ----
/// Platform's global DBC config key. Pools MUST be created from this, so the
/// platform PDA is always the fee claimer. Hardcoded for this feasibility test.
pub const PLATFORM_CONFIG: Pubkey = pubkey!("9p8GkEK1ptHExWFUqtKA3KWjiG6SD8iC3HoRFQ1Xw1fm");
/// DBC pool authority (fixed program constant).
pub const DBC_POOL_AUTHORITY: Pubkey = pubkey!("FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM");
/// DBC event authority (fixed).
pub const DBC_EVENT_AUTHORITY: Pubkey = pubkey!("8Ks12pbrD6PXxfty1hVQiE9sc289zgU1zHkvXhrSdriF");
pub const WSOL_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
pub const METADATA_PROGRAM: Pubkey = pubkey!("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
pub const ATA_PROGRAM: Pubkey = pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
pub const SPL_TOKEN_PROGRAM: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

const INIT_POOL_SPL_DISCRIMINATOR: [u8; 8] = [140, 85, 215, 176, 102, 54, 104, 79];
const SWAP_DISCRIMINATOR: [u8; 8] = [248, 198, 158, 145, 225, 117, 135, 200];

/// Max dev buy: 3% of total supply.
const DEV_BUY_CAP_NUM: u128 = 3;
const DEV_BUY_CAP_DEN: u128 = 100;

/// Seed for the one global fee-claimer PDA. Not per-mint: that is the point.
pub const FEE_SEED: &[u8] = b"fee";

#[program]
pub mod h2e_fee_claimer {
    use super::*;

    /// Claim one pool's partner trading fees, signing as the global `["fee"]`
    /// PDA, and send them to the token accounts supplied by the caller.
    ///
    /// `token_a_account` / `token_b_account` are the receiver's token accounts.
    /// DBC places no ownership constraint on them, so they may belong to any
    /// account at all — that is what makes arbitrary routing possible.
    pub fn claim_partner_fees(
        ctx: Context<ClaimPartnerFees>,
        max_base_amount: u64,
        max_quote_amount: u64,
    ) -> Result<()> {
        let bump = ctx.bumps.fee_authority;
        let signer_seeds: &[&[&[u8]]] = &[&[FEE_SEED, &[bump]]];

        // Account order must match the DBC IDL for claim_trading_fee exactly.
        let account_metas = vec![
            AccountMeta::new_readonly(ctx.accounts.pool_authority.key(), false),
            AccountMeta::new_readonly(ctx.accounts.config.key(), false),
            AccountMeta::new(ctx.accounts.pool.key(), false),
            AccountMeta::new(ctx.accounts.token_a_account.key(), false),
            AccountMeta::new(ctx.accounts.token_b_account.key(), false),
            AccountMeta::new(ctx.accounts.base_vault.key(), false),
            AccountMeta::new(ctx.accounts.quote_vault.key(), false),
            AccountMeta::new_readonly(ctx.accounts.base_mint.key(), false),
            AccountMeta::new_readonly(ctx.accounts.quote_mint.key(), false),
            // The PDA signs here.
            AccountMeta::new_readonly(ctx.accounts.fee_authority.key(), true),
            AccountMeta::new_readonly(ctx.accounts.token_base_program.key(), false),
            AccountMeta::new_readonly(ctx.accounts.token_quote_program.key(), false),
            AccountMeta::new_readonly(ctx.accounts.event_authority.key(), false),
            AccountMeta::new_readonly(ctx.accounts.dbc_program.key(), false),
        ];

        let mut data = Vec::with_capacity(24);
        data.extend_from_slice(&CLAIM_TRADING_FEE_DISCRIMINATOR);
        data.extend_from_slice(&max_base_amount.to_le_bytes());
        data.extend_from_slice(&max_quote_amount.to_le_bytes());

        let ix = Instruction {
            program_id: ctx.accounts.dbc_program.key(),
            accounts: account_metas,
            data,
        };

        let account_infos = &[
            ctx.accounts.pool_authority.to_account_info(),
            ctx.accounts.config.to_account_info(),
            ctx.accounts.pool.to_account_info(),
            ctx.accounts.token_a_account.to_account_info(),
            ctx.accounts.token_b_account.to_account_info(),
            ctx.accounts.base_vault.to_account_info(),
            ctx.accounts.quote_vault.to_account_info(),
            ctx.accounts.base_mint.to_account_info(),
            ctx.accounts.quote_mint.to_account_info(),
            ctx.accounts.fee_authority.to_account_info(),
            ctx.accounts.token_base_program.to_account_info(),
            ctx.accounts.token_quote_program.to_account_info(),
            ctx.accounts.event_authority.to_account_info(),
            ctx.accounts.dbc_program.to_account_info(),
        ];

        invoke_signed(&ix, account_infos, signer_seeds)?;

        msg!("claimed partner fees for pool {}", ctx.accounts.pool.key());
        Ok(())
    }

    /// Claim trading fees from a permanently-locked DAMM v2 position, signing as
    /// the same global `["fee"]` PDA (which owns the position NFT account after
    /// DBC migration set its authority to config.fee_claimer). Routes proceeds to
    /// the caller-supplied token accounts.
    ///
    /// CPIs DAMM v2 `claim_position_fee`, which takes no args.
    pub fn claim_locked_lp_fees(ctx: Context<ClaimLockedLpFees>) -> Result<()> {
        let bump = ctx.bumps.fee_authority;
        let signer_seeds: &[&[&[u8]]] = &[&[FEE_SEED, &[bump]]];

        // Account order must match the DAMM v2 IDL for claim_position_fee.
        let account_metas = vec![
            AccountMeta::new_readonly(ctx.accounts.damm_pool_authority.key(), false),
            AccountMeta::new_readonly(ctx.accounts.pool.key(), false),
            AccountMeta::new(ctx.accounts.position.key(), false),
            AccountMeta::new(ctx.accounts.token_a_account.key(), false),
            AccountMeta::new(ctx.accounts.token_b_account.key(), false),
            AccountMeta::new(ctx.accounts.token_a_vault.key(), false),
            AccountMeta::new(ctx.accounts.token_b_vault.key(), false),
            AccountMeta::new_readonly(ctx.accounts.token_a_mint.key(), false),
            AccountMeta::new_readonly(ctx.accounts.token_b_mint.key(), false),
            AccountMeta::new_readonly(ctx.accounts.position_nft_account.key(), false),
            // The PDA is the position NFT account owner and signs here.
            AccountMeta::new_readonly(ctx.accounts.fee_authority.key(), true),
            AccountMeta::new_readonly(ctx.accounts.token_a_program.key(), false),
            AccountMeta::new_readonly(ctx.accounts.token_b_program.key(), false),
            AccountMeta::new_readonly(ctx.accounts.event_authority.key(), false),
            AccountMeta::new_readonly(ctx.accounts.damm_program.key(), false),
        ];

        let ix = Instruction {
            program_id: ctx.accounts.damm_program.key(),
            accounts: account_metas,
            data: CLAIM_POSITION_FEE_DISCRIMINATOR.to_vec(),
        };

        let account_infos = &[
            ctx.accounts.damm_pool_authority.to_account_info(),
            ctx.accounts.pool.to_account_info(),
            ctx.accounts.position.to_account_info(),
            ctx.accounts.token_a_account.to_account_info(),
            ctx.accounts.token_b_account.to_account_info(),
            ctx.accounts.token_a_vault.to_account_info(),
            ctx.accounts.token_b_vault.to_account_info(),
            ctx.accounts.token_a_mint.to_account_info(),
            ctx.accounts.token_b_mint.to_account_info(),
            ctx.accounts.position_nft_account.to_account_info(),
            ctx.accounts.fee_authority.to_account_info(),
            ctx.accounts.token_a_program.to_account_info(),
            ctx.accounts.token_b_program.to_account_info(),
            ctx.accounts.event_authority.to_account_info(),
            ctx.accounts.damm_program.to_account_info(),
        ];

        invoke_signed(&ix, account_infos, signer_seeds)?;

        msg!("claimed locked-LP fees for position {}", ctx.accounts.position.key());
        Ok(())
    }

    /// Create a DBC pool from the platform's global config (so the platform PDA
    /// is the fee claimer) and, atomically, perform an optional dev buy capped at
    /// 3% of total supply. Both rules hold by construction; no sysvar
    /// introspection.
    ///
    /// The caller signs as creator + payer; `base_mint` is a fresh signer keypair
    /// from the caller. Neither the config nor the cap can be chosen by the
    /// caller: the config is pinned to PLATFORM_CONFIG, and the cap is computed
    /// from the actual on-chain mint supply and the actual token delta.
    pub fn launch_coin(
        ctx: Context<LaunchCoin>,
        name: String,
        symbol: String,
        uri: String,
        dev_buy_lamports: u64,
    ) -> Result<()> {
        require_keys_eq!(ctx.accounts.config.key(), PLATFORM_CONFIG, H2eError::WrongConfig);

        // ---- 1. CPI: create the pool (mint + vaults + metadata) ----
        let mut cp_data = Vec::with_capacity(64);
        cp_data.extend_from_slice(&INIT_POOL_SPL_DISCRIMINATOR);
        write_string(&mut cp_data, &name);
        write_string(&mut cp_data, &symbol);
        write_string(&mut cp_data, &uri);

        let cp_metas = vec![
            AccountMeta::new_readonly(ctx.accounts.config.key(), false),
            AccountMeta::new_readonly(ctx.accounts.pool_authority.key(), false),
            AccountMeta::new_readonly(ctx.accounts.creator.key(), true),
            AccountMeta::new(ctx.accounts.base_mint.key(), true),
            AccountMeta::new_readonly(ctx.accounts.quote_mint.key(), false),
            AccountMeta::new(ctx.accounts.pool.key(), false),
            AccountMeta::new(ctx.accounts.base_vault.key(), false),
            AccountMeta::new(ctx.accounts.quote_vault.key(), false),
            AccountMeta::new(ctx.accounts.mint_metadata.key(), false),
            AccountMeta::new_readonly(ctx.accounts.metadata_program.key(), false),
            AccountMeta::new(ctx.accounts.payer.key(), true),
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
                ctx.accounts.creator.to_account_info(),
                ctx.accounts.base_mint.to_account_info(),
                ctx.accounts.quote_mint.to_account_info(),
                ctx.accounts.pool.to_account_info(),
                ctx.accounts.base_vault.to_account_info(),
                ctx.accounts.quote_vault.to_account_info(),
                ctx.accounts.mint_metadata.to_account_info(),
                ctx.accounts.metadata_program.to_account_info(),
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.token_quote_program.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.dbc_event_authority.to_account_info(),
                ctx.accounts.dbc_program.to_account_info(),
            ],
        )?;
        msg!("pool created: {}", ctx.accounts.pool.key());

        if dev_buy_lamports == 0 {
            msg!("no dev buy");
            return Ok(());
        }

        // ---- 2. Total supply and 3% cap, read from the freshly minted supply ----
        let total_supply = read_mint_supply(&ctx.accounts.base_mint.to_account_info())?;
        let max_dev_tokens = (total_supply as u128)
            .checked_mul(DEV_BUY_CAP_NUM).unwrap()
            .checked_div(DEV_BUY_CAP_DEN).unwrap() as u64;
        msg!("total_supply={} max_dev_tokens(3%)={}", total_supply, max_dev_tokens);

        // ---- 3. CPI: create the caller's base ATA (idempotent) ----
        let ata_metas = vec![
            AccountMeta::new(ctx.accounts.payer.key(), true),
            AccountMeta::new(ctx.accounts.dev_base_ata.key(), false),
            AccountMeta::new_readonly(ctx.accounts.creator.key(), false),
            AccountMeta::new_readonly(ctx.accounts.base_mint.key(), false),
            AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
            AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
        ];
        invoke(
            &Instruction { program_id: ctx.accounts.ata_program.key(), accounts: ata_metas, data: vec![1u8] },
            &[
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.dev_base_ata.to_account_info(),
                ctx.accounts.creator.to_account_info(),
                ctx.accounts.base_mint.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
                ctx.accounts.ata_program.to_account_info(),
            ],
        )?;

        let before = read_token_amount(&ctx.accounts.dev_base_ata.to_account_info())?;

        // ---- 4. CPI: dev buy (WSOL in -> base tokens to caller's ATA) ----
        let mut sw_data = Vec::with_capacity(24);
        sw_data.extend_from_slice(&SWAP_DISCRIMINATOR);
        sw_data.extend_from_slice(&dev_buy_lamports.to_le_bytes()); // amount_in
        sw_data.extend_from_slice(&0u64.to_le_bytes());             // minimum_amount_out
        let sw_metas = vec![
            AccountMeta::new_readonly(ctx.accounts.pool_authority.key(), false),
            AccountMeta::new_readonly(ctx.accounts.config.key(), false),
            AccountMeta::new(ctx.accounts.pool.key(), false),
            AccountMeta::new(ctx.accounts.dev_quote_ata.key(), false),  // input (WSOL)
            AccountMeta::new(ctx.accounts.dev_base_ata.key(), false),   // output (base)
            AccountMeta::new(ctx.accounts.base_vault.key(), false),
            AccountMeta::new(ctx.accounts.quote_vault.key(), false),
            AccountMeta::new_readonly(ctx.accounts.base_mint.key(), false),
            AccountMeta::new_readonly(ctx.accounts.quote_mint.key(), false),
            AccountMeta::new_readonly(ctx.accounts.payer.key(), true),
            AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
            AccountMeta::new_readonly(ctx.accounts.token_quote_program.key(), false),
            // referral_token_account is optional; passing the program id signals None.
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
                ctx.accounts.dbc_program.to_account_info(), // referral placeholder (None)
                ctx.accounts.dbc_event_authority.to_account_info(),
                ctx.accounts.dbc_program.to_account_info(),
            ],
        )?;

        // ---- 5. Enforce the 3% cap on the ACTUAL acquired amount ----
        let after = read_token_amount(&ctx.accounts.dev_base_ata.to_account_info())?;
        let acquired = after.checked_sub(before).unwrap();
        msg!("dev acquired {} base tokens (cap {})", acquired, max_dev_tokens);
        require!(acquired <= max_dev_tokens, H2eError::DevBuyExceedsCap);

        Ok(())
    }
}

/// Borsh: write a string as u32 length prefix + utf8 bytes.
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

/// SPL token account `amount` is a u64 at byte offset 64.
fn read_token_amount(ai: &AccountInfo) -> Result<u64> {
    let data = ai.try_borrow_data()?;
    require!(data.len() >= 72, H2eError::BadAccount);
    Ok(u64::from_le_bytes(data[64..72].try_into().unwrap()))
}

#[error_code]
pub enum H2eError {
    #[msg("pool config is not the platform config")]
    WrongConfig,
    #[msg("dev buy exceeds 3% of total supply")]
    DevBuyExceedsCap,
    #[msg("account data too small")]
    BadAccount,
}

#[derive(Accounts)]
pub struct ClaimPartnerFees<'info> {
    /// The one global fee-claimer PDA. Holds no data; exists only to sign.
    /// CHECK: verified by the seeds constraint; DBC additionally checks it
    /// against config.fee_claimer.
    #[account(seeds = [FEE_SEED], bump)]
    pub fee_authority: UncheckedAccount<'info>,

    /// CHECK: passed through to DBC, which validates it against its own const.
    pub pool_authority: UncheckedAccount<'info>,
    /// CHECK: passed through to DBC, which deserialises and validates it.
    pub config: UncheckedAccount<'info>,
    /// CHECK: passed through to DBC, which deserialises and validates it.
    #[account(mut)]
    pub pool: UncheckedAccount<'info>,
    /// CHECK: receiver's base token account. DBC enforces no owner constraint.
    #[account(mut)]
    pub token_a_account: UncheckedAccount<'info>,
    /// CHECK: receiver's quote token account. DBC enforces no owner constraint.
    #[account(mut)]
    pub token_b_account: UncheckedAccount<'info>,
    /// CHECK: validated by DBC against pool.base_vault.
    #[account(mut)]
    pub base_vault: UncheckedAccount<'info>,
    /// CHECK: validated by DBC against pool.quote_vault.
    #[account(mut)]
    pub quote_vault: UncheckedAccount<'info>,
    /// CHECK: validated by DBC against pool.base_mint.
    pub base_mint: UncheckedAccount<'info>,
    /// CHECK: validated by DBC against config.quote_mint.
    pub quote_mint: UncheckedAccount<'info>,
    /// CHECK: SPL Token program for the base mint.
    pub token_base_program: UncheckedAccount<'info>,
    /// CHECK: SPL Token program for the quote mint.
    pub token_quote_program: UncheckedAccount<'info>,
    /// CHECK: DBC's event_cpi authority PDA.
    pub event_authority: UncheckedAccount<'info>,
    /// CHECK: the DBC program itself; pinned to the known program id.
    #[account(address = DBC_PROGRAM_ID)]
    pub dbc_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct ClaimLockedLpFees<'info> {
    /// The one global fee-claimer PDA; owns the locked position NFT account and
    /// signs the DAMM v2 claim.
    /// CHECK: verified by seeds; DAMM v2 checks it owns position_nft_account.
    #[account(seeds = [FEE_SEED], bump)]
    pub fee_authority: UncheckedAccount<'info>,

    /// CHECK: DAMM v2 pool authority; validated by DAMM v2 against its const.
    pub damm_pool_authority: UncheckedAccount<'info>,
    /// CHECK: DAMM v2 pool; validated by DAMM v2.
    pub pool: UncheckedAccount<'info>,
    /// CHECK: the locked position; validated by DAMM v2.
    #[account(mut)]
    pub position: UncheckedAccount<'info>,
    /// CHECK: receiver base token account. No owner constraint in DAMM v2.
    #[account(mut)]
    pub token_a_account: UncheckedAccount<'info>,
    /// CHECK: receiver quote token account. No owner constraint in DAMM v2.
    #[account(mut)]
    pub token_b_account: UncheckedAccount<'info>,
    /// CHECK: validated by DAMM v2 against pool.token_a_vault.
    #[account(mut)]
    pub token_a_vault: UncheckedAccount<'info>,
    /// CHECK: validated by DAMM v2 against pool.token_b_vault.
    #[account(mut)]
    pub token_b_vault: UncheckedAccount<'info>,
    /// CHECK: validated by DAMM v2 against pool.token_a_mint.
    pub token_a_mint: UncheckedAccount<'info>,
    /// CHECK: validated by DAMM v2 against pool.token_b_mint.
    pub token_b_mint: UncheckedAccount<'info>,
    /// CHECK: the token account holding the position NFT, owned by fee_authority.
    pub position_nft_account: UncheckedAccount<'info>,
    /// CHECK: SPL token program for token A.
    pub token_a_program: UncheckedAccount<'info>,
    /// CHECK: SPL token program for token B.
    pub token_b_program: UncheckedAccount<'info>,
    /// CHECK: DAMM v2 event_cpi authority.
    pub event_authority: UncheckedAccount<'info>,
    /// CHECK: the DAMM v2 program; pinned to the known id.
    #[account(address = DAMM_V2_PROGRAM_ID)]
    pub damm_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct LaunchCoin<'info> {
    /// Caller: creator + payer + dev buyer. Signs the whole thing.
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: same as payer (creator role); kept separate to match DBC account list.
    #[account(mut)]
    pub creator: Signer<'info>,
    /// The fresh base mint. Caller-generated signer.
    /// CHECK: created by DBC.
    #[account(mut)]
    pub base_mint: Signer<'info>,

    /// CHECK: pinned to PLATFORM_CONFIG in the handler.
    pub config: UncheckedAccount<'info>,
    /// CHECK: DBC pool authority const.
    #[account(address = DBC_POOL_AUTHORITY)]
    pub pool_authority: UncheckedAccount<'info>,
    /// CHECK: WSOL.
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

    /// Caller's WSOL account (input for the dev buy). Funded/wrapped by the
    /// client as pre-instructions. Unused when dev_buy_lamports == 0.
    /// CHECK: passed to DBC swap.
    #[account(mut)]
    pub dev_quote_ata: UncheckedAccount<'info>,
    /// Caller's base-token ATA (dev buy output). Created idempotently in-handler.
    /// CHECK: created + validated via ATA program / DBC.
    #[account(mut)]
    pub dev_base_ata: UncheckedAccount<'info>,

    /// CHECK: SPL token program for base.
    #[account(address = SPL_TOKEN_PROGRAM)]
    pub token_program: UncheckedAccount<'info>,
    /// CHECK: SPL token program for quote.
    #[account(address = SPL_TOKEN_PROGRAM)]
    pub token_quote_program: UncheckedAccount<'info>,
    /// CHECK: ATA program const.
    #[account(address = ATA_PROGRAM)]
    pub ata_program: UncheckedAccount<'info>,
    /// CHECK: DBC event authority const.
    #[account(address = DBC_EVENT_AUTHORITY)]
    pub dbc_event_authority: UncheckedAccount<'info>,
    /// CHECK: DBC program, pinned.
    #[account(address = DBC_PROGRAM_ID)]
    pub dbc_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}
