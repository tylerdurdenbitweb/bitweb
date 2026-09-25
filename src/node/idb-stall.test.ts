/**
 * The zombie-connection guard: after an iOS page freeze, Safari can keep an
 * IndexedDB connection "open" while its requests NEVER settle - every chain
 * read then hangs forever, which is exactly how "NO PEERS CONNECTED" and the
 * frozen UPDATING overlay were born. withStallGuard turns that silent hang
 * into a loud IdbStallError (and poisons the storage so the next op reopens
 * the connection). These tests pin the guard's contract without a real IDB.
 */
import { describe, expect, it } from "vitest";
import { IdbStallError, withStallGuard } from "./idb";

describe("withStallGuard - the zombie IndexedDB connection detector", () => {
  it("passes through a request that settles in time", async () => {
    const stalled = { called: false };
    const value = await withStallGuard(
      Promise.resolve(42),
      () => {
        stalled.called = true;
      },
      50,
    );
    expect(value).toBe(42);
    expect(stalled.called).toBe(false);
  });

  it("rejects with IdbStallError - and poisons the owner - when the request never settles", async () => {
    const stalled = { called: false };
    const never = new Promise<number>(() => {}); // the zombie: never resolves
    await expect(
      withStallGuard(
        never,
        () => {
          stalled.called = true;
        },
        30,
      ),
    ).rejects.toBeInstanceOf(IdbStallError);
    expect(stalled.called).toBe(true);
  });

  it("a late rejection of the inner request wins over the stall timer", async () => {
    const stalled = { called: false };
    const boom = new Promise<number>((_, reject) =>
      setTimeout(() => reject(new Error("quota exceeded")), 5),
    );
    await expect(
      withStallGuard(
        boom,
        () => {
          stalled.called = true;
        },
        1_000,
      ),
    ).rejects.toThrow("quota exceeded");
    expect(stalled.called).toBe(false);
  });
});
