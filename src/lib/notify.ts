/**
 * Notification center - the terminal's memory of what happened while the
 * user was away. Every event worth telling the user about (mined blocks,
 * incoming transfers, confirmed sends, peers, mining state, errors) is
 * appended here, persisted to localStorage, and mirrored to the feedback
 * engine (sound + haptic + screen-reader line). Covers chain events (mined
 * blocks, incoming transfers, confirmed sends, peers, mining state, errors)
 * and local risk cues (backup reminders, storage warnings).
 *
 * Design contract:
 *   - PERSISTENT: survives reloads (localStorage, capped at MAX_ITEMS,
 *     oldest evicted first). Storage failures degrade to session-only.
 *   - SAFE: messages are plain data rendered by React (no HTML), capped
 *     in length, and NEVER carry key material - only public chain data
 *     (heights, amounts, addresses, txids, peer ids).
 *   - QUIET BY DESIGN: an identical type+message already present among the
 *     recent entries inside DEDUPE_WINDOW_MS is dropped - a repeating error
 *     cannot flood the panel, and two tabs watching the same wallet cannot
 *     double-store the same event (they share this localStorage).
 *   - REACT: components subscribe with useSyncExternalStore; the store
 *     also listens to "storage" events so two tabs stay in sync.
 */

import { soundEngine, type SoundEvent } from "./sound";

export type NotificationType =
  | "block_found"
  | "transaction_received"
  | "transfer_confirmed"
  | "pop_reward"
  | "system"
  | "backup_reminder"
  | "peer_connected"
  | "mining_start"
  | "mining_stop"
  | "error";

export interface AppNotification {
  id: string;
  type: NotificationType;
  /** Uppercase short headline, e.g. "BLOCK FOUND". */
  title: string;
  /** Details line, e.g. "You mined block #1,234. Reward: 500 BTWB". */
  message: string;
  /** Wall-clock milliseconds. */
  at: number;
  read: boolean;
}

const STORE_KEY = "btwb.notifications.v1";
export const MAX_ITEMS = 200;
const MAX_MESSAGE = 300;
const DEDUPE_WINDOW_MS = 60_000;

const TITLES: Record<NotificationType, string> = {
  block_found: "BLOCK FOUND",
  transaction_received: "BTWB RECEIVED",
  transfer_confirmed: "TRANSFER CONFIRMED",
  pop_reward: "POP REWARD",
  system: "SYSTEM",
  backup_reminder: "BACKUP REMINDER",
  peer_connected: "PEER CONNECTED",
  mining_start: "MINING STARTED",
  mining_stop: "MINING STOPPED",
  error: "ERROR",
};

/** Terminal-glyph icon per type (pure ASCII - the CRT has no emoji font). */
export const ICONS: Record<NotificationType, string> = {
  block_found: "[#]",
  transaction_received: "[>>]",
  transfer_confirmed: "[<<]",
  pop_reward: "[%]",
  system: "[*]",
  backup_reminder: "[=]",
  peer_connected: "[o]",
  mining_start: "[>]",
  mining_stop: "[|]",
  error: "[!]",
};

/** Which feedback sound/haptic each notification type plays on arrival. */
const SOUND_MAP: Record<NotificationType, SoundEvent> = {
  block_found: "block_found",
  transaction_received: "transaction_received",
  transfer_confirmed: "transaction_sent",
  pop_reward: "pop_reward",
  system: "system",
  backup_reminder: "system",
  peer_connected: "peer_connected",
  mining_start: "mining_start",
  mining_stop: "mining_stop",
  error: "error",
};

// -- store state -----------------------------------------------------------------

let items: AppNotification[] = [];
const listeners = new Set<() => void>();
let seq = 0;

function emit(): void {
  for (const fn of listeners) fn();
}

function persist(): void {
  try {
    globalThis.localStorage?.setItem(STORE_KEY, JSON.stringify(items));
  } catch {
    // storage full/blocked - notifications stay session-local
  }
}

function load(): void {
  try {
    const raw = globalThis.localStorage?.getItem(STORE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return;
    items = parsed
      .filter(
        (n): n is AppNotification =>
          typeof n === "object" &&
          n !== null &&
          typeof (n as AppNotification).id === "string" &&
          typeof (n as AppNotification).type === "string" &&
          (n as AppNotification).type in TITLES &&
          typeof (n as AppNotification).title === "string" &&
          typeof (n as AppNotification).message === "string" &&
          typeof (n as AppNotification).at === "number" &&
          typeof (n as AppNotification).read === "boolean",
      )
      .slice(-MAX_ITEMS);
    const maxSeq = items.reduce((m, n) => {
      const tail = Number(n.id.split("-").pop());
      return Number.isFinite(tail) ? Math.max(m, tail) : m;
    }, 0);
    seq = maxSeq;
  } catch {
    items = [];
  }
}

load();

// Cross-tab sync: another tab's write arrives as a "storage" event.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === STORE_KEY) {
      load();
      emit();
    }
  });
}

// -- public API --------------------------------------------------------------------

/**
 * Append a notification and fire the matching sound/haptic cue. Returns
 * the created entry, or null when deduped (same type+message within the
 * dedupe window).
 */
export function notify(type: NotificationType, message: string): AppNotification | null {
  const now = Date.now();
  const trimmed = message.slice(0, MAX_MESSAGE);
  // Scan the recent tail: an identical type+message inside the window is a
  // duplicate - whether from a repeating local error or from a second tab
  // whose watcher just stored the same chain event to this shared storage.
  const tail = items.slice(-25);
  for (let i = tail.length - 1; i >= 0; i--) {
    const n = tail[i];
    if (now - n.at >= DEDUPE_WINDOW_MS) break; // older than the window - stop
    if (n.type === type && n.message === trimmed) return null;
  }

  const entry: AppNotification = {
    id: `${now.toString(36)}-${++seq}`,
    type,
    title: TITLES[type],
    message: trimmed,
    at: now,
    read: false,
  };
  items = [...items, entry].slice(-MAX_ITEMS);
  persist();
  emit();
  soundEngine.feedback(SOUND_MAP[type]);
  return entry;
}

export function getNotifications(): AppNotification[] {
  return items;
}

export function getUnreadCount(): number {
  let n = 0;
  for (const item of items) if (!item.read) n += 1;
  return n;
}

export function markAllRead(): void {
  if (items.every((n) => n.read)) return;
  items = items.map((n) => (n.read ? n : { ...n, read: true }));
  persist();
  emit();
}

export function markRead(id: string): void {
  const target = items.find((n) => n.id === id);
  if (!target || target.read) return;
  items = items.map((n) => (n.id === id ? { ...n, read: true } : n));
  persist();
  emit();
}

export function clearNotifications(): void {
  if (items.length === 0) return;
  items = [];
  persist();
  emit();
}

export function subscribeNotifications(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// -- outgoing-transfer confirmation tracking --------------------------------------
// The Transfers page registers each broadcast txid; the balance watcher
// reports back when the txid lands in a block. Persisted so a reload
// between send and confirmation does not lose the pending entry.

const PENDING_KEY = "btwb.pendingtx.v1";

export interface PendingTx {
  txid: string;
  amount: number; // base units
  at: number;
}

let pendingTxs: PendingTx[] = [];

function persistPending(): void {
  try {
    globalThis.localStorage?.setItem(PENDING_KEY, JSON.stringify(pendingTxs));
  } catch {
    // session-only fallback
  }
}

function loadPending(): void {
  try {
    const raw = globalThis.localStorage?.getItem(PENDING_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return;
    pendingTxs = parsed.filter(
      (p): p is PendingTx =>
        typeof p === "object" &&
        p !== null &&
        typeof (p as PendingTx).txid === "string" &&
        typeof (p as PendingTx).amount === "number" &&
        typeof (p as PendingTx).at === "number",
    );
  } catch {
    pendingTxs = [];
  }
}

loadPending();

export function trackPendingTx(txid: string, amount: number): void {
  if (pendingTxs.some((p) => p.txid === txid)) return;
  pendingTxs = [...pendingTxs, { txid, amount, at: Date.now() }].slice(-50);
  persistPending();
}

export function untrackPendingTx(txid: string): void {
  if (!pendingTxs.some((p) => p.txid === txid)) return;
  pendingTxs = pendingTxs.filter((p) => p.txid !== txid);
  persistPending();
}

export function getPendingTxs(): PendingTx[] {
  return pendingTxs;
}
