"use client";

import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { WalletName } from "@solana/wallet-adapter-base";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useState, useMemo } from "react";
import { PublicKey } from "@solana/web3.js";
import { Wallet, LogOut, Copy, Check } from "lucide-react";

export function WalletButton() {
  const {
    wallets,
    wallet,
    publicKey,
    connected,
    connecting,
    disconnecting,
    select,
    disconnect,
  } = useWallet();
  const { connection } = useConnection();
  const [copied, setCopied] = useState(false);
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  const availableWallets = useMemo(() => {
    return wallets.filter((w) => w.readyState === "Installed");
  }, [wallets]);

  const handleConnect = async (walletName: WalletName) => {
    try {
      select(walletName);
      setIsDialogOpen(false);
    } catch (error) {
      console.error("Error connecting wallet:", error);
    }
  };

  const handleDisconnect = async () => {
    try {
      await disconnect();
    } catch (error) {
      console.error("Error disconnecting wallet:", error);
    }
  };

  const copyAddress = async () => {
    if (publicKey) {
      await navigator.clipboard.writeText(publicKey.toBase58());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const formatAddress = (address: PublicKey) => {
    const str = address.toBase58();
    return `${str.slice(0, 4)}...${str.slice(-4)}`;
  };

  if (connected && publicKey) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" className="gap-2">
            <Wallet className="h-4 w-4" />
            {formatAddress(publicKey)}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel>Wallet</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={copyAddress} className="gap-2">
            {copied ? (
              <>
                <Check className="h-4 w-4" />
                Copied!
              </>
            ) : (
              <>
                <Copy className="h-4 w-4" />
                Copy Address
              </>
            )}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={handleDisconnect}
            disabled={disconnecting}
            className="gap-2 text-red-600"
          >
            <LogOut className="h-4 w-4" />
            {disconnecting ? "Disconnecting..." : "Disconnect"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return (
    <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
      <DialogTrigger asChild>
        <Button disabled={connecting}>
          {connecting ? "Connecting..." : "Connect Wallet"}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect Wallet</DialogTitle>
          <DialogDescription>
            Choose a wallet to connect to your account
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 py-4">
          {availableWallets.length > 0 ? (
            availableWallets.map((w) => (
              <Button
                key={w.adapter.name}
                variant="outline"
                className="w-full justify-start gap-3 h-auto py-3"
                onClick={() => handleConnect(w.adapter.name)}
                disabled={connecting}
              >
                {w.adapter.icon && (
                  <img
                    src={w.adapter.icon}
                    alt={w.adapter.name}
                    className="h-6 w-6"
                  />
                )}
                <div className="flex flex-col items-start">
                  <span className="font-medium">{w.adapter.name}</span>
                  {w.adapter.url && (
                    <span className="text-xs text-muted-foreground">
                      {w.adapter.url}
                    </span>
                  )}
                </div>
              </Button>
            ))
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              <p className="mb-4">No wallets found</p>
              <p className="text-sm">
                Please install a Solana wallet extension like Phantom
              </p>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

