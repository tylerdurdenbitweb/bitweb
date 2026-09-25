/**
 * Chain update gate - the single "system is mutating" switch.
 *
 * While ANY chain-changing operation is in flight - a file import, a peer
 * sync, a fork rollback, a gossiped block landing, a mined-block commit, a
 * history prune - the gate is ACTIVE and the whole node goes passive:
 *
 *   - mining cannot START (the miner hook checks isChainUpdating),
 *   - running mining is force-paused within the same event loop tick
 *     (the miner hook subscribes and kills its workers on `begin`),
 *   - the UI shows the centered UPDATING overlay until the gate releases.
 *
 * The gate is ref-counted: nested operations (the Terminal's import flow
 * wrapping importChain, a sync loop wrapping each applied block) hold the
 * gate until the OUTERMOST operation finishes. The first reason wins, so
 * the overlay never flickers between phases of one logical update.
 *
 * Everything here is synchronous and allocation-light: it sits on the
 * per-block apply path during bulk syncs, so no promises, no timers.
 */

export interface ChainGateProgress {
  current: number;
  total: number;
}

export interface ChainGateState {
  /** Number of nested operations currently holding the gate. */
  depth: number;
  active: boolean;
  /** Why the gate is held - first reason of the current burst wins. */
  reason: string | null;
  /** Optional live progress line ("312/1500 blocks", "block #1240"). */
  detail: string | null;
  /** Optional structured progress for a determinate bar (null: indeterminate). */
  progress: ChainGateProgress | null;
  /** When the current burst started (ms epoch), null while inactive. */
  startedAt: number | null;
}

type Listener = (state: ChainGateState) => void;

let depth = 0;
let reason: string | null = null;
let detail: string | null = null;
let progress: ChainGateProgress | null = null;
let startedAt: number | null = null;
const listeners = new Set<Listener>();

function snapshot(): ChainGateState {
  return { depth, active: depth > 0, reason, detail, progress, startedAt };
}

function emit(): void {
  const s = snapshot();
  for (const fn of listeners) fn(s);
}

/**
 * Marks the start of a chain mutation and returns its release function.
 * The release is idempotent: calling it twice never over-decrements the
 * count, so try/finally pairs stay safe even when re-entered.
 */
export function beginChainUpdate(why: string): () => void {
  depth += 1;
  if (depth === 1) {
    reason = why;
    detail = null;
    progress = null;
    startedAt = Date.now();
  }
  emit();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    depth = Math.max(0, depth - 1);
    if (depth === 0) {
      reason = null;
      detail = null;
      progress = null;
      startedAt = null;
    }
    emit();
  };
}

/** Live progress for long operations (import apply loops, sync batches). */
export function setChainGateDetail(text: string | null): void {
  if (depth === 0) return; // progress without an operation is noise
  detail = text;
  emit();
}

/**
 * Structured progress for a determinate bar: current/total in the same unit
 * (blocks applied, blocks fetched, ...). Pass null to go back to the
 * indeterminate bar. Cleared automatically when the burst ends, like detail.
 */
export function setChainGateProgress(current: number, total: number): void {
  if (depth === 0) return;
  progress =
    Number.isFinite(current) && Number.isFinite(total) && total > 0
      ? { current: Math.max(0, Math.min(current, total)), total }
      : null;
  emit();
}

export function clearChainGateProgress(): void {
  if (depth === 0 || progress === null) return;
  progress = null;
  emit();
}

export function isChainUpdating(): boolean {
  return depth > 0;
}

export function getChainGateState(): ChainGateState {
  return snapshot();
}

export function subscribeChainGate(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Boot-time safety net: a fresh node cannot be mid-update, so any leftover
 * count (a crashed HMR realm, a half-torn test) is dropped rather than
 * pinning the overlay forever. Does not emit when already clean.
 */
export function resetChainGate(): void {
  if (depth === 0 && reason === null) return;
  depth = 0;
  reason = null;
  detail = null;
  progress = null;
  startedAt = null;
  emit();
}
