/**
 * Screen wake lock for chain updates - the iPhone freeze trigger.
 *
 * iOS auto-locks an untouched screen in ~30 s. It does not care that the
 * node is mid-sync behind the UPDATING overlay and the user is watching it:
 * the page freezes, every socket dies silently, and the IndexedDB connection
 * comes back from the thaw as a zombie (requests accepted, never settled).
 * The recovery then reads exactly as "updating reached attempt 2 and froze".
 * macOS Safari does not auto-lock the same way - which is why the desktop
 * recovered and the phone did not.
 *
 * While the chain gate is active we hold a screen wake lock: the display
 * stays on, the page stays alive, and the sync finishes. Safari (iOS 16.4+)
 * auto-releases the lock when the tab hides - signalled via the sentinel's
 * "release" event - so we track that event (a stale sentinel reference must
 * never fool us into thinking we still hold a lock) and re-request on every
 * visibility restore while the gate is still active.
 *
 * Every step is defensive: no API, a denied request (battery saver), or a
 * hidden document simply means "no lock" - the node works exactly as
 * before, only without the auto-lock protection.
 */

interface WakeLockSentinelLike {
  release(): Promise<void>;
  addEventListener?: (type: "release", cb: () => void) => void;
  onrelease?: (() => void) | null;
}
interface WakeLockLike {
  request(type: "screen"): Promise<WakeLockSentinelLike>;
}
interface DocumentLike {
  visibilityState?: string;
  addEventListener?: (type: string, cb: () => void) => void;
}

let wanted = false;
let sentinel: WakeLockSentinelLike | null = null;
let requesting = false;
let listening = false;

function wakeLockApi(): WakeLockLike | null {
  const nav = (globalThis as { navigator?: { wakeLock?: WakeLockLike } }).navigator;
  return nav?.wakeLock ?? null;
}

function doc(): DocumentLike | null {
  return (globalThis as { document?: DocumentLike }).document ?? null;
}

function docVisible(): boolean {
  const d = doc();
  return !d || d.visibilityState !== "hidden";
}

async function acquire(): Promise<void> {
  if (sentinel || requesting) return;
  const api = wakeLockApi();
  if (!api || !docVisible()) return; // hidden pages are denied anyway
  requesting = true;
  try {
    const s = await api.request("screen");
    if (!wanted) {
      // the gate closed while the request was in flight - drop it
      await s.release().catch(() => undefined);
      return;
    }
    sentinel = s;
    // The OS can take the lock back at any moment (tab hidden, battery
    // saver): the release event is the ONLY trustworthy signal. Clear the
    // reference so the next visibilitychange (or gate re-entry) re-acquires
    // instead of trusting a dead sentinel.
    const onOsRelease = () => {
      if (sentinel === s) sentinel = null;
    };
    if (typeof s.addEventListener === "function") s.addEventListener("release", onOsRelease);
    else s.onrelease = onOsRelease;
  } catch {
    // NotAllowedError & friends: no lock, no drama - the node is unaffected
  } finally {
    requesting = false;
  }
}

function armVisibilityListener(): void {
  if (listening) return;
  const d = doc();
  if (!d?.addEventListener) return;
  listening = true;
  d.addEventListener("visibilitychange", () => {
    // Safari released our lock while the tab was hidden: take it back
    if (wanted && docVisible()) void acquire();
  });
}

/**
 * Hold (true) or release (false) the screen wake lock for a chain update.
 * Driven by the chain gate's own ref-counted active flag, so nested updates
 * keep the lock until the outermost one closes. Idempotent.
 */
export function setChainWakeLock(w: boolean): void {
  wanted = w;
  if (w) {
    armVisibilityListener();
    void acquire();
  } else {
    const s = sentinel;
    sentinel = null;
    if (s) void s.release().catch(() => undefined);
  }
}

/** Test hook: true while a lock is actually held. */
export function chainWakeLockHeld(): boolean {
  return sentinel !== null;
}

/** Test hook: drop all module state (the document listener is per-realm). */
export function __resetWakeLockForTests(): void {
  wanted = false;
  sentinel = null;
  requesting = false;
  listening = false;
}
