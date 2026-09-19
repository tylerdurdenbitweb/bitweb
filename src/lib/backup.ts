/**
 * Backup reminder - the chain cannot be lost (every node holds it), but a
 * WALLET can: the private key lives only in this browser's IndexedDB. This
 * module remembers, per address, when the key was last exported and when we
 * last nagged, then answers one question: should we remind NOW?
 *
 * Policy (all constants below):
 *   - below MIN_BALANCE the wallet is pocket change - stay quiet
 *   - a key never exported, or exported longer than MAX_AGE ago, is at risk
 *   - one reminder per COOLDOWN at most - a nagging terminal gets muted
 *
 * The state is localStorage (shared across tabs, like the notification
 * center), keyed by address so a terminal hosting several wallets tracks
 * each one separately. Storage failures degrade to session-only silence -
 * never to a crash. Nothing here touches consensus: this is pure client UX.
 */

import { COIN } from "@contracts/protocol";

/** Remind only when the confirmed balance reaches this many base units. */
export const BACKUP_MIN_BALANCE = 1_000 * COIN; // 1,000 BTWB
/** A backup older than this is treated as lost (device churn, disk rot). */
export const BACKUP_MAX_AGE_MS = 30 * 24 * 3_600_000; // 30 days
/** Minimum wall-clock gap between two reminders for the same address. */
export const BACKUP_REMIND_COOLDOWN_MS = 12 * 3_600_000; // 12 hours

// -- verdict (pure, fully tested) ---------------------------------------------

export type BackupReminderReason = "never_backed_up" | "backup_stale";

export interface BackupVerdict {
  remind: boolean;
  reason: BackupReminderReason | null;
  /** Whole days since the last backup; null when never backed up. */
  backupAgeDays: number | null;
}

export function evaluateBackupReminder(args: {
  balance: number; // base units, confirmed
  backedUpAt: number | null; // ms epoch of the last successful export
  remindedAt: number | null; // ms epoch of the last reminder shown
  now: number;
}): BackupVerdict {
  const { balance, backedUpAt, remindedAt, now } = args;
  const quiet: BackupVerdict = { remind: false, reason: null, backupAgeDays: null };
  if (balance < BACKUP_MIN_BALANCE) return quiet;

  let reason: BackupReminderReason;
  let backupAgeDays: number | null = null;
  if (backedUpAt === null) {
    reason = "never_backed_up";
  } else {
    const age = now - backedUpAt;
    if (age <= BACKUP_MAX_AGE_MS) return quiet; // fresh backup - nothing to say
    reason = "backup_stale";
    backupAgeDays = Math.floor(age / 86_400_000);
  }

  // Cooldown applies to BOTH reasons: one reminder per window, period.
  if (remindedAt !== null && now - remindedAt < BACKUP_REMIND_COOLDOWN_MS) return quiet;
  return { remind: true, reason, backupAgeDays };
}

// -- persistence ---------------------------------------------------------------

const STORE_KEY = "btwb.backup.v1";

interface BackupStore {
  /** address -> ms epoch of the last successful key export. */
  backups: Record<string, number>;
  /** address -> ms epoch of the last reminder shown. */
  reminders: Record<string, number>;
}

function readStore(): BackupStore {
  try {
    const raw = globalThis.localStorage?.getItem(STORE_KEY);
    if (!raw) return { backups: {}, reminders: {} };
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) throw new Error("bad shape");
    const p = parsed as Partial<BackupStore>;
    // Defensive normalization: only numeric epochs survive, junk keys drop.
    const clean = (o: unknown): Record<string, number> => {
      const out: Record<string, number> = {};
      if (typeof o !== "object" || o === null) return out;
      for (const [k, v] of Object.entries(o)) {
        if (typeof v === "number" && Number.isFinite(v) && v > 0) out[k] = v;
      }
      return out;
    };
    return { backups: clean(p.backups), reminders: clean(p.reminders) };
  } catch {
    return { backups: {}, reminders: {} };
  }
}

function writeStore(s: BackupStore): void {
  try {
    globalThis.localStorage?.setItem(STORE_KEY, JSON.stringify(s));
  } catch {
    // storage full/blocked - reminder state stays session-local
  }
}

export function lastBackupAt(address: string): number | null {
  return readStore().backups[address] ?? null;
}

export function lastRemindedAt(address: string): number | null {
  return readStore().reminders[address] ?? null;
}

/** The user just exported the key file - the countdown resets. */
export function markBackedUp(address: string, at = Date.now()): void {
  const s = readStore();
  s.backups[address] = at;
  writeStore(s);
}

/** A reminder was actually delivered - start the cooldown. */
export function markReminded(address: string, at = Date.now()): void {
  const s = readStore();
  s.reminders[address] = at;
  writeStore(s);
}
