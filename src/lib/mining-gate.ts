/**
 * Mining gate controller - the pure half of the miner's reaction to chain
 * updates. useMiner keeps the workers and the browser lock; this module
 * decides WHEN to pause and WHEN to resume, so the policy is testable
 * without React, workers, or a DOM.
 *
 * Policy:
 *   - gate turns ACTIVE while mining (running OR a start is still
 *     acquiring its lock) -> pause exactly once, remember we owe a resume
 *   - gate turns active while idle -> nothing (no phantom resume later)
 *   - gate turns INACTIVE -> resume only if WE paused the miner
 *   - nested/overlapping updates pause once and resume once, at the end
 *     of the outermost operation
 */
import {
  beginChainUpdate,
  getChainGateState,
  isChainUpdating,
  setChainGateDetail,
  subscribeChainGate,
} from "@/node/chain-gate";

export interface MiningGateHooks {
  /** True when the miner is running or a start() is still acquiring. */
  isMining: () => boolean;
  /** Hard-pause: kill workers, clear timers - keep no state churning. */
  pause: () => void;
  /** Resume after the update completes (re-spins on the fresh tip). */
  resume: () => void;
}

/**
 * Subscribes the miner to the chain gate; returns the unsubscribe.
 * Reacts only to active<->inactive TRANSITIONS, so per-block progress
 * emissions during a long import never retrigger the logic.
 */
export function wireMiningGate(hooks: MiningGateHooks): () => void {
  let wasActive = false;
  let pausedByGate = false;
  return subscribeChainGate((state) => {
    if (state.active && !wasActive) {
      wasActive = true;
      if (hooks.isMining()) {
        pausedByGate = true;
        hooks.pause();
      }
      return;
    }
    if (!state.active && wasActive) {
      wasActive = false;
      if (pausedByGate) {
        pausedByGate = false;
        hooks.resume();
      }
    }
  });
}

// -- pre-flight hold (preparing to mine) -------------------------------------
// How long the pre-flight settle lasts: any sync that was ABOUT to start
// reveals itself inside this beat (its hold stacks on ours -> depth 2).
export const MINING_PREP_SETTLE_MS = 750;

export type MiningPrepResult =
  | { ok: true }
  | { ok: false; reason: "updating" | "template"; detail?: string };

/**
 * Pre-flight hold before the mining engine goes online. The user asked for
 * a hard rule: mining never starts into a chain that might still be moving.
 * So START first freezes the world for a beat ("UPDATING - preparing to
 * mine"), lets any just-arriving update reveal itself, proves a template
 * can be built on the settled tip, and only then reports ok:true.
 *
 * Depth discipline: our own hold makes depth 1, so "is anything ELSE also
 * updating" is depth > 1 - never a bare isChainUpdating() check (always
 * true while we hold). The release is in finally, so a template failure or
 * a mid-settle update can never wedge the gate.
 */
export async function prepareMiningStart(
  buildTemplate: () => Promise<unknown>,
): Promise<MiningPrepResult> {
  if (isChainUpdating()) return { ok: false, reason: "updating" };
  const done = beginChainUpdate("preparing to mine");
  try {
    setChainGateDetail("settling the latest blocks");
    await new Promise((r) => setTimeout(r, MINING_PREP_SETTLE_MS));
    if (getChainGateState().depth > 1) return { ok: false, reason: "updating" };
    setChainGateDetail("building your mining template");
    try {
      await buildTemplate();
    } catch (err) {
      // NEVER swallow the cause bare: a silent "could not prepare" had the
      // user retrying the miner-cooldown wall forever with no idea why. The
      // reason rides up to the UI and into the console.
      console.warn("[mining] template prep refused:", err);
      return {
        ok: false,
        reason: "template",
        detail: err instanceof Error ? err.message : String(err),
      };
    }
    return { ok: true };
  } finally {
    done();
  }
}
