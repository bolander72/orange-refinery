import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Connection, PublicKey } from "@solana/web3.js";
import { WalletContextState } from "@solana/wallet-adapter-react";
import { getVaultAddress, isVaultInitialized } from "../vault";
import { initializeVaultClient } from "../initialize-vault-client";

/**
 * Query key factory for vault-related queries
 */
export const vaultKeys = {
    all: ["vault"] as const,
    status: (owner: PublicKey | null) =>
        [...vaultKeys.all, "status", owner?.toBase58()] as const,
    address: (owner: PublicKey | null) =>
        [...vaultKeys.all, "address", owner?.toBase58()] as const,
};

/**
 * Hook to check if a vault is initialized
 */
export function useVaultStatus(
    connection: Connection | null,
    owner: PublicKey | null
) {
    return useQuery({
        queryKey: vaultKeys.status(owner),
        queryFn: async () => {
            if (!connection || !owner) {
                return false;
            }
            return await isVaultInitialized(connection, owner);
        },
        enabled: !!connection && !!owner,
        staleTime: 30 * 1000, // 30 seconds
    });
}

/**
 * Hook to get vault address (derived deterministically)
 */
export function useVaultAddress(owner: PublicKey | null) {
    return useQuery({
        queryKey: vaultKeys.address(owner),
        queryFn: () => {
            if (!owner) {
                return null;
            }
            return getVaultAddress(owner);
        },
        enabled: !!owner,
        staleTime: Infinity, // Address is deterministic, never changes
    });
}

/**
 * Hook to initialize a vault
 */
export function useInitializeVault(
    connection: Connection | null,
    walletContext: WalletContextState | null
) {
    const queryClient = useQueryClient();
    const { publicKey } = walletContext || {};

    return useMutation({
        mutationFn: async () => {
            if (!connection || !walletContext || !publicKey) {
                throw new Error("Wallet not connected");
            }
            return await initializeVaultClient(connection, walletContext);
        },
        onSuccess: (vaultPubkey) => {
            // Invalidate and refetch vault status
            const owner = publicKey ?? null;
            queryClient.invalidateQueries({
                queryKey: vaultKeys.status(owner),
            });
            queryClient.invalidateQueries({
                queryKey: vaultKeys.address(owner),
            });
            // Set the vault address in cache
            queryClient.setQueryData(
                vaultKeys.address(owner),
                vaultPubkey
            );
        },
    });
}

