/**
 * The opening wordmark sweep must last EXACTLY 2 seconds, reach 100%, and
 * always land on the real mined fraction - these are pinned, not eyeballed.
 */
import { describe, expect, it } from "vitest";
import {
  BOOT_SWEEP_DOWN_MS,
  BOOT_SWEEP_MS,
  BOOT_SWEEP_UP_MS,
  bootSweepFillAt,
} from "./bootfill";

describe("bootSweepFillAt - the 2s opening sweep", () => {
  it("the total animation is exactly 2 seconds", () => {
    expect(BOOT_SWEEP_MS).toBe(2000);
    expect(BOOT_SWEEP_UP_MS + BOOT_SWEEP_DOWN_MS).toBe(BOOT_SWEEP_MS);
  });

  it("starts at zero and climbs linearly through the up phase", () => {
    expect(bootSweepFillAt(0, 0.25)).toBe(0);
    expect(bootSweepFillAt(-50, 0.25)).toBe(0); // clock skew guard
    expect(bootSweepFillAt(600, 0.25)).toBeCloseTo(0.5, 10);
    expect(bootSweepFillAt(BOOT_SWEEP_UP_MS, 0.25)).toBe(1); // peak: full 100%
  });

  it("eases back down and lands exactly on the real mined fraction", () => {
    const real = 0.25;
    // midpoint of the settle phase: easeInOut(0.5) = 0.5 -> halfway between 1 and real
    expect(bootSweepFillAt(BOOT_SWEEP_UP_MS + BOOT_SWEEP_DOWN_MS / 2, real)).toBeCloseTo(
      0.625,
      10,
    );
    expect(bootSweepFillAt(BOOT_SWEEP_MS, real)).toBe(real);
    expect(bootSweepFillAt(BOOT_SWEEP_MS + 5000, real)).toBe(real); // stays on the truth
  });

  it("a fully mined supply never dips below 100%", () => {
    expect(bootSweepFillAt(1600, 1)).toBe(1);
    expect(bootSweepFillAt(BOOT_SWEEP_MS, 1)).toBe(1);
  });

  it("an untouched chain (genesis only) settles back to zero", () => {
    expect(bootSweepFillAt(BOOT_SWEEP_MS, 0)).toBe(0);
    const mid = bootSweepFillAt(1700, 0);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });

  it("clamps a malformed real fraction instead of exploding", () => {
    expect(bootSweepFillAt(BOOT_SWEEP_MS, 1.7)).toBe(1);
    expect(bootSweepFillAt(BOOT_SWEEP_MS, -0.3)).toBe(0);
  });

  it("the settle phase is monotonic when descending to a low real value", () => {
    let prev = 1;
    for (let t = BOOT_SWEEP_UP_MS; t <= BOOT_SWEEP_MS; t += 50) {
      const v = bootSweepFillAt(t, 0.1);
      expect(v).toBeLessThanOrEqual(prev + 1e-12);
      prev = v;
    }
  });
});
