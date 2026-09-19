/**
 * Reset local data - the recovery hatch on the boot failure screen. Wipes
 * every piece of BitWeb state on this origin (the IndexedDB chain database
 * with the wallet inside it, the localStorage preference keys, session
 * flags), then reloads the page so the node boots from a clean slate.
 * Lets a user escape any stale state without opening DevTools.
 */
import { CHAIN_ID } from "@contracts/protocol";

export async function resetLocalData(): Promise<void> {
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("btwb.")) localStorage.removeItem(key);
    }
  } catch {
    // storage blocked - nothing to clear
  }
  try {
    sessionStorage.clear();
  } catch {
    // ignore
  }
  try {
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(`bitweb-${CHAIN_ID}`);
      const done = () => resolve();
      req.onsuccess = done;
      req.onerror = done; // a blocked/missing db must not trap the user
      req.onblocked = done;
    });
  } catch {
    // IndexedDB unavailable - nothing to delete
  }
  location.reload();
}
