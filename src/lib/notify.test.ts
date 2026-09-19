/**
 * Notification store tests - persistence, eviction, dedupe, read state,
 * sound/haptic mapping, pending-transfer tracking and payload hygiene.
 * The feedback engine is mocked so the sound mapping is asserted, and a
 * memory localStorage stands in for the browser (node environment).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NotificationType } from "./notify";

const mocks = vi.hoisted(() => ({ feedback: vi.fn() }));
vi.mock("./sound", () => ({ soundEngine: { feedback: mocks.feedback } }));

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
  const mod = await import("./notify");
  return { mod, store: s };
}

afterEach(() => {
  mocks.feedback.mockClear();
  try {
    delete (globalThis as Record<string, unknown>)["localStorage"];
  } catch {
    // ignore
  }
});

const TYPES: NotificationType[] = [
  "block_found",
  "transaction_received",
  "transfer_confirmed",
  "pop_reward",
  "system",
  "backup_reminder",
  "peer_connected",
  "mining_start",
  "mining_stop",
  "error",
];

describe("notify()", () => {
  it("creates an unread entry with an uppercase title and persists it", async () => {
    const { mod, store } = await boot();
    const n = mod.notify("block_found", "You mined block #1,234. Reward: 500 BTWB");
    expect(n).not.toBeNull();
    expect(n!.title).toBe("BLOCK FOUND");
    expect(n!.title).toBe(n!.title.toUpperCase());
    expect(n!.read).toBe(false);
    expect(mod.getUnreadCount()).toBe(1);
    const persisted = JSON.parse(store.raw("btwb.notifications.v1")!);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].message).toBe("You mined block #1,234. Reward: 500 BTWB");
  });

  it("plays the mapped feedback sound for every type", async () => {
    const { mod } = await boot();
    const expected: Record<NotificationType, string> = {
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
    for (const t of TYPES) mod.notify(t, `msg-${t}`);
    expect(mocks.feedback.mock.calls.map((c) => c[0])).toEqual(TYPES.map((t) => expected[t]));
  });

  it("dedupes an identical type+message inside 60s, keeps distinct ones", async () => {
    const { mod } = await boot();
    expect(mod.notify("error", "same failure")).not.toBeNull();
    expect(mod.notify("error", "same failure")).toBeNull(); // flood guard
    expect(mod.notify("error", "a different failure")).not.toBeNull();
    expect(mod.getNotifications()).toHaveLength(2);
  });

  it("a second tab storing the same event cannot duplicate it", async () => {
    // Both tabs share this localStorage. Tab A notifies; its entries reach
    // tab B via the storage event; tab B's watcher then fires for the SAME
    // chain event - the content scan must drop the copy.
    const a = await boot();
    a.mod.notify("transaction_received", "Received 50 BTWB from btw1abc.... Block #9");
    const b = await boot(a.store); // second tab, same storage
    expect(
      b.mod.notify("transaction_received", "Received 50 BTWB from btw1abc.... Block #9"),
    ).toBeNull();
    expect(b.mod.getNotifications()).toHaveLength(1);
  });

  it("caps at 200 entries and evicts the oldest first", async () => {
    const { mod } = await boot();
    for (let i = 0; i < 210; i++) mod.notify("peer_connected", `peer ${i} joined`);
    const items = mod.getNotifications();
    expect(items).toHaveLength(200);
    expect(items[0].message).toBe("peer 10 joined"); // 0-9 evicted
    expect(items[199].message).toBe("peer 209 joined");
  });

  it("truncates oversized messages and keeps storage bounded", async () => {
    const { mod, store } = await boot();
    mod.notify("error", "x".repeat(5000));
    expect(mod.getNotifications()[0].message).toHaveLength(300);
    for (let i = 0; i < 250; i++) mod.notify("error", `e${i} ${"y".repeat(280)}`);
    // 200 entries x <=300 chars + envelope must stay well under 200 KB
    expect(store.raw("btwb.notifications.v1")!.length).toBeLessThan(200_000);
  });

  it("stays fast under flood (1000 writes)", async () => {
    const { mod } = await boot();
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) mod.notify("peer_connected", `flood ${i}`);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

describe("read state", () => {
  it("markRead flips one entry, markAllRead flips the rest", async () => {
    const { mod } = await boot();
    const a = mod.notify("mining_start", "started")!;
    mod.notify("mining_stop", "stopped");
    expect(mod.getUnreadCount()).toBe(2);
    mod.markRead(a.id);
    expect(mod.getUnreadCount()).toBe(1);
    expect(mod.getNotifications()[0].read).toBe(true);
    mod.markAllRead();
    expect(mod.getUnreadCount()).toBe(0);
    // idempotent - no-op calls do not throw
    mod.markRead("does-not-exist");
    mod.markAllRead();
  });

  it("clearNotifications empties the store and persists the empty list", async () => {
    const { mod, store } = await boot();
    mod.notify("error", "boom");
    mod.clearNotifications();
    expect(mod.getNotifications()).toHaveLength(0);
    expect(JSON.parse(store.raw("btwb.notifications.v1")!)).toEqual([]);
  });
});

describe("persistence", () => {
  it("survives a module reload (page refresh)", async () => {
    const first = await boot();
    first.mod.notify("block_found", "You mined block #7. Reward: 500 BTWB");
    first.mod.markAllRead();
    const second = await boot(first.store);
    const items = second.mod.getNotifications();
    expect(items).toHaveLength(1);
    expect(items[0].message).toContain("block #7");
    expect(items[0].read).toBe(true);
    // ids continue the sequence - no collisions with pre-reload entries
    const n = second.mod.notify("peer_connected", "peer x")!;
    expect(n.id).not.toBe(items[0].id);
  });

  it("corrupt storage falls back to empty instead of crashing", async () => {
    const store = makeLocalStorage();
    store.setItem("btwb.notifications.v1", "{broken");
    const { mod } = await boot(store);
    expect(mod.getNotifications()).toEqual([]);
  });

  it("drops malformed entries but keeps valid ones", async () => {
    const store = makeLocalStorage();
    store.setItem(
      "btwb.notifications.v1",
      JSON.stringify([
        { id: "a-1", type: "error", title: "ERROR", message: "ok", at: 1, read: false },
        { id: "b-2", type: "alien", title: "X", message: "bad type", at: 2, read: false },
        "garbage",
        { id: "c-3", type: "error", title: "ERROR", message: 42, at: 3, read: false },
      ]),
    );
    const { mod } = await boot(store);
    const items = mod.getNotifications();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("a-1");
  });
});

describe("subscriptions", () => {
  it("listeners fire on every mutation and unsubscribe cleanly", async () => {
    const { mod } = await boot();
    let calls = 0;
    const off = mod.subscribeNotifications(() => {
      calls += 1;
    });
    const n = mod.notify("error", "x")!;
    mod.notify("error", "y2");
    mod.markRead(n.id);
    mod.markAllRead(); // one entry still unread - a real mutation
    mod.clearNotifications();
    expect(calls).toBe(5);
    off();
    mod.notify("error", "y");
    expect(calls).toBe(5); // unsubscribed - no further calls
  });
});

describe("pending transfer tracking", () => {
  it("tracks, dedupes and untracks outgoing txids", async () => {
    const { mod } = await boot();
    mod.trackPendingTx("txid-aaa", 5_00000000);
    mod.trackPendingTx("txid-aaa", 5_00000000); // no duplicate
    expect(mod.getPendingTxs()).toHaveLength(1);
    expect(mod.getPendingTxs()[0]).toMatchObject({ txid: "txid-aaa", amount: 5_00000000 });
    mod.untrackPendingTx("txid-aaa");
    expect(mod.getPendingTxs()).toHaveLength(0);
    mod.untrackPendingTx("txid-aaa"); // no-op
  });

  it("persists across reloads so a confirmation is never lost", async () => {
    const first = await boot();
    first.mod.trackPendingTx("txid-bbb", 1250000000);
    const second = await boot(first.store);
    expect(second.mod.getPendingTxs().map((p) => p.txid)).toEqual(["txid-bbb"]);
  });
});

describe("payload hygiene", () => {
  it("all icons and titles are pure ASCII (the CRT has no emoji font)", async () => {
    const { mod } = await boot();
    for (const t of TYPES) {
      expect(mod.ICONS[t]).toMatch(/^[\x20-\x7e]+$/);
    }
    const n = mod.notify("transaction_received", "Received 50 BTWB from btw1abc...")!;
    expect(n.title).toMatch(/^[\x20-\x7e]+$/);
    expect(n.message).toMatch(/^[\x20-\x7e]+$/);
  });
});
