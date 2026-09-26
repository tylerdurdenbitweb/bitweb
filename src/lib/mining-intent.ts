/**
 * Persistent "the user wants mining ON" flag.
 *
 * Everything in-memory dies on boot, reload, tab restore and page
 * navigation - so the intent lives in localStorage under one tiny key.
 * It is written ONLY by the two manual actions: START sets it, STOP clears
 * it. Automation (boot auto-resume, gate-close retry) never writes it, so
 * auto-resume can never resurrect mining for someone who turned it off -
 * and mining that was paused by an update or killed by a reload comes back
 * without making the user press the button again (the iPhone complaint:
 * "updating finishes and I have to restart mining every time").
 *
 * Storage can be unavailable (private mode, disabled cookies): then the
 * intent simply does not persist and mining behaves exactly as before.
 */

const KEY = "btwb.mining";

function store(): Storage | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null; // accessing localStorage itself can throw (blocked cookies)
  }
}

/** True when the user's last manual mining action was START. */
export function getMiningIntent(): boolean {
  const s = store();
  if (!s) return false;
  try {
    return s.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

/** Record (true) or erase (false) the intent. Never throws. */
export function setMiningIntent(on: boolean): void {
  const s = store();
  if (!s) return;
  try {
    if (on) s.setItem(KEY, "1");
    else s.removeItem(KEY);
  } catch {
    /* quota/serialization - intent just does not persist */
  }
}
