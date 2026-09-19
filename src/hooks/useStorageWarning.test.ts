/**
 * Storage risk policy tests - the pure decision behind useStorageWarning.
 * The hook itself is a thin react-query wrapper; all branching lives here.
 */
import { describe, expect, it } from "vitest";
import { storageRisk } from "./useStorageWarning";

describe("storageRisk", () => {
  it("memory mode is always a risk, regardless of the persisted flag", () => {
    expect(storageRisk({ mode: "memory", persisted: null })).toBe("memory-only");
    expect(storageRisk({ mode: "memory", persisted: false })).toBe("memory-only");
    expect(storageRisk({ mode: "memory", persisted: true })).toBe("memory-only");
  });

  it("persistent + explicitly evictable is a risk", () => {
    expect(storageRisk({ mode: "persistent", persisted: false })).toBe("evictable");
  });

  it("persistent + granted persistence is safe", () => {
    expect(storageRisk({ mode: "persistent", persisted: true })).toBeNull();
  });

  it("persistent + unknown persistence (privacy-hiding browser) is not nagged", () => {
    expect(storageRisk({ mode: "persistent", persisted: null })).toBeNull();
  });
});
