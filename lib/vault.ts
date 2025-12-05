import { Program, AnchorProvider, BN } from "@coral-xyz/anchor";
import {
  Connection,
  PublicKey,
  Keypair,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { WalletContextState } from "@solana/wallet-adapter-react";
import idl from "../programs/vault/target/idl/vault.json";

const PROGRAM_ID = new PublicKey("HKKueNDGHd9fsuThJe7GSDpzWd6H1xeQJ2he75W5uHcZ");

// cbBTC mint address on Solana (update with actual address)
const CBBTC_MINT = new PublicKey(
  process.env.NEXT_PUBLIC_CBBTC_MINT!
);

export function getVaultAddress(owner: PublicKey): PublicKey {
  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), owner.toBuffer()],
    PROGRAM_ID
  );
  return vault;
}

/**
 * Check if a vault account is initialized on-chain
 */
export async function isVaultInitialized(
  connection: Connection,
  owner: PublicKey
): Promise<boolean> {
  const vaultAddress = getVaultAddress(owner);
  const vaultInfo = await connection.getAccountInfo(vaultAddress);
  return vaultInfo !== null && vaultInfo.data.length > 0;
}

export async function getProvider(
  connection: Connection,
  wallet: WalletContextState
): Promise<AnchorProvider> {
  const provider = new AnchorProvider(
    connection,
    {
      publicKey: wallet.publicKey!,
      signTransaction: wallet.signTransaction!,
      signAllTransactions: wallet.signAllTransactions!,
    },
    AnchorProvider.defaultOptions()
  );
  return provider;
}

export async function getProgram(
  connection: Connection,
  wallet: WalletContextState
): Promise<Program<any>> {
  const provider = await getProvider(connection, wallet);
  // @ts-expect-error - Anchor Program type inference issue
  return new Program(idl, PROGRAM_ID, provider);
}

export async function initializeVault(owner: PublicKey): Promise<PublicKey> {
  const connection = new Connection(
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL!,
    "confirmed"
  );

  // For now, we'll need the wallet to sign. In production, you might want
  // to use a server-side keypair or have the user sign
  const vaultAddress = getVaultAddress(owner);

  // Check if vault already exists
  const vaultInfo = await connection.getAccountInfo(vaultAddress);
  if (vaultInfo) {
    return vaultAddress;
  }

  // This should be called from the frontend with a connected wallet
  // For now, return the address - actual initialization will happen client-side
  return vaultAddress;
}

export async function getVaultCbbtcAta(vault: PublicKey): Promise<PublicKey> {
  return getAssociatedTokenAddress(CBBTC_MINT, vault, true);
}
