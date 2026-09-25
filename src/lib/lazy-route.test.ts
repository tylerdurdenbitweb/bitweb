/**
 * The Safari empty-module crash: a lazy route chunk can RESOLVE without a
 * default export (interrupted fetch treated as an empty module), and
 * React.lazy then dies reading `.default` off it ("undefined is not an
 * object (evaluating 'E.result.default')"). loadRouteChunk validates the
 * namespace first: an invalid chunk triggers the guarded one-shot reload
 * and never commits; once the reload guard is spent, a descriptive error
 * reaches the route boundary instead of an infinite reload loop.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentType } from "react";
import { loadRouteChunk } from "./lazy-route";
import {
  __resetStaleChunkGuardForTests,
  recoverStaleChunk,
  staleChunkRecoverySpent,
} from "./chunk-recovery";

const Dummy = (() => null) as unknown as ComponentType<unknown>;

beforeEach(() => {
  __resetStaleChunkGuardForTests();
});

describe("loadRouteChunk - lazy chunk namespace validation", () => {
  it("passes a healthy module straight through", async () => {
    const m = await loadRouteChunk(() => Promise.resolve({ default: Dummy }));
    expect(m.default).toBe(Dummy);
  });

  it("chunk without a default export: triggers the guarded recovery and never commits the broken module", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let settled = false;
    const pending = loadRouteChunk(
      () => Promise.resolve({}) as Promise<{ default: ComponentType<unknown> }>,
    ).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    // give the microtask queue every chance to (wrongly) settle
    await Promise.race([pending, new Promise((r) => setTimeout(r, 120))]);
    expect(settled).toBe(false); // the page is reloading - React never sees it
    expect(staleChunkRecoverySpent()).toBe(true); // the one-shot reload was spent
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("guard already spent: surfaces a real error instead of looping reloads", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    recoverStaleChunk("test setup"); // spends the one-shot guard
    expect(staleChunkRecoverySpent()).toBe(true);
    await expect(
      loadRouteChunk(
        () => Promise.resolve({}) as Promise<{ default: ComponentType<unknown> }>,
      ),
    ).rejects.toThrow("lazy route chunk resolved without a default export");
    warn.mockRestore();
  });

  it("the recovery guard fires exactly once per realm", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    recoverStaleChunk("first");
    expect(staleChunkRecoverySpent()).toBe(true);
    recoverStaleChunk("second"); // no-op: one attempt per session
    expect(staleChunkRecoverySpent()).toBe(true);
    warn.mockRestore();
  });
});
