import {
  Connection,
  Transaction,
  Keypair,
} from "@solana/web3.js";
import bs58 from "bs58";

/**
 * Minimal relayer - only signs to submit transactions, never pays fees
 * 
 * The relayer:
 * - Signs the outer transaction to submit it (required by Solana)
 * - Does NOT pay fees - the vault pays via a program instruction
 * - Does NOT sign swap instructions (vault signs via invoke_signed)
 * 
 * The transaction includes a program instruction that transfers SOL
 * from the vault to cover transaction fees, so the vault effectively pays.
 */
export class MinimalRelayer {
  private relayerKeypair: Keypair;
  private connection: Connection;

  constructor(connection: Connection, relayerSecretKey: string) {
    this.connection = connection;
    // Decode the secret key from base58 or JSON array
    try {
      const secretKey = bs58.decode(relayerSecretKey);
      this.relayerKeypair = Keypair.fromSecretKey(secretKey);
    } catch {
      // If base58 decode fails, try parsing as JSON array
      const secretKeyArray = JSON.parse(relayerSecretKey);
      this.relayerKeypair = Keypair.fromSecretKey(Uint8Array.from(secretKeyArray));
    }
  }

  /**
   * Get the relayer's public key
   */
  getPublicKey() {
    return this.relayerKeypair.publicKey;
  }

  /**
   * Submit a transaction to the network
   * 
   * The transaction must include a program instruction that transfers SOL
   * from the vault to the relayer to cover fees. The relayer signs to submit,
   * but the vault pays via the program instruction.
   * 
   * @param transaction - Transaction to submit (must have fee coverage instruction)
   * @returns Transaction signature
   */
  async submitTransaction(transaction: Transaction): Promise<string> {
    // Get recent blockhash
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash();

    // Set transaction properties
    if (!transaction.recentBlockhash) {
      transaction.recentBlockhash = blockhash;
    }

    // Set relayer as fee payer (required - fee payer must be a signer in Solana)
    // But the vault pays via a program instruction that transfers SOL to relayer
    transaction.feePayer = this.relayerKeypair.publicKey;

    // Sign with relayer keypair (required to submit transaction)
    transaction.sign(this.relayerKeypair);

    // Send and confirm transaction
    const signature = await this.connection.sendRawTransaction(
      transaction.serialize(),
      {
        skipPreflight: false,
        maxRetries: 3,
      }
    );

    // Wait for confirmation
    await this.connection.confirmTransaction(
      {
        signature,
        blockhash,
        lastValidBlockHeight,
      },
      "confirmed"
    );

    return signature;
  }
}

/**
 * Create a singleton relayer instance
 */
let relayerInstance: MinimalRelayer | null = null;

export function getRelayer(connection: Connection): MinimalRelayer {
  if (!relayerInstance) {
    const relayerSecretKey = process.env.RELAYER_SECRET_KEY;
    if (!relayerSecretKey) {
      throw new Error(
        "RELAYER_SECRET_KEY environment variable is required. " +
        "Set it to a base58-encoded secret key or JSON array. " +
        "The relayer only signs to submit - the vault pays all fees."
      );
    }
    relayerInstance = new MinimalRelayer(connection, relayerSecretKey);
  }
  return relayerInstance;
}

/**
 * Submit transaction via minimal relayer
 * The vault pays all fees via program instruction, relayer just submits
 */
export async function submitViaRelayer(
  connection: Connection,
  transaction: Transaction
): Promise<string> {
  const relayer = getRelayer(connection);
  return await relayer.submitTransaction(transaction);
}

