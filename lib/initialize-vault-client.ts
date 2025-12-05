"use client";

import { Program, AnchorProvider, BN } from "@coral-xyz/anchor";
import {
  Connection,
  PublicKey,
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
const CBBTC_MINT = new PublicKey(
  process.env.NEXT_PUBLIC_CBBTC_MINT!
);
export async function initializeVaultClient(
  connection: Connection,
  wallet: WalletContextState
): Promise<PublicKey> {
  if (!wallet.publicKey) {
    throw new Error("Wallet not connected");
  }

  const provider = new AnchorProvider(
    connection,
    {
      publicKey: wallet.publicKey!,
      signTransaction: wallet.signTransaction!,
      signAllTransactions: wallet.signAllTransactions!,
    },
    AnchorProvider.defaultOptions()
  );

  // @ts-expect-error - Anchor Program type inference issue
  const program = new Program(idl, PROGRAM_ID, provider);

  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), wallet.publicKey.toBuffer()],
    PROGRAM_ID
  );

  // Check if vault already exists
  const vaultInfo = await connection.getAccountInfo(vault);
  if (vaultInfo) {
    return vault;
  }

  // Get cbBTC ATA
  const cbbtcAta = await getAssociatedTokenAddress(
    CBBTC_MINT,
    vault,
    true
  );

  // Initialize vault
  const tx = await program.methods
    .initializeVault()
    .accounts({
      owner: wallet.publicKey,
      vault: vault,
      cbbtcMint: CBBTC_MINT,
      cbbtcAta: cbbtcAta,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log("Vault initialized:", tx);
  return vault;
}

