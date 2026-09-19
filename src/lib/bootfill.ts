/**
 * Opening logo sweep timeline (pure): the big Terminal wordmark fills like a
 * progress bar 0% -> 100%, then eases back to the REAL mined fraction of the
 * supply. One clock in, one fill out - the component just renders it.
 *
 * Total duration is exactly 2,000ms: 1,200ms sweep up + 800ms settle down.
 */

/** Phase 1: fill 0 -> 1. */
export const BOOT_SWEEP_UP_MS = 1200;
/** Phase 2: settle 1 -> real progress. */
export const BOOT_SWEEP_DOWN_MS = 800;
/** The whole animation, as requested: exactly two seconds. */
export const BOOT_SWEEP_MS = BOOT_SWEEP_UP_MS + BOOT_SWEEP_DOWN_MS;

function easeInOut(p: number): number {
  return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
}

/**
 * Fill fraction to show `elapsedMs` into the opening sweep, given the chain's
 * real mined fraction (0..1, clamped defensively). Before t=0: 0; after the
 * full 2s: exactly `realProgress` - the animation ALWAYS lands on the truth.
 */
export function bootSweepFillAt(elapsedMs: number, realProgress: number): number {
  const real = Math.min(1, Math.max(0, realProgress));
  if (elapsedMs <= 0) return 0;
  if (elapsedMs < BOOT_SWEEP_UP_MS) return elapsedMs / BOOT_SWEEP_UP_MS;
  if (elapsedMs >= BOOT_SWEEP_MS) return real;
  const p = easeInOut((elapsedMs - BOOT_SWEEP_UP_MS) / BOOT_SWEEP_DOWN_MS);
  return 1 + (real - 1) * p;
}
