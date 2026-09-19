import { useCallback } from "react";
import { useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  clearWallet,
  generateWallet,
  getWalletSnapshot,
  saveWallet,
  subscribeWallet,
  walletFromPrivHex,
  type WalletKeys,
} from "@/lib/bitweb";

/**
 * Wallet session state. Keys persist in the node's IndexedDB `wallet` store
 * (hot storage on this device - the UI warns the user accordingly).
 *
 * The wallet lives in ONE module-level reactive store (lib/bitweb.ts), not
 * in per-component state: every useWallet() reader subscribes to the same
 * snapshot via useSyncExternalStore, so a generate/import/eject on the
 * Wallet page immediately re-renders the topbar (and every other reader).
 * Each mutation also invalidates the account queries so the displayed
 * balance refetches against the new address right away.
 */
export function useWallet() {
  const queryClient = useQueryClient();
  const wallet = useSyncExternalStore(subscribeWallet, getWalletSnapshot, getWalletSnapshot);

  const create = useCallback((): WalletKeys => {
    const w = generateWallet();
    saveWallet(w);
    queryClient.invalidateQueries();
    return w;
  }, [queryClient]);

  const importKey = useCallback(
    (hex: string): WalletKeys | null => {
      const w = walletFromPrivHex(hex.trim().toLowerCase());
      if (w) {
        saveWallet(w);
        queryClient.invalidateQueries();
      }
      return w;
    },
    [queryClient],
  );

  const destroy = useCallback(() => {
    clearWallet();
    queryClient.invalidateQueries();
  }, [queryClient]);

  return { wallet, create, importKey, destroy };
}
