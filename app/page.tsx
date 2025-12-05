"use client";

import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { WalletButton } from "@/components/WalletButton";
import { useVaultStatus, useVaultAddress, useInitializeVault } from "@/lib/queries/vault";

export default function Home() {
  const walletContext = useWallet();
  const { publicKey, connected } = walletContext;
  const { connection } = useConnection();

  // TanStack Query hooks
  const {
    data: isVaultInitializedState = false,
    isLoading: isChecking,
    error: statusError,
  } = useVaultStatus(connection, publicKey);

  const { data: vaultPubkey } = useVaultAddress(publicKey);

  const {
    mutate: initializeVault,
    isPending: isInitializing,
    error: initError,
  } = useInitializeVault(connection, walletContext);

  const vaultAddress = vaultPubkey?.toBase58() || null;
  const errorMessage =
    statusError instanceof Error
      ? statusError.message
      : initError instanceof Error
      ? initError.message
      : statusError || initError
      ? String(statusError || initError)
      : null;

  const handleSetupVault = () => {
    if (!publicKey || !connected) {
      return;
    }

    initializeVault(undefined, {
      onSuccess: (vaultPubkey) => {
        alert(`Vault created successfully! Address: ${vaultPubkey.toBase58()}`);
      },
      onError: (err: any) => {
        console.error("Error initializing vault:", err);
      },
    });
  };

  return (
    <div className="min-h-screen bg-linear-to-br from-orange-50 to-orange-100 p-8">
      <div className="max-w-4xl mx-auto">
        <div className="bg-white rounded-lg shadow-xl p-8">
          <h1 className="text-4xl font-bold text-orange-600 mb-2">
            Comrade Orange
          </h1>
          <p className="text-gray-600 mb-8">
            Bitcoin Savings Account - Automatic cbBTC Conversion
          </p>

          <div className="mb-6">
            <WalletButton />
          </div>

          {errorMessage && (
            <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
              {errorMessage}
            </div>
          )}

          {connected && publicKey && (
            <div className="space-y-4">
              <div className="bg-gray-50 p-4 rounded">
                <p className="text-sm text-gray-600 mb-1">Your Wallet:</p>
                <p className="font-mono text-sm break-all">{publicKey.toBase58()}</p>
              </div>

              {vaultAddress && isVaultInitializedState && (
                <div className="bg-green-50 p-4 rounded border border-green-200">
                  <p className="text-sm text-green-700 mb-1 font-semibold">
                    Your Vault Address:
                  </p>
                  <p className="font-mono text-sm break-all text-green-900">
                    {vaultAddress}
                  </p>
                  <p className="text-xs text-green-600 mt-2">
                    Send SOL or any SPL token to this address. It will automatically
                    be converted to cbBTC!
                  </p>
                </div>
              )}

              <button
                onClick={handleSetupVault}
                disabled={isInitializing || isChecking || isVaultInitializedState}
                className="w-full bg-orange-600 hover:bg-orange-700 disabled:bg-gray-400 text-white font-bold py-3 px-6 rounded-lg transition-colors"
              >
                {isChecking
                  ? "Checking vault status..."
                  : isInitializing
                  ? "Initializing..."
                  : isVaultInitializedState
                  ? "Vault Already Created"
                  : "Setup Bitcoin Savings Account"}
              </button>

              {vaultAddress && isVaultInitializedState && (
                <div className="mt-6 p-4 bg-blue-50 border border-blue-200 rounded">
                  <h3 className="font-semibold text-blue-900 mb-2">
                    How it works:
                  </h3>
                  <ul className="text-sm text-blue-800 space-y-1 list-disc list-inside">
                    <li>Send SOL or any SPL token to your vault address above</li>
                    <li>Our monitoring service detects the incoming transfer</li>
                    <li>Tokens are automatically swapped to cbBTC via Jupiter</li>
                    <li>cbBTC is stored securely in your vault</li>
                  </ul>
                </div>
              )}
            </div>
          )}

          {!connected && (
            <div className="text-center py-8 text-gray-500">
              Connect your wallet to get started
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
