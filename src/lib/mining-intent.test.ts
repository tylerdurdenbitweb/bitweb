/**
 * The mining intent flag is the user's START/STOP decision made durable.
 * Contract: absent by default, "1" after a manual START, gone after a
 * manual STOP, and every failure mode of storage (missing, throwing) is a
 * silent no-op - mining behavior must never depend on storage being there.
 */
import { afterEach, describe, expect, it } from "vitest";
import { getMiningIntent, setMiningIntent } from "./mining-intent";

function stubStorage(impl: Partial<Storage> = {}) {
  const map = new Map<string, string>();
  const storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    ...impl,
  } as Storage;
  (globalThis as { localStorage?: Storage }).localStorage = storage;
  return map;
}

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe("mining intent", () => {
  it("is off by default, on after START, off after STOP", () => {
    stubStorage();
    expect(getMiningIntent()).toBe(false);
    setMiningIntent(true);
    expect(getMiningIntent()).toBe(true);
    setMiningIntent(false);
    expect(getMiningIntent()).toBe(false);
  });

  it("persists under one stable key across module-level reads", () => {
    const map = stubStorage();
    setMiningIntent(true);
    expect(map.get("btwb.mining")).toBe("1"); // the key is the contract
    setMiningIntent(false);
    expect(map.has("btwb.mining")).toBe(false);
  });

  it("is a silent no-op when storage is missing entirely", () => {
    expect(getMiningIntent()).toBe(false);
    expect(() => setMiningIntent(true)).not.toThrow();
    expect(getMiningIntent()).toBe(false);
  });

  it("is a silent no-op when storage throws (blocked cookies)", () => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    } as unknown as Storage;
    expect(getMiningIntent()).toBe(false);
    expect(() => setMiningIntent(true)).not.toThrow();
    expect(() => setMiningIntent(false)).not.toThrow();
  });

  it("ignores garbage values - only an exact '1' means ON", () => {
    const map = stubStorage();
    map.set("btwb.mining", "yes");
    expect(getMiningIntent()).toBe(false);
    map.set("btwb.mining", "1");
    expect(getMiningIntent()).toBe(true);
  });
});
