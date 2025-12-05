# Architecture Overview

## System Components

### 1. Anchor Program (`programs/vault/src/lib.rs`)

The Solana program that manages user vaults and handles swaps.

**Key Instructions:**
- `initialize_vault`: Creates a PDA vault for each user
- `swap_to_cbbtc`: Swaps tokens in vault to cbBTC (called by monitoring service)
- `fund_vault_sol`: Adds SOL to vault for transaction fees

**Vault PDA Structure:**
- Seeds: `["vault", user_pubkey]`
- Stores: owner, bump, cbBTC ATA address

### 2. Next.js Frontend (`app/page.tsx`)

User-facing interface for:
- Wallet connection
- Vault initialization
- Displaying vault address for deposits

### 3. Monitoring Service (`app/api/monitor/route.ts`)

Server-side endpoint that:
- Polls vault addresses for new transactions
- Detects incoming SOL/SPL token transfers
- Triggers automatic swaps to cbBTC

**How it works:**
1. Receives `vaultOwner` and optional `lastCheckedSlot`
2. Gets recent transactions for the vault PDA
3. Analyzes token balances to detect new deposits
4. Calls swap function for non-cbBTC tokens

### 4. Swap Integration (`lib/swap.ts`)

Handles Jupiter swap integration:
- Gets quotes from Jupiter API
- Constructs swap transactions
- Executes swaps via Anchor program

## Transaction Fee Strategy

### Option 1: Store SOL in Vault (Recommended)
- Keep a small amount of SOL (e.g., 0.1-0.5 SOL) in the vault PDA
- Vault can sign transactions using PDA seeds
- User funds vault via `fund_vault_sol` instruction
- Pros: Simple, user-controlled
- Cons: Requires maintaining SOL balance

### Option 2: Paymaster Service
- Use a service account to pay transaction fees
- Service account signs swap transactions
- Can charge users or operate at a loss for UX
- Pros: Better UX, no SOL needed in vault
- Cons: Requires service account management, potential cost

### Option 3: User Pays
- User maintains SOL in their wallet
- User signs swap transactions
- Pros: No vault SOL needed
- Cons: Requires user to always have SOL, less automated

**Recommendation:** Use Option 1 (store SOL in vault) for simplicity, with Option 2 as a fallback for users who don't want to manage SOL.

## Jupiter Integration

### Current Implementation

The swap flow uses Jupiter's API:
1. Get quote from `/v6/quote`
2. Get swap transaction from `/v6/swap`
3. Execute via Anchor program

### On-Chain CPI Approach

For true on-chain swaps, you have two options:

**Option A: Jupiter Aggregator Program**
- Jupiter has an on-chain aggregator program
- Can be called via CPI from your Anchor program
- Requires constructing swap instruction with proper accounts

**Option B: Direct DEX Integration**
- Integrate directly with Raydium, Orca, etc.
- More complex but more control
- Not recommended unless you need specific features

### Recommended Approach

1. **For now:** Use Jupiter API to get swap instructions, then execute via your Anchor program
2. **Future:** Integrate Jupiter's on-chain aggregator program for true CPI

The current `swap_to_cbbtc` instruction is a placeholder. You'll need to:
- Add Jupiter program ID and accounts
- Construct swap instruction from Jupiter API response
- Execute via CPI with vault PDA as signer

## Monitoring Strategy

### Polling Approach (Current)

The `/api/monitor` endpoint should be called periodically:
- Via cron job (Vercel Cron, GitHub Actions, etc.)
- Every 30-60 seconds for active vaults
- Less frequently for inactive vaults

### Webhook Approach (Future)

For better real-time processing:
- Use Helius webhooks or similar service
- Receive notifications when vault receives funds
- Immediately trigger swap

### Implementation Example

```typescript
// Vercel Cron Job (vercel.json)
{
  "crons": [{
    "path": "/api/monitor",
    "schedule": "*/30 * * * * *"
  }]
}

// Or use a service like GitHub Actions
```

## Security Considerations

1. **Vault Ownership**: Always verify vault owner in program instructions
2. **Swap Validation**: Validate swap amounts and slippage
3. **Rate Limiting**: Prevent spam on monitoring endpoint
4. **Error Handling**: Gracefully handle failed swaps
5. **Reentrancy**: Ensure swap instructions can't be exploited

## Next Steps

1. **Complete Jupiter CPI Integration**
   - Research Jupiter's on-chain program interface
   - Implement swap instruction construction
   - Test on devnet

2. **Set Up Monitoring**
   - Configure cron job or webhook service
   - Test with devnet transactions
   - Add error handling and logging

3. **Fee Management**
   - Implement `fund_vault_sol` UI
   - Add minimum SOL balance checks
   - Consider paymaster as alternative

4. **Testing**
   - Test vault creation
   - Test token deposits
   - Test automatic swaps
   - Test edge cases (already cbBTC, insufficient funds, etc.)

5. **Production Deployment**
   - Deploy Anchor program to mainnet
   - Update cbBTC mint address
   - Set up monitoring infrastructure
   - Add analytics and monitoring

## Questions to Resolve

1. **Jupiter On-Chain Program**: Does Jupiter expose a CPI-able program, or do we need to construct transactions off-chain?
2. **cbBTC Mint**: What is the actual cbBTC mint address on Solana?
3. **Slippage Tolerance**: What slippage should we use for swaps?
4. **Minimum Swap Amount**: Should we enforce minimum amounts to avoid dust?

