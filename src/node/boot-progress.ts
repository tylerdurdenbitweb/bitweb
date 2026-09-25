/**
 * Boot progress - the BootSplash's own channel, independent of the chain
 * gate. The gate only exists once a mutation is in flight, but the slow
 * part of booting a grown chain (opening IndexedDB, verifying every stored
 * block row, the first sync window) happens BEFORE any node handle exists.
 * Without this channel the splash was a static "SEALING GENESIS ..." line
 * for the whole wait; with it every phase reports real numbers and the
 * splash can draw a bar that actually moves.
 *
 * Everything here is advisory UI state: no consensus, no storage, no
 * promises. Reporters call the setters; the splash subscribes.
 */

export interface BootProgressState {
  /** Current phase label ("verifying stored chain", "waking up the network"). */
  phase: string | null;
  /** Determinate numbers when the phase can measure them (block rows). */
  current: number | null;
  total: number | null;
  /** Time-boxed phase window (the first-sync wait): the splash animates
   *  start->end as the bar, so even a "we are waiting" phase has a known
   *  shape instead of looking frozen. */
  windowStart: number | null;
  windowEnd: number | null;
}

type Listener = (state: BootProgressState) => void;

let phase: string | null = null;
let current: number | null = null;
let total: number | null = null;
let windowStart: number | null = null;
let windowEnd: number | null = null;
const listeners = new Set<Listener>();

function snapshot(): BootProgressState {
  return { phase, current, total, windowStart, windowEnd };
}

function emit(): void {
  const s = snapshot();
  for (const fn of listeners) fn(s);
}

/** Announce a new phase; clears the previous phase's numbers and window. */
export function setBootPhase(text: string): void {
  phase = text;
  current = null;
  total = null;
  windowStart = null;
  windowEnd = null;
  emit();
}

/** Determinate progress inside the current phase (same unit both sides). */
export function setBootProgress(cur: number, tot: number): void {
  if (!Number.isFinite(cur) || !Number.isFinite(tot) || tot <= 0) return;
  current = Math.max(0, Math.min(cur, tot));
  total = tot;
  emit();
}

/** Mark the current phase as a bounded wait of `ms` from now. */
export function setBootWindow(ms: number): void {
  if (!Number.isFinite(ms) || ms <= 0) return;
  windowStart = Date.now();
  windowEnd = windowStart + ms;
  emit();
}

/** Boot finished (or failed): the splash is going away - drop all state. */
export function clearBootProgress(): void {
  phase = null;
  current = null;
  total = null;
  windowStart = null;
  windowEnd = null;
  emit();
}

export function getBootProgress(): BootProgressState {
  return snapshot();
}

export function subscribeBootProgress(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
