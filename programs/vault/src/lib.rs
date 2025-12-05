use anchor_lang::prelude::*;
use anchor_lang::solana_program::{instruction::Instruction, program::invoke_signed};
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, Transfer},
};

declare_id!("8FaCEp8fDiBwSiqqg2vmNABvTjVfoe65qZLKT9SNGfhA");

#[program]
pub mod vault {
    use super::*;

    /// Initialize a user vault PDA
    pub fn initialize_vault(ctx: Context<InitializeVault>) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.owner = ctx.accounts.owner.key();
        vault.bump = ctx.bumps.vault;
        vault.cbbtc_ata = ctx.accounts.cbbtc_ata.key();

        msg!("Vault initialized for owner: {}", vault.owner);
        Ok(())
    }

    /// Swap tokens in vault to cbBTC
    /// This will be called by the monitoring service when new funds are detected
    pub fn swap_to_cbbtc(
        ctx: Context<SwapToCbbtc>,
        amount_in: u64,
        _min_amount_out: u64,
        jupiter_swap_data: Vec<u8>,
    ) -> Result<()> {
        let vault = &ctx.accounts.vault;

        // Verify vault ownership (owner doesn't need to sign, just needs to match)
        require!(
            vault.owner == ctx.accounts.owner.key(),
            VaultError::Unauthorized
        );

        // If the input token is already cbBTC, do nothing
        if ctx.accounts.input_mint.key() == ctx.accounts.cbbtc_mint.key() {
            msg!("Token is already cbBTC, no swap needed");
            return Ok(());
        }

        // Calculate 0.25% fee (0.0025 = 25 basis points)
        // Fee = amount_in * 25 / 10000
        let fee_amount = amount_in
            .checked_mul(25)
            .and_then(|v| v.checked_div(10000))
            .ok_or(VaultError::SwapFailed)?;

        let swap_amount = amount_in
            .checked_sub(fee_amount)
            .ok_or(VaultError::InsufficientFunds)?;

        msg!(
            "Amount in: {}, Fee (0.25%): {}, Swap amount: {}",
            amount_in,
            fee_amount,
            swap_amount
        );

        let seeds = &[b"vault", vault.owner.as_ref(), &[vault.bump]];
        let signer_seeds = &[&seeds[..]];

        // Transfer fee to fee recipient (in input token)
        if fee_amount > 0 {
            let fee_transfer_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault_token_account.to_account_info(),
                    to: ctx.accounts.fee_token_account.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                signer_seeds,
            );
            token::transfer(fee_transfer_ctx, fee_amount)?;
            msg!(
                "Transferred {} tokens as fee to {}",
                fee_amount,
                ctx.accounts.fee_token_account.key()
            );
        }

        // Perform Jupiter swap CPI
        // Jupiter swap instruction is constructed off-chain and passed in as jupiter_swap_data
        // The remaining_accounts contain all accounts needed for the Jupiter swap
        // Note: The vault PDA must be included in remaining_accounts as a signer for the swap
        let jupiter_instruction = Instruction {
            program_id: ctx.accounts.jupiter_program.key(),
            accounts: ctx
                .remaining_accounts
                .iter()
                .map(
                    |acc| anchor_lang::solana_program::instruction::AccountMeta {
                        pubkey: *acc.key,
                        is_signer: acc.is_signer,
                        is_writable: acc.is_writable,
                    },
                )
                .collect(),
            data: jupiter_swap_data,
        };

        // Pass all accounts from remaining_accounts for Jupiter CPI
        // The vault PDA should be included in remaining_accounts as a signer
        invoke_signed(&jupiter_instruction, ctx.remaining_accounts, signer_seeds)?;

        msg!(
            "Jupiter swap completed successfully. Swapped {} tokens to cbBTC",
            swap_amount
        );

        Ok(())
    }

    /// Add SOL to vault for transaction fees (initial funding)
    pub fn fund_vault_sol(ctx: Context<FundVaultSol>, amount: u64) -> Result<()> {
        let vault = &ctx.accounts.vault;

        require!(
            vault.owner == ctx.accounts.owner.key(),
            VaultError::Unauthorized
        );

        // Transfer SOL to vault PDA for fees
        anchor_lang::solana_program::program::invoke(
            &anchor_lang::solana_program::system_instruction::transfer(
                &ctx.accounts.owner.key(),
                &ctx.accounts.vault.key(),
                amount,
            ),
            &[
                ctx.accounts.owner.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        msg!("Funded vault with {} lamports", amount);
        Ok(())
    }

    /// Cover transaction fees by transferring SOL from vault to relayer
    /// This ensures the vault pays fees, not the relayer
    pub fn cover_transaction_fees(
        ctx: Context<CoverTransactionFees>,
        fee_amount: u64,
    ) -> Result<()> {
        let vault = &ctx.accounts.vault;

        require!(
            vault.owner == ctx.accounts.owner.key(),
            VaultError::Unauthorized
        );

        // Transfer SOL from vault to relayer to cover transaction fees
        let seeds = &[b"vault", vault.owner.as_ref(), &[vault.bump]];
        let signer_seeds = &[&seeds[..]];

        anchor_lang::solana_program::program::invoke_signed(
            &anchor_lang::solana_program::system_instruction::transfer(
                &ctx.accounts.vault.key(),
                &ctx.accounts.relayer.key(),
                fee_amount,
            ),
            &[
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.relayer.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            signer_seeds,
        )?;

        msg!(
            "Transferred {} lamports from vault to relayer to cover transaction fees",
            fee_amount
        );
        Ok(())
    }

    /// Swap fee tokens to SOL and split: 60% to admin, 40% to vault
    /// This is called after swap_to_cbbtc to convert the 40% fee portion to SOL
    pub fn swap_fee_to_sol(
        ctx: Context<SwapFeeToSol>,
        amount_in: u64,
        _min_amount_out: u64,
        jupiter_swap_data: Vec<u8>,
    ) -> Result<()> {
        let vault = &ctx.accounts.vault;

        require!(
            vault.owner == ctx.accounts.owner.key(),
            VaultError::Unauthorized
        );

        let seeds = &[b"vault", vault.owner.as_ref(), &[vault.bump]];
        let signer_seeds = &[&seeds[..]];

        // Perform Jupiter swap CPI to convert fee tokens to SOL
        let jupiter_instruction = Instruction {
            program_id: ctx.accounts.jupiter_program.key(),
            accounts: ctx
                .remaining_accounts
                .iter()
                .map(
                    |acc| anchor_lang::solana_program::instruction::AccountMeta {
                        pubkey: *acc.key,
                        is_signer: acc.is_signer,
                        is_writable: acc.is_writable,
                    },
                )
                .collect(),
            data: jupiter_swap_data,
        };

        // Get vault SOL balance before swap to calculate how much SOL was received
        let vault_sol_before = ctx.accounts.vault.to_account_info().lamports();

        // The vault PDA signs for the swap
        // Jupiter swap converts fee tokens to SOL, which goes to the vault PDA
        invoke_signed(&jupiter_instruction, ctx.remaining_accounts, signer_seeds)?;

        // Get vault SOL balance after swap
        let vault_sol_after = ctx.accounts.vault.to_account_info().lamports();

        // Calculate how much SOL was received from the swap
        let sol_received = vault_sol_after
            .checked_sub(vault_sol_before)
            .ok_or(VaultError::SwapFailed)?;

        // Split: 60% to admin, 40% stays in vault
        let sol_to_admin = sol_received
            .checked_mul(6)
            .and_then(|v| v.checked_div(10))
            .ok_or(VaultError::SwapFailed)?;

        // Transfer 60% to admin
        if sol_to_admin > 0 {
            **ctx
                .accounts
                .vault
                .to_account_info()
                .try_borrow_mut_lamports()? -= sol_to_admin;
            **ctx
                .accounts
                .admin_sol_account
                .to_account_info()
                .try_borrow_mut_lamports()? += sol_to_admin;
            msg!(
                "Transferred {} lamports (60% of {} received SOL) to admin {}",
                sol_to_admin,
                sol_received,
                ctx.accounts.admin_sol_account.key()
            );
        }

        // 40% remains in vault for future transaction fees
        let sol_to_vault = sol_received
            .checked_sub(sol_to_admin)
            .ok_or(VaultError::SwapFailed)?;
        msg!(
            "{} lamports (40% of {} received SOL) remains in vault for future transaction fees",
            sol_to_vault,
            sol_received
        );

        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        init,
        payer = owner,
        space = 8 + Vault::LEN,
        seeds = [b"vault", owner.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,

    /// CHECK: cbBTC mint address (will be validated off-chain)
    pub cbbtc_mint: AccountInfo<'info>,

    /// CHECK: Associated token account for cbBTC
    #[account(
        init_if_needed,
        payer = owner,
        associated_token::mint = cbbtc_mint,
        associated_token::authority = vault
    )]
    pub cbbtc_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SwapToCbbtc<'info> {
    #[account(
        seeds = [b"vault", owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner @ VaultError::Unauthorized
    )]
    pub vault: Account<'info, Vault>,

    /// CHECK: Owner account (not required to sign - validated via vault.owner)
    /// Anyone can call this instruction; the program validates ownership via vault account
    pub owner: AccountInfo<'info>,

    /// CHECK: Input token mint
    pub input_mint: Account<'info, Mint>,

    /// CHECK: cbBTC mint
    pub cbbtc_mint: Account<'info, Mint>,

    #[account(mut)]
    /// CHECK: Vault's token account for input token
    pub vault_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    /// CHECK: Fee recipient token account (for input token)
    /// Fee recipient: GongV8jcP3FEP4FejLaXbwuUVewtRLCVY2Uiw8bHVeGC
    pub fee_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    /// CHECK: Vault's cbBTC token account
    pub cbbtc_ata: Account<'info, TokenAccount>,

    /// CHECK: Jupiter program ID
    /// Jupiter V6: JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4
    pub jupiter_program: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    // CHECK: Remaining accounts for Jupiter swap (route, AMMs, etc.)
    // These are passed dynamically based on the swap route
    // Accounts are: [vault (signer), user_token_account, output_token_account, ...jupiter_accounts]
    // remaining_accounts: Vec<AccountInfo<'info>>,
}

#[derive(Accounts)]
pub struct FundVaultSol<'info> {
    #[account(
        seeds = [b"vault", owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner @ VaultError::Unauthorized
    )]
    pub vault: Account<'info, Vault>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CoverTransactionFees<'info> {
    #[account(
        seeds = [b"vault", owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner @ VaultError::Unauthorized
    )]
    #[account(mut)]
    pub vault: Account<'info, Vault>,

    /// CHECK: Owner account (not required to sign - validated via vault.owner)
    pub owner: AccountInfo<'info>,

    /// CHECK: Relayer account that will receive SOL to cover fees
    #[account(mut)]
    pub relayer: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SwapFeeToSol<'info> {
    #[account(
        seeds = [b"vault", owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner @ VaultError::Unauthorized
    )]
    #[account(mut)]
    pub vault: Account<'info, Vault>,

    /// CHECK: Owner account (not required to sign - validated via vault.owner)
    pub owner: AccountInfo<'info>,

    /// CHECK: Input token mint (the fee token)
    pub input_mint: Account<'info, Mint>,

    #[account(mut)]
    /// CHECK: Vault's token account for the input fee token
    pub vault_fee_token_account: Account<'info, TokenAccount>,

    /// CHECK: Admin SOL account (60% of fee SOL goes here)
    /// Admin: GongV8jcP3FEP4FejLaXbwuUVewtRLCVY2Uiw8bHVeGC
    #[account(mut)]
    pub admin_sol_account: AccountInfo<'info>,

    /// CHECK: Jupiter program ID
    pub jupiter_program: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    // CHECK: Remaining accounts for Jupiter swap
}

#[account]
pub struct Vault {
    pub owner: Pubkey,
    pub bump: u8,
    pub cbbtc_ata: Pubkey,
}

impl Vault {
    pub const LEN: usize = 32 + 1 + 32; // owner + bump + cbbtc_ata
}

#[error_code]
pub enum VaultError {
    #[msg("Unauthorized: You are not the owner of this vault")]
    Unauthorized,
    #[msg("Insufficient funds in vault")]
    InsufficientFunds,
    #[msg("Swap failed")]
    SwapFailed,
}
