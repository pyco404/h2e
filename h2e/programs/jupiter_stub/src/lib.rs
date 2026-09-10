//! Local stand-in for the Jupiter aggregator, used only by the `swap_payout`
//! tests (Task 1.8b). It performs a **fixed, caller-specified** swap: pull
//! `amount_in` of the source mint from the caller into a reserve, and pay
//! `out_amount` of the destination mint from a reserve back to the caller.
//!
//! `out_amount` is an explicit argument, not a rate, so a test can make the stub
//! return **less than quoted** — that is the whole point of test 2: it proves
//! `swap_payout` records the measured balance delta, never the quote. Jupiter's
//! real routing is not ours to verify; venue pinning, the slippage floor, the
//! delta measurement and the state machine are. The H2E program CPIs into this
//! program by its ID via the `stub-jupiter` feature; flip that feature off to
//! pin the mainnet venue and the same tests re-run unchanged.
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("FzTPacLNTLbxtVfHyjWofffuiSf41iYuESjsqnkwNjqD");

/// Reserve authority PDA — owns both reserve token accounts.
pub const RESERVE_SEED: &[u8] = b"reserve";

#[program]
pub mod jupiter_stub {
    use super::*;

    /// Fixed swap. `amount_in` of `source` is pulled from the caller's account to
    /// the source reserve (authority = the caller, forced signer by the CPI);
    /// `out_amount` of `dest` is paid from the dest reserve to the caller
    /// (authority = the reserve PDA, signed internally). A test controls both
    /// numbers, so it can make `out_amount < quoted` to exercise the delta path.
    pub fn stub_swap(ctx: Context<StubSwap>, amount_in: u64, out_amount: u64) -> Result<()> {
        // Caller pays in: source -> source reserve, signed by the caller authority.
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_source.to_account_info(),
                    to: ctx.accounts.reserve_source.to_account_info(),
                    authority: ctx.accounts.user_authority.to_account_info(),
                },
            ),
            amount_in,
        )?;

        // Stub pays out: dest reserve -> caller dest, signed by the reserve PDA.
        let bump = ctx.bumps.reserve_authority;
        let signer: &[&[&[u8]]] = &[&[RESERVE_SEED, &[bump]]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.reserve_dest.to_account_info(),
                    to: ctx.accounts.user_dest.to_account_info(),
                    authority: ctx.accounts.reserve_authority.to_account_info(),
                },
                signer,
            ),
            out_amount,
        )?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct StubSwap<'info> {
    /// The caller whose source tokens are spent. Forced signer by H2E's
    /// `invoke_signed` (the PayoutAuthority PDA).
    /// CHECK: authority only; validated by the token transfer.
    pub user_authority: UncheckedAccount<'info>,
    #[account(mut)]
    pub user_source: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub user_dest: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub reserve_source: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub reserve_dest: Box<Account<'info, TokenAccount>>,
    /// CHECK: reserve authority PDA; seeds-checked.
    #[account(seeds = [RESERVE_SEED], bump)]
    pub reserve_authority: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}
