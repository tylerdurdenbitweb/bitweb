/**
 * Backup reminder tests - the pure policy (threshold, staleness, cooldown)
 * and the persisted per-address state. A memory localStorage stands in for
 * the browser (same pattern as notify.test.ts).
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  BACKUP_MAX_AGE_MS,
  BACKUP_MIN_BALANCE,
  BACKUP_REMIND_COOLDOWN_MS,
  evaluateBackupReminder,
} from "./backup";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000; // fixed epoch - deterministic ages

function makeLocalStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    raw: (k: string) => map.get(k),
  };
}

type Store = ReturnType<typeof makeLocalStorage>;

async function boot(store?: Store) {
  const { vi } = await import("vitest");
  vi.resetModules();
  try {
    delete (globalThis as Record<string, unknown>)["localStorage"];
  } catch {
    // ignore
  }
  const s = store ?? makeLocalStorage();
  Object.defineProperty(globalThis, "localStorage", {
    value: s,
    configurable: true,
    writable: true,
  });
  const mod = await import("./backup");
  return { mod, store: s };
}

afterEach(() => {
  try {
    delete (globalThis as Record<string, unknown>)["localStorage"];
  } catch {
    // ignore
  }
});

describe("evaluateBackupReminder - balance gate", () => {
  it("stays quiet below the threshold even with NO backup at all", () => {
    const v = evaluateBackupReminder({
      balance: BACKUP_MIN_BALANCE - 1,
      backedUpAt: null,
      remindedAt: null,
      now: NOW,
    });
    expect(v.remind).toBe(false);
    expect(v.reason).toBeNull();
  });

  it("fires at exactly the threshold", () => {
    const v = evaluateBackupReminder({
      balance: BACKUP_MIN_BALANCE,
      backedUpAt: null,
      remindedAt: null,
      now: NOW,
    });
    expect(v.remind).toBe(true);
    expect(v.reason).toBe("never_backed_up");
  });
});

describe("evaluateBackupReminder - backup age", () => {
  it("a fresh backup silences the reminder", () => {
    const v = evaluateBackupReminder({
      balance: BACKUP_MIN_BALANCE * 10,
      backedUpAt: NOW - 5 * DAY,
      remindedAt: null,
      now: NOW,
    });
    expect(v.remind).toBe(false);
  });

  it("a backup exactly at the age limit still counts as fresh", () => {
    const v = evaluateBackupReminder({
      balance: BACKUP_MIN_BALANCE * 10,
      backedUpAt: NOW - BACKUP_MAX_AGE_MS,
      remindedAt: null,
      now: NOW,
    });
    expect(v.remind).toBe(false);
  });

  it("a backup one ms past the age limit is stale, with whole-day age", () => {
    const v = evaluateBackupReminder({
      balance: BACKUP_MIN_BALANCE * 10,
      backedUpAt: NOW - BACKUP_MAX_AGE_MS - 1,
      remindedAt: null,
      now: NOW,
    });
    expect(v.remind).toBe(true);
    expect(v.reason).toBe("backup_stale");
    expect(v.backupAgeDays).toBe(30);
  });
});

describe("evaluateBackupReminder - cooldown", () => {
  it("suppresses a second reminder inside the cooldown window", () => {
    const v = evaluateBackupReminder({
      balance: BACKUP_MIN_BALANCE * 10,
      backedUpAt: null,
      remindedAt: NOW - (BACKUP_REMIND_COOLDOWN_MS - 1),
      now: NOW,
    });
    expect(v.remind).toBe(false);
  });

  it("fires again once the cooldown has elapsed", () => {
    const v = evaluateBackupReminder({
      balance: BACKUP_MIN_BALANCE * 10,
      backedUpAt: null,
      remindedAt: NOW - BACKUP_REMIND_COOLDOWN_MS,
      now: NOW,
    });
    expect(v.remind).toBe(true);
    expect(v.reason).toBe("never_backed_up");
  });

  it("cooldown also applies to the stale-backup reason", () => {
    const v = evaluateBackupReminder({
      balance: BACKUP_MIN_BALANCE * 10,
      backedUpAt: NOW - 60 * DAY,
      remindedAt: NOW - 1_000,
      now: NOW,
    });
    expect(v.remind).toBe(false);
  });
});

describe("persistence", () => {
  it("marks and reads the backup epoch per address", async () => {
    const { mod } = await boot();
    const a = "btw1" + "a".repeat(48);
    const b = "btw1" + "b".repeat(48);
    expect(mod.lastBackupAt(a)).toBeNull();
    mod.markBackedUp(a, NOW);
    expect(mod.lastBackupAt(a)).toBe(NOW);
    expect(mod.lastBackupAt(b)).toBeNull(); // per-address isolation
  });

  it("marks and reads the reminder epoch", async () => {
    const { mod } = await boot();
    const a = "btw1" + "c".repeat(48);
    expect(mod.lastRemindedAt(a)).toBeNull();
    mod.markReminded(a, NOW);
    expect(mod.lastRemindedAt(a)).toBe(NOW);
  });

  it("survives a module reload through shared localStorage", async () => {
    const first = await boot();
    const a = "btw1" + "d".repeat(48);
    first.mod.markBackedUp(a, NOW);
    const second = await boot(first.store); // same storage, fresh module
    expect(second.mod.lastBackupAt(a)).toBe(NOW);
  });

  it("corrupt storage reads as empty, never throws", async () => {
    const store = makeLocalStorage();
    store.setItem("btwb.backup.v1", "{not json");
    const { mod } = await boot(store);
    expect(mod.lastBackupAt("btw1" + "e".repeat(48))).toBeNull();
    store.setItem("btwb.backup.v1", JSON.stringify({ backups: { x: "junk" }, reminders: { x: -5 } }));
    expect(mod.lastBackupAt("x")).toBeNull(); // non-numeric epochs dropped
    expect(mod.lastRemindedAt("x")).toBeNull();
  });

  it("a throwing localStorage degrades to session-only silence", async () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => undefined,
      clear: () => undefined,
    };
    const { vi } = await import("vitest");
    vi.resetModules();
    Object.defineProperty(globalThis, "localStorage", {
      value: broken,
      configurable: true,
      writable: true,
    });
    const mod = await import("./backup");
    const a = "btw1" + "f".repeat(48);
    expect(() => mod.markBackedUp(a)).not.toThrow();
    expect(mod.lastBackupAt(a)).toBeNull();
  });
});
