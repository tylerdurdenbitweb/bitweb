/**
 * Boot progress channel - the BootSplash's feed. Phases carry optional
 * determinate numbers or a bounded time window; everything clears when the
 * boot finishes. Pure synchronous module state - the assertions are on the
 * emitted snapshots.
 */
import { describe, expect, it, vi } from "vitest";

type Mod = typeof import("./boot-progress");

async function fresh(): Promise<Mod> {
  vi.resetModules();
  return import("./boot-progress");
}

describe("boot progress", () => {
  it("starts empty; phases clear previous numbers and windows", async () => {
    const bp = await fresh();
    expect(bp.getBootProgress()).toEqual({
      phase: null,
      current: null,
      total: null,
      windowStart: null,
      windowEnd: null,
    });
    bp.setBootPhase("verifying stored chain");
    bp.setBootProgress(5, 10);
    expect(bp.getBootProgress()).toMatchObject({ phase: "verifying stored chain", current: 5, total: 10 });
    bp.setBootPhase("waking up the network");
    const s = bp.getBootProgress();
    expect(s.phase).toBe("waking up the network");
    expect(s.current).toBeNull();
    expect(s.total).toBeNull();
    expect(s.windowStart).toBeNull();
  });

  it("progress clamps into range and ignores garbage", async () => {
    const bp = await fresh();
    bp.setBootPhase("p");
    bp.setBootProgress(99, 10);
    expect(bp.getBootProgress().current).toBe(10);
    bp.setBootProgress(Number.NaN, 10);
    expect(bp.getBootProgress().current).toBe(10); // unchanged
    bp.setBootProgress(3, 0);
    expect(bp.getBootProgress().current).toBe(10); // non-positive total ignored
  });

  it("a bounded window stamps start/end so the splash can animate the wait", async () => {
    const bp = await fresh();
    bp.setBootPhase("checking for a longer chain");
    bp.setBootWindow(6_000);
    const s = bp.getBootProgress();
    expect(s.windowStart).not.toBeNull();
    expect(s.windowEnd).toBe(s.windowStart! + 6_000);
  });

  it("subscribers see emissions; clear wipes everything", async () => {
    const bp = await fresh();
    const seen: string[] = [];
    const unsub = bp.subscribeBootProgress((s) => seen.push(JSON.stringify(s)));
    bp.setBootPhase("a");
    bp.setBootProgress(1, 2);
    bp.clearBootProgress();
    unsub();
    bp.setBootPhase("ignored");
    expect(seen.length).toBe(3);
    expect(JSON.parse(seen[2])).toEqual({
      phase: null,
      current: null,
      total: null,
      windowStart: null,
      windowEnd: null,
    });
  });
});
