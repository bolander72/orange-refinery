# Comrade Orange - Bitcoin Savings Vault

A Solana-based Bitcoin savings account that automatically converts any SOL or SPL tokens sent to your vault into cbBTC.

## Architecture

### Components

1. **Anchor Program** (`programs/vault/`)
   - Creates PDA-based vaults for each user
   - Handles token swaps via CPI to Jupiter
   - Manages vault state and ownership

2. **Next.js Frontend** (`app/`)
   - Wallet connection
   - Vault initialization UI
   - Displays vault address for deposits

3. **Webhook Endpoint** (`app/api/webhook/`)
   - Receives Helius webhook notifications for vault transactions
   - Detects incoming SOL/SPL token transfers
   - Triggers automatic swaps to cbBTC

## Setup

### Prerequisites

- Node.js 18+
- Rust and Cargo
- Solana CLI tools
- Anchor framework

### Installation

1. Install dependencies:
```bash
npm install
```

2. Install Anchor (if not already installed):
```bash
cargo install --git https://github.com/coral-xyz/anchor avm --locked --force
avm install latest
avm use latest
```

3. Build the Anchor program:
```bash
anchor build
```

4. Deploy the program (update program ID in `Anchor.toml` and `lib/vault.ts`):
```bash
anchor deploy
```

5. Copy environment variables:
```bash
cp .env.example .env
```

6. Update `.env` with:
   - Your Solana RPC URL
   - cbBTC mint address
   - Service account private key (for signing swap transactions)

### Running

1. Start the development server:
```bash
npm run dev
```

2. Set up Helius webhook:
   - Create a webhook in Helius dashboard pointing to `https://your-domain.com/api/webhook`
   - Configure to watch for `TRANSFER` transactions to vault addresses
   - Add vault addresses to webhook as users create vaults

## How It Works

1. **User Setup**: User connects wallet and clicks "Setup Bitcoin Savings Account"
   - Creates a PDA vault with seeds: `["vault", user_pubkey]`
   - Creates associated token account for cbBTC

2. **Deposits**: User sends SOL or any SPL token to their vault address
   - Tokens are received directly at the vault PDA address

3. **Monitoring**: Helius webhook detects incoming transfers
   - Helius sends webhook notification when vault receives funds
   - Webhook endpoint identifies token type and amount

4. **Automatic Swap**: When non-cbBTC tokens are detected:
   - Calls Jupiter API to get swap quote
   - Executes swap via Anchor program CPI
   - Stores cbBTC in vault's cbBTC token account

## Transaction Fees

The vault needs SOL to pay for swap transaction fees. Options:

1. **Store SOL in Vault**: Keep a small amount of SOL in the vault PDA for fees
2. **Paymaster**: Use a service account to pay fees on behalf of users
3. **User Pays**: Have users maintain SOL balance in their wallet

The `fund_vault_sol` instruction allows adding SOL to the vault for fees.

## Jupiter Integration

Jupiter swaps can be done in two ways:

1. **Off-chain + On-chain**: 
   - Get swap instructions from Jupiter API
   - Execute via Anchor program CPI

2. **Direct CPI** (if Jupiter exposes on-chain program):
   - Call Jupiter's swap program directly from Anchor program

Currently, the implementation uses Jupiter's API to get swap instructions. The full CPI integration needs to be completed based on Jupiter's on-chain program interface.

## Development Status

- ✅ Anchor program structure
- ✅ Vault creation
- ✅ Frontend wallet connection
- ✅ Helius webhook endpoint
- ⚠️ Jupiter CPI integration (needs completion)
- ⚠️ Paymaster/service account setup
- ⚠️ Error handling and edge cases

## Notes

- Update `CBBTC_MINT` with the actual cbBTC mint address on Solana
- Set up Helius webhook to monitor vault addresses for incoming transfers
- Consider rate limiting and error handling for production
- Test thoroughly on devnet before mainnet deployment
