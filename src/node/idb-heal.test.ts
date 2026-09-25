/**
 * End-to-end zombie-connection recovery at the storage layer, driven by a
 * scripted fake IndexedDB. Two real-world shapes are pinned:
 *
 *   1. OPEN never settles (installed-PWA cold start next to a frozen
 *      sibling context - the "OPENING NODE DATABASE" hang): the open guard
 *      abandons the frozen request and takes a FRESH one, closing any
 *      late-arriving connection so nothing untracked leaks.
 *   2. A READ never settles on a live-looking connection (iOS page-freeze
 *      zombie): the operation self-heals - poison, reopen, replay - instead
 *      of surfacing as a fatal NODE BOOT FAILURE.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { IdbStallError, IdbStorage } from "./idb";

type Handler = (() => void) | null;

/** Minimal stand-in for IDBOpenDBRequest / IDBRequest. */
class FakeRequest<T = unknown> {
  onsuccess: Handler = null;
  onerror: Handler = null;
  onblocked: Handler = null;
  onupgradeneeded: Handler = null;
  result!: T;
  error: Error | null = null;
}

interface FakeDb {
  closed: boolean;
  close(): void;
  onversionchange: Handler;
  transaction(store: string): { objectStore(name: string): FakeStore };
}

interface FakeStore {
  count(): FakeRequest<number>;
}

/**
 * A scripted IDB factory. Each `open()` call pops the next script entry
 * (see ScriptStep): hang = never settles; succeed = settles with a db whose
 * count() resolves (or hangs when count is "hang"); delayMs past the stall
 * budget simulates the late arrival the guard already gave up on.
 */
type ScriptStep =
  | { kind: "hang" } // the request never settles (the zombie)
  | { kind: "succeed"; count: number | "hang"; delayMs?: number }; // settles; delayMs > stall = late

function fakeIndexedDB(script: ScriptStep[]) {
  const dbs: FakeDb[] = [];
  let calls = 0;
  const factory = {
    open(): FakeRequest<IDBDatabase> {
      const step = script[Math.min(calls, script.length - 1)];
      calls += 1;
      const r = new FakeRequest<IDBDatabase>();
      if (step.kind === "hang") return r; // never settles
      const countBehavior = step.count;
      const delay = step.delayMs ?? 0;
      const db: FakeDb = {
        closed: false,
        onversionchange: null,
        close() {
          this.closed = true;
        },
        transaction() {
          return {
            objectStore(): FakeStore {
              return {
                count(): FakeRequest<number> {
                  const cr = new FakeRequest<number>();
                  if (countBehavior !== "hang") {
                    cr.result = countBehavior;
                    setTimeout(() => cr.onsuccess?.(), 0);
                  }
                  return cr;
                },
              };
            },
          };
        },
      };
      dbs.push(db);
      setTimeout(() => {
        r.result = db as unknown as IDBDatabase;
        // NOTE: no onupgradeneeded - we simulate the normal path, an
        // existing database already at the current schema version.
        r.onsuccess?.();
      }, delay);
      return r;
    },
  };
  return { factory, dbs, openCalls: () => calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("IdbStorage zombie recovery", () => {
  it("open succeeds on a fresh attempt after the first one freezes", async () => {
    const { factory, dbs, openCalls } = fakeIndexedDB([
      { kind: "hang" },
      { kind: "succeed", count: 3 },
    ]);
    vi.stubGlobal("indexedDB", factory);

    const storage = new IdbStorage({ openStallMs: 25, openAttempts: 3 });
    await storage.open();
    expect(openCalls()).toBe(2);
    expect(dbs).toHaveLength(1); // only the healthy attempt produced a db
    expect(dbs[0].closed).toBe(false);

    // and the connection is genuinely usable
    expect(await storage.blockCount()).toBe(3);
  });

  it("a late-settling abandoned open is closed on arrival - untracked connections never leak", async () => {
    const { factory, dbs, openCalls } = fakeIndexedDB([
      { kind: "succeed", count: 3, delayMs: 80 }, // lands long after the 25ms guard fired
      { kind: "succeed", count: 5 },
    ]);
    vi.stubGlobal("indexedDB", factory);

    const storage = new IdbStorage({ openStallMs: 25, openAttempts: 3 });
    await storage.open(); // attempt 1 stalls at 25ms, attempt 2 succeeds fast
    expect(openCalls()).toBe(2);
    expect(await storage.blockCount()).toBe(5); // we are on connection 2

    await new Promise((r) => setTimeout(r, 100)); // the abandoned db arrives
    expect(dbs).toHaveLength(2);
    expect(dbs[0].closed).toBe(true); // put down on arrival, never tracked
    expect(dbs[1].closed).toBe(false);
  });

  it("a stalled read self-heals: poison, reopen, replay - the caller never sees the zombie", async () => {
    const { factory, dbs, openCalls } = fakeIndexedDB([
      { kind: "succeed", count: "hang" }, // connection 1: reads never settle
      { kind: "succeed", count: 7 }, // connection 2: healthy
    ]);
    vi.stubGlobal("indexedDB", factory);

    const storage = new IdbStorage({ stallMs: 25 });
    await storage.open();
    expect(openCalls()).toBe(1);

    const value = await storage.blockCount(); // stalls, heals, replays
    expect(value).toBe(7);
    expect(openCalls()).toBe(2);
    expect(dbs[0].closed).toBe(true); // the zombie was put down
    expect(dbs[1].closed).toBe(false);
  });

  it("two consecutive zombie reads (a truly dead database) surface IdbStallError instead of hanging forever", async () => {
    const { factory } = fakeIndexedDB([
      { kind: "succeed", count: "hang" },
      { kind: "succeed", count: "hang" }, // the reopen heals nothing
    ]);
    vi.stubGlobal("indexedDB", factory);

    const storage = new IdbStorage({ stallMs: 25 });
    await storage.open();
    await expect(storage.blockCount()).rejects.toBeInstanceOf(IdbStallError);
  });

  it("every open attempt stalling (frozen storage subsystem) rejects instead of pinning the boot screen", async () => {
    const { factory, openCalls } = fakeIndexedDB([
      { kind: "hang" },
      { kind: "hang" },
      { kind: "hang" },
    ]);
    vi.stubGlobal("indexedDB", factory);

    const storage = new IdbStorage({ openStallMs: 25, openAttempts: 3 });
    await expect(storage.open()).rejects.toBeInstanceOf(IdbStallError);
    expect(openCalls()).toBe(3);
  });
});
