import {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import {
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
  getAccount,
} from "@solana/spl-token";
import { getVaultAddress, getVaultCbbtcAta } from "./vault";

const PROGRAM_ID = new PublicKey("8FaCEp8fDiBwSiqqg2vmNABvTjVfoe65qZLKT9SNGfhA");
const JUPITER_PROGRAM_ID = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const FEE_RECIPIENT = new PublicKey("GongV8jcP3FEP4FejLaXbwuUVewtRLCVY2Uiw8bHVeGC");

// Jupiter API endpoints
const JUPITER_QUOTE_API = "https://quote-api.jup.ag/v6/quote";
const JUPITER_SWAP_API = "https://quote-api.jup.ag/v6/swap";

/**
 * Swap tokens in vault to cbBTC using Jupiter aggregator
 * This function:
 * 1. Gets a quote from Jupiter API
 * 2. Gets the swap instruction from Jupiter API
 * 3. Constructs the Anchor program's swap_to_cbbtc instruction with Jupiter swap data
 * 4. Returns the transaction that can be submitted via Jito bundle or paymaster
 * 
 * The program itself signs for the swap using the vault PDA via invoke_signed.
 * Transaction fees can be paid by:
 * - Jito bundle (no signer needed)
 * - Paymaster service
 * - Vault's SOL balance (if funded via fund_vault_sol)
 */
export async function buildSwapTransaction(
  connection: Connection,
  vaultOwner: PublicKey,
  inputMint: PublicKey,
  amount: bigint
): Promise<Transaction> {
  const cbbtcMint = new PublicKey(process.env.NEXT_PUBLIC_CBBTC_MINT!);
  const vault = getVaultAddress(vaultOwner);

  // Get vault's token account for input token
  const vaultTokenAccount = await getAssociatedTokenAddress(inputMint, vault, true);

  // Get fee recipient's token account for input token
  const feeTokenAccount = await getAssociatedTokenAddress(inputMint, FEE_RECIPIENT, true);

  // Get vault's cbBTC ATA
  const cbbtcAta = await getVaultCbbtcAta(vault);

  // Check vault has enough tokens
  try {
    const vaultTokenAccountInfo = await getAccount(connection, vaultTokenAccount);
    if (vaultTokenAccountInfo.amount < amount) {
      throw new Error(`Insufficient balance. Vault has ${vaultTokenAccountInfo.amount}, need ${amount}`);
    }
  } catch (error: any) {
    if (error.message?.includes("could not find account")) {
      throw new Error("Vault token account does not exist");
    }
    throw error;
  }

  // Check vault has sufficient SOL for transaction fees
  const vaultBalance = await connection.getBalance(vault);
  const minRequiredBalance = 100000; // 0.0001 SOL minimum
  if (vaultBalance < minRequiredBalance) {
    throw new Error(
      `Vault has insufficient SOL balance: ${vaultBalance} lamports. ` +
      `Minimum required: ${minRequiredBalance} lamports (0.0001 SOL). ` +
      `Fund the vault using the fund_vault_sol instruction first.`
    );
  }

  // Step 1: Get quote from Jupiter API
  const quoteResponse = await fetch(
    `${JUPITER_QUOTE_API}?inputMint=${inputMint.toString()}&outputMint=${cbbtcMint.toString()}&amount=${amount.toString()}&slippageBps=50`
  );

  if (!quoteResponse.ok) {
    const errorText = await quoteResponse.text();
    throw new Error(`Failed to get quote from Jupiter: ${errorText}`);
  }

  const quote = await quoteResponse.json();
  const minAmountOut = BigInt(quote.outAmount || "0");

  // Step 2: Get swap instruction from Jupiter API
  // We need to get the swap instruction for the vault PDA as the user
  const swapResponse = await fetch(JUPITER_SWAP_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: vault.toString(), // Use vault PDA as the user
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "auto",
      asLegacyTransaction: false, // Get versioned transaction
    }),
  });

  if (!swapResponse.ok) {
    const errorText = await swapResponse.text();
    throw new Error(`Failed to get swap transaction from Jupiter: ${errorText}`);
  }

  const swapData = await swapResponse.json();

  // Step 3: Extract Jupiter swap instruction data and accounts
  // Deserialize the swap transaction to get the instruction
  const swapTransactionBuf = Buffer.from(swapData.swapTransaction, "base64");
  const swapTransaction = Transaction.from(swapTransactionBuf);

  // Find the Jupiter swap instruction in the transaction
  // Jupiter swap is typically the first instruction
  const jupiterInstruction = swapTransaction.instructions.find(
    (ix) => ix.programId.equals(JUPITER_PROGRAM_ID)
  );

  if (!jupiterInstruction) {
    throw new Error("Jupiter swap instruction not found in transaction");
  }

  // Get Jupiter instruction data
  const jupiterSwapData = jupiterInstruction.data;

  // Step 4: Build accounts array for swap_to_cbbtc
  // The program will sign with the vault PDA via invoke_signed

  // Step 5: Build accounts array for swap_to_cbbtc
  // The remaining_accounts will include all Jupiter swap accounts
  // The vault PDA will be signed by the program via invoke_signed
  const jupiterAccounts = jupiterInstruction.keys.map((key) => ({
    pubkey: key.pubkey,
    isSigner: key.isSigner,
    isWritable: key.isWritable,
  }));

  // Ensure vault PDA is in the accounts (will be signed by program)
  const vaultAccountMeta = jupiterAccounts.find((acc) => acc.pubkey.equals(vault));
  if (!vaultAccountMeta) {
    // Add vault as first account if not present
    // Mark as signer - the program will sign it via invoke_signed
    jupiterAccounts.unshift({
      pubkey: vault,
      isSigner: true,
      isWritable: true,
    });
  } else {
    // Ensure it's marked as signer
    vaultAccountMeta.isSigner = true;
  }

  // Step 6: Manually construct the swap_to_cbbtc instruction
  // Since the IDL may not have jupiter_swap_data parameter yet,
  // we'll construct the instruction data manually
  // Anchor instruction format: [discriminator (8 bytes), ...args]
  const discriminator = Buffer.from([73, 17, 223, 215, 78, 128, 160, 80]); // From IDL

  // Serialize args: amount_in (u64), _min_amount_out (u64), jupiter_swap_data (Vec<u8>)
  const amountInBN = new BN(amount.toString());
  const minAmountOutBN = new BN(minAmountOut.toString());

  // Anchor serialization for Vec<u8>: length (u32) + bytes
  const jupiterDataLength = Buffer.allocUnsafe(4);
  jupiterDataLength.writeUInt32LE(jupiterSwapData.length, 0);

  const argsBuffer = Buffer.concat([
    amountInBN.toArrayLike(Buffer, "le", 8),
    minAmountOutBN.toArrayLike(Buffer, "le", 8),
    jupiterDataLength,
    Buffer.from(jupiterSwapData),
  ]);

  const instructionData = Buffer.concat([discriminator, argsBuffer]);

  // Build the instruction
  // Owner is not required to sign - the program validates ownership via vault account
  const swapInstruction = {
    programId: PROGRAM_ID,
    keys: [
      { pubkey: vault, isSigner: false, isWritable: false }, // vault (PDA)
      { pubkey: vaultOwner, isSigner: false, isWritable: false }, // owner (not signing, validated via vault)
      { pubkey: inputMint, isSigner: false, isWritable: false }, // input_mint
      { pubkey: cbbtcMint, isSigner: false, isWritable: false }, // cbbtc_mint
      { pubkey: vaultTokenAccount, isSigner: false, isWritable: true }, // vault_token_account
      { pubkey: feeTokenAccount, isSigner: false, isWritable: true }, // fee_token_account
      { pubkey: cbbtcAta, isSigner: false, isWritable: true }, // cbbtc_ata
      { pubkey: JUPITER_PROGRAM_ID, isSigner: false, isWritable: false }, // jupiter_program
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // token_program
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
      ...jupiterAccounts, // remaining_accounts for Jupiter swap
    ],
    data: instructionData,
  };

  // Build transaction with swap instruction first (without cover_transaction_fees)
  // We'll estimate the fee, then add the cover_transaction_fees instruction
  const { getRelayer } = await import("./relayer");
  const relayer = getRelayer(connection);
  const relayerPubkey = relayer.getPublicKey();

  // Build transaction with just the swap instruction to estimate fees
  const tempTransaction = new Transaction();
  tempTransaction.add(swapInstruction);

  // Get recent blockhash
  const { blockhash } = await connection.getLatestBlockhash();
  tempTransaction.recentBlockhash = blockhash;
  tempTransaction.feePayer = relayerPubkey;

  // Estimate transaction fee for the swap instruction
  const message = tempTransaction.compileMessage();
  const feeEstimate = await connection.getFeeForMessage(message);
  const baseFee = feeEstimate?.value || 50000; // Fallback to 50k lamports

  // Add buffer for the cover_transaction_fees instruction itself (~5k-10k lamports)
  // This accounts for the compute units consumed by the cover_transaction_fees instruction
  const coverFeeInstructionCost = 10000; // Buffer for cover_transaction_fees instruction
  const estimatedFee = baseFee + coverFeeInstructionCost;

  // Build cover_transaction_fees instruction with the estimated fee
  // Discriminator: [64, 23, 219, 120, 75, 63, 68, 190]
  const coverFeeDiscriminator = Buffer.from([64, 23, 219, 120, 75, 63, 68, 190]);
  const feeAmountBN = new BN(estimatedFee.toString());
  const coverFeeArgs = feeAmountBN.toArrayLike(Buffer, "le", 8);
  const coverFeeData = Buffer.concat([coverFeeDiscriminator, coverFeeArgs]);

  const coverFeeInstruction = {
    programId: PROGRAM_ID,
    keys: [
      { pubkey: vault, isSigner: false, isWritable: true }, // vault (PDA, mut)
      { pubkey: vaultOwner, isSigner: false, isWritable: false }, // owner
      { pubkey: relayerPubkey, isSigner: false, isWritable: true }, // relayer (mut)
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
    ],
    data: coverFeeData,
  };

  // Build final transaction with cover fee instruction first, then swap instruction
  const transaction = new Transaction();
  transaction.add(coverFeeInstruction);
  transaction.add(swapInstruction);
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = relayerPubkey;

  return transaction;
}

/**
 * Submit swap transaction via relayer
 * The vault pays all fees via cover_transaction_fees instruction
 */
export async function submitSwapWithVaultFees(
  connection: Connection,
  transaction: Transaction,
  vault: PublicKey
): Promise<string> {
  // Check vault has sufficient SOL for fees
  const vaultBalance = await connection.getBalance(vault);
  const minRequiredBalance = 100000; // 0.0001 SOL minimum for transaction fees

  if (vaultBalance < minRequiredBalance) {
    throw new Error(
      `Vault has insufficient SOL balance: ${vaultBalance} lamports. ` +
      `Minimum required: ${minRequiredBalance} lamports (0.0001 SOL). ` +
      `Fund the vault using the fund_vault_sol instruction first.`
    );
  }

  // Submit via relayer
  const { submitViaRelayer } = await import("./relayer");
  return await submitViaRelayer(connection, transaction);
}

/**
 * Build transaction to swap fee tokens to SOL
 * This swaps the 40% fee portion to SOL, then splits: 60% to admin, 40% to vault
 */
export async function buildSwapFeeToSolTransaction(
  connection: Connection,
  vaultOwner: PublicKey,
  feeTokenMint: PublicKey,
  feeAmount: bigint
): Promise<Transaction> {
  const vault = getVaultAddress(vaultOwner);
  const WNATIVE_MINT = new PublicKey("So11111111111111111111111111111111111112"); // Wrapped SOL

  // Get vault's token account for the fee token
  const vaultFeeTokenAccount = await getAssociatedTokenAddress(feeTokenMint, vault, true);

  // Admin SOL account (60% goes here)
  const adminSolAccount = FEE_RECIPIENT;

  // Step 1: Get quote from Jupiter API for fee token to SOL
  const quoteResponse = await fetch(
    `${JUPITER_QUOTE_API}?inputMint=${feeTokenMint.toString()}&outputMint=${WNATIVE_MINT.toString()}&amount=${feeAmount.toString()}&slippageBps=50`
  );

  if (!quoteResponse.ok) {
    const errorText = await quoteResponse.text();
    throw new Error(`Failed to get quote for fee-to-SOL swap from Jupiter: ${errorText}`);
  }

  const quote = await quoteResponse.json();
  const minAmountOut = BigInt(quote.outAmount || "0");

  // Step 2: Get swap instruction from Jupiter API
  const swapResponse = await fetch(JUPITER_SWAP_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: vault.toString(), // Vault PDA is the user
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "auto",
      asLegacyTransaction: false,
    }),
  });

  if (!swapResponse.ok) {
    const errorText = await swapResponse.text();
    throw new Error(`Failed to get fee-to-SOL swap transaction from Jupiter: ${errorText}`);
  }

  const swapData = await swapResponse.json();

  // Step 3: Extract Jupiter swap instruction data and accounts
  const swapTransactionBuf = Buffer.from(swapData.swapTransaction, "base64");
  const swapTransaction = Transaction.from(swapTransactionBuf);

  const jupiterInstruction = swapTransaction.instructions.find(
    (ix) => ix.programId.equals(JUPITER_PROGRAM_ID)
  );

  if (!jupiterInstruction) {
    throw new Error("Jupiter swap instruction not found for fee-to-SOL swap");
  }

  const jupiterSwapData = jupiterInstruction.data;
  const jupiterAccounts = jupiterInstruction.keys.map((key) => ({
    pubkey: key.pubkey,
    isSigner: key.isSigner,
    isWritable: key.isWritable,
  }));

  // Ensure vault PDA is in the accounts and marked as signer
  const vaultAccountMeta = jupiterAccounts.find((acc) => acc.pubkey.equals(vault));
  if (vaultAccountMeta) {
    vaultAccountMeta.isSigner = true;
  } else {
    jupiterAccounts.unshift({
      pubkey: vault,
      isSigner: true,
      isWritable: true,
    });
  }

  // Step 4: Build swap_fee_to_sol instruction
  // Discriminator: [98, 85, 227, 2, 32, 184, 191, 80]
  const swapFeeToSolDiscriminator = Buffer.from([98, 85, 227, 2, 32, 184, 191, 80]);
  const amountInBN = new BN(feeAmount.toString());
  const minAmountOutBN = new BN(minAmountOut.toString());

  const jupiterDataLength = Buffer.allocUnsafe(4);
  jupiterDataLength.writeUInt32LE(jupiterSwapData.length, 0);

  const argsBuffer = Buffer.concat([
    amountInBN.toArrayLike(Buffer, "le", 8),
    minAmountOutBN.toArrayLike(Buffer, "le", 8),
    jupiterDataLength,
    Buffer.from(jupiterSwapData),
  ]);

  const instructionData = Buffer.concat([swapFeeToSolDiscriminator, argsBuffer]);

  const swapFeeToSolInstruction = {
    programId: PROGRAM_ID,
    keys: [
      { pubkey: vault, isSigner: false, isWritable: true }, // vault (PDA, mut)
      { pubkey: vaultOwner, isSigner: false, isWritable: false }, // owner
      { pubkey: feeTokenMint, isSigner: false, isWritable: false }, // input_mint
      { pubkey: vaultFeeTokenAccount, isSigner: false, isWritable: true }, // vault_fee_token_account (mut)
      { pubkey: adminSolAccount, isSigner: false, isWritable: true }, // admin_sol_account (mut)
      { pubkey: JUPITER_PROGRAM_ID, isSigner: false, isWritable: false }, // jupiter_program
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // token_program
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
      ...jupiterAccounts, // remaining_accounts for Jupiter swap
    ],
    data: instructionData,
  };

  // Build transaction with swap_fee_to_sol instruction first to estimate fees
  const tempTransaction = new Transaction();
  tempTransaction.add(swapFeeToSolInstruction);

  const { getRelayer } = await import("./relayer");
  const relayer = getRelayer(connection);
  const relayerPubkey = relayer.getPublicKey();

  const { blockhash } = await connection.getLatestBlockhash();
  tempTransaction.recentBlockhash = blockhash;
  tempTransaction.feePayer = relayerPubkey;

  // Estimate transaction fee for the swap_fee_to_sol instruction
  const message = tempTransaction.compileMessage();
  const feeEstimate = await connection.getFeeForMessage(message);
  const baseFee = feeEstimate?.value || 50000; // Fallback to 50k lamports

  // Add buffer for the cover_transaction_fees instruction itself
  const coverFeeInstructionCost = 10000; // Buffer for cover_transaction_fees instruction
  const estimatedFee = baseFee + coverFeeInstructionCost;

  // Build cover_transaction_fees instruction with the estimated fee
  const coverFeeDiscriminator = Buffer.from([64, 23, 219, 120, 75, 63, 68, 190]);
  const feeAmountBN = new BN(estimatedFee.toString());
  const coverFeeArgs = feeAmountBN.toArrayLike(Buffer, "le", 8);
  const coverFeeData = Buffer.concat([coverFeeDiscriminator, coverFeeArgs]);

  const coverFeeInstruction = {
    programId: PROGRAM_ID,
    keys: [
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: vaultOwner, isSigner: false, isWritable: false },
      { pubkey: relayerPubkey, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: coverFeeData,
  };

  // Build final transaction with cover fee instruction first, then swap_fee_to_sol instruction
  const transaction = new Transaction();
  transaction.add(coverFeeInstruction);
  transaction.add(swapFeeToSolInstruction);
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = relayerPubkey;

  return transaction;
}
