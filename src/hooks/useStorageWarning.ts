/**
 * Storage risk watcher - the node boots fine even when the browser offers
 * only forgetful storage, but the user must HEAR about it:
 *
 *   memory-only   IndexedDB is blocked (private mode, storage disabled):
 *                 chain AND wallet evaporate when the tab closes
 *   evictable     persistent storage was denied: under quota pressure the
 *                 browser may wipe this origin without asking
 *
 * Boot already asks for navigator.storage.persist() (client.ts); Chrome
 * grants it by engagement heuristics, so a tab that was denied early may
 * deserve a re-ask later - the hook re-requests, throttled. Each risk kind
 * notifies at most once per session (sessionStorage flag), so a reload
 * re-arms the warning - the danger returns with every fresh session too.
 */
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNode } from "@/providers/node-context";
import { notify } from "@/lib/notify";

export type StorageRisk = "memory-only" | "evictable";

/** Pure decision - unit-tested without a browser. */
export function storageRisk(h: {
  mode: "persistent" | "memory";
  persisted: boolean | null;
}): StorageRisk | null {
  if (h.mode === "memory") return "memory-only";
  if (h.persisted === false) return "evictable";
  return null;
}

const MESSAGES: Record<StorageRisk, string> = {
  "memory-only":
    "STORAGE IS MEMORY-ONLY - this browser blocks IndexedDB (private window?). Chain and wallet vanish when the tab closes; export the key file from the Wallet page.",
  evictable:
    "Persistent storage was DENIED - the browser may evict the chain and wallet under quota pressure. Export a backup from the Wallet page.",
};

const FLAGS_KEY = "btwb.storagewarned.v1";
const REASK_MS = 10 * 60_000; // re-request persistence at most this often
let lastReask = 0;

function alreadyWarned(kind: StorageRisk): boolean {
  try {
    const raw = globalThis.sessionStorage?.getItem(FLAGS_KEY);
    return raw ? (JSON.parse(raw) as string[]).includes(kind) : false;
  } catch {
    return false;
  }
}

function flagWarned(kind: StorageRisk): void {
  try {
    const kinds = (JSON.parse(
      globalThis.sessionStorage?.getItem(FLAGS_KEY) ?? "[]",
    ) as string[]).filter((k) => typeof k === "string");
    if (!kinds.includes(kind)) kinds.push(kind);
    globalThis.sessionStorage?.setItem(FLAGS_KEY, JSON.stringify(kinds));
  } catch {
    // session flag lost - worst case one extra notification
  }
}

export function useStorageWarning(): void {
  const node = useNode();
  const health = useQuery({
    queryKey: ["health"],
    queryFn: () => node.health(),
    refetchInterval: 15_000,
  });

  const mode = health.data?.storage.mode;
  const persisted = health.data?.storage.persisted;

  useEffect(() => {
    if (mode === undefined) return; // first health sample not in yet
    const risk = storageRisk({ mode, persisted: persisted ?? null });
    if (!risk || alreadyWarned(risk)) return;
    if (notify("system", MESSAGES[risk]) !== null) flagWarned(risk);

    // Denied persistence can flip to granted as the browser gains "trust"
    // in the origin - re-ask on a slow throttle, never more than REASK_MS.
    if (risk === "evictable" && Date.now() - lastReask > REASK_MS) {
      lastReask = Date.now();
      void navigator.storage
        ?.persist?.()
        .catch(() => undefined);
    }
  }, [mode, persisted]);
}
