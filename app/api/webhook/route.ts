import { NextRequest, NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import { getAccount } from "@solana/spl-token";
import { getVaultAddress } from "@/lib/vault";

// Webhook endpoint for Helius, QuickNode, or other webhook services
// Configure webhook to POST to this endpoint when vault address receives funds
// Helius transaction types: TRANSFER (for both SOL and SPL tokens), SWAP, etc.

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();

        // Helius Enhanced Transactions webhook format
        // Transaction type will be "TRANSFER" for both SOL and SPL token transfers
        if (body.type === "TRANSFER" || body.type === "SWAP") {
            // Helius sends transaction data directly
            const transactions = Array.isArray(body) ? body : [body];

            for (const tx of transactions) {
                if (tx.type === "TRANSFER" || tx.type === "SWAP") {
                    // Process the transaction
                    await processHeliusTransaction(tx);
                }
            }

            return NextResponse.json({ message: "Processed Helius transaction webhook" });
        }

        // Helius account webhook format (for account changes)
        if (body.type === "ACCOUNT") {
            const accountData = body.accountData?.[0];
            if (!accountData) {
                return NextResponse.json({ message: "No account data" }, { status: 200 });
            }

            const account = accountData.account;
            const vaultAddress = new PublicKey(account);

            // Verify this is a vault address (optional security check)
            // You might want to maintain a list of active vault addresses

            // Process account changes
            const connection = new Connection(
                process.env.NEXT_PUBLIC_SOLANA_RPC_URL!,
                "confirmed"
            );

            // Get recent transactions for this account
            const signatures = await connection.getSignaturesForAddress(
                vaultAddress,
                { limit: 5 }
            );

            for (const sig of signatures) {
                const tx = await connection.getTransaction(sig.signature, {
                    maxSupportedTransactionVersion: 0,
                });

                if (!tx) continue;

                // Process token transfers
                await processTransaction(connection, vaultAddress, tx);
            }

            return NextResponse.json({ message: "Processed webhook" });
        }

        // QuickNode webhook format (adjust based on their format)
        if (body.webhookId) {
            const account = body.account;
            if (!account) {
                return NextResponse.json({ message: "No account in webhook" }, { status: 200 });
            }

            const vaultAddress = new PublicKey(account);
            const connection = new Connection(
                process.env.NEXT_PUBLIC_SOLANA_RPC_URL!,
                "confirmed"
            );

            const signatures = await connection.getSignaturesForAddress(
                vaultAddress,
                { limit: 5 }
            );

            for (const sig of signatures) {
                const tx = await connection.getTransaction(sig.signature, {
                    maxSupportedTransactionVersion: 0,
                });

                if (!tx) continue;
                await processTransaction(connection, vaultAddress, tx);
            }

            return NextResponse.json({ message: "Processed webhook" });
        }

        // Generic transaction webhook
        if (body.transaction) {
            const signature = body.transaction.signature;
            const connection = new Connection(
                process.env.NEXT_PUBLIC_SOLANA_RPC_URL!,
                "confirmed"
            );

            const tx = await connection.getTransaction(signature, {
                maxSupportedTransactionVersion: 0,
            });

            if (tx) {
                // Find vault addresses in transaction
                const accountKeys = tx.transaction.message.getAccountKeys();
                for (const key of accountKeys.staticAccountKeys) {
                    // Check if this is a vault address (you'd need to verify this)
                    // For now, process all accounts in transaction
                    await processTransaction(connection, key, tx);
                }
            }

            return NextResponse.json({ message: "Processed transaction webhook" });
        }

        return NextResponse.json({ message: "Unknown webhook format" }, { status: 400 });
    } catch (error: any) {
        console.error("Webhook error:", error);
        return NextResponse.json(
            { error: error.message || "Internal server error" },
            { status: 500 }
        );
    }
}

/**
 * Process Helius Enhanced Transaction webhook
 * Transaction type will be "TRANSFER" for both SOL and SPL token transfers
 */
async function processHeliusTransaction(tx: any) {
    const connection = new Connection(
        process.env.NEXT_PUBLIC_SOLANA_RPC_URL!,
        "confirmed"
    );

    // Helius provides parsed transaction data
    const signature = tx.signature;
    const transfers = tx.tokenTransfers || [];
    const nativeTransfers = tx.nativeTransfers || [];

    // Check if any transfers are to a vault address
    for (const transfer of transfers) {
        // SPL token transfer
        const toAddress = transfer.toTokenAccount;
        if (await isVaultAddress(toAddress)) {
            const vaultOwner = await getVaultOwnerFromAddress(toAddress);
            if (vaultOwner) {
                const mint = transfer.mint;
                const amount = BigInt(transfer.tokenAmount);

                // Check if it's not cbBTC
                const cbbtcMint = new PublicKey(
                    process.env.NEXT_PUBLIC_CBBTC_MINT!
                );

                if (mint !== cbbtcMint.toBase58() && amount > BigInt(0)) {
                    console.log(`SPL token transfer detected: ${amount} of ${mint} to vault`);
                    try {
                        // Build and submit the swap transaction
                        // The vault pays fees via cover_transaction_fees instruction
                        const { buildSwapTransaction, submitSwapWithVaultFees, buildSwapFeeToSolTransaction } = await import("@/lib/swap");

                        const swapTransaction = await buildSwapTransaction(
                            connection,
                            vaultOwner,
                            new PublicKey(mint),
                            amount
                        );

                        // Submit swap transaction via relayer (vault pays fees)
                        const swapTxSignature = await submitSwapWithVaultFees(
                            connection,
                            swapTransaction,
                            getVaultAddress(vaultOwner)
                        );
                        console.log(`Swap transaction submitted: ${swapTxSignature}`);

                        // Calculate 40% fee amount (the portion that stays in vault for SOL conversion)
                        // Total fee is 1% of amount_in, 40% of that is fee_to_vault
                        const totalFee = (amount * BigInt(100)) / BigInt(10000); // 1% fee
                        const feeToVault = (totalFee * BigInt(4)) / BigInt(10); // 40% of fee

                        // After swap completes, swap the 40% fee portion to SOL
                        if (feeToVault > BigInt(0)) {
                            const feeToSolTransaction = await buildSwapFeeToSolTransaction(
                                connection,
                                vaultOwner,
                                new PublicKey(mint),
                                feeToVault
                            );

                            // Submit fee-to-SOL swap transaction
                            const feeToSolTxSignature = await submitSwapWithVaultFees(
                                connection,
                                feeToSolTransaction,
                                getVaultAddress(vaultOwner)
                            );
                            console.log(`Fee-to-SOL swap transaction submitted: ${feeToSolTxSignature}`);
                            console.log(`40% fee (${feeToVault} tokens) swapped to SOL, split: 60% to admin, 40% to vault`);
                        }
                    } catch (error: any) {
                        console.error("Swap failed:", error);
                        // Don't throw - log and continue processing other transactions
                    }
                }
            }
        }
    }

    // Check native SOL transfers
    for (const transfer of nativeTransfers) {
        const toAddress = transfer.toUserAccount;
        if (await isVaultAddress(toAddress)) {
            const amount = transfer.amount;
            console.log(`SOL transfer detected: ${amount} lamports to vault`);
            // TODO: Wrap SOL to wSOL and swap
        }
    }
}

async function isVaultAddress(address: string): Promise<boolean> {
    // Check if address is a vault PDA
    // In production, maintain a database/mapping of vault addresses
    // For now, you could derive and check if it matches vault PDA pattern
    try {
        const pubkey = new PublicKey(address);
        // You'd check against your known vault addresses or derive from pattern
        return true; // Placeholder - implement proper check
    } catch {
        return false;
    }
}

async function getVaultOwnerFromAddress(vaultAddress: string): Promise<PublicKey | null> {
    // In production, query the vault account to get the owner
    // For now, this is a placeholder
    const connection = new Connection(
        process.env.NEXT_PUBLIC_SOLANA_RPC_URL!,
        "confirmed"
    );

    try {
        // You'd deserialize the vault account data to get the owner
        // This requires your program's IDL/types
        return null; // Placeholder
    } catch {
        return null;
    }
}

async function processTransaction(
    connection: Connection,
    vaultAddress: PublicKey,
    tx: any
) {
    const cbbtcMint = new PublicKey(
        process.env.NEXT_PUBLIC_CBBTC_MINT!
    );

    // Check token transfers
    const postTokenBalances = tx.meta?.postTokenBalances || [];

    for (const postBalance of postTokenBalances) {
        if (postBalance.owner === vaultAddress.toBase58()) {
            try {
                const tokenAccount = new PublicKey(postBalance.accountIndex);
                const accountInfo = await getAccount(connection, tokenAccount);

                if (accountInfo.mint.toString() !== cbbtcMint.toString()) {
                    // Derive owner from vault address (reverse lookup)
                    // This is a simplified approach - in production you'd maintain a mapping
                    console.log(`Token ${accountInfo.mint.toString()} received in vault ${vaultAddress.toBase58()}`);

                    // TODO: Get vault owner from vault account data
                    // For now, we'd need to query the vault account to get the owner
                    // Then call swapTokensInVault
                }
            } catch (error) {
                console.error("Error processing token balance:", error);
            }
        }
    }
}

