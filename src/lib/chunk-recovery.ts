/**
 * Deploy-race / broken-chunk recovery, shared by the entrypoint's global
 * listeners and the lazy-route validator.
 *
 * Every release ships freshly hashed asset names and a static host serves
 * only the NEW set - a tab still holding the previous index.html 404s its
 * chunks on the next load. Safari adds a second failure shape: an
 * interrupted fetch can resolve as an EMPTY module namespace (no default
 * export), which React.lazy turns into "undefined is not an object
 * (evaluating 'E.result.default')" inside its own payload read. Both shapes
 * mean the same thing: the asset layer under this tab is stale. The fix is
 * one guarded hard reload onto the fresh shell; a sessionStorage flag caps
 * it at a single attempt per tab session so a genuinely broken deploy
 * cannot loop forever.
 */
const RELOAD_FLAG = "btwb-stale-chunk-reload";

/**
 * In-memory shadow of the guard flag. sessionStorage can be unavailable
 * (private mode, locked-down embedder) or wiped between page loads; without
 * this shadow, such an environment would have NO loop protection at all -
 * a genuinely broken deploy would reload forever. The shadow lives exactly
 * as long as the JS realm, which is the span the guard exists for.
 */
let memoryFlag = false;

function flagGet(): boolean {
  if (memoryFlag) return true;
  try {
    return sessionStorage.getItem(RELOAD_FLAG) !== null;
  } catch {
    return false; // storage blocked - the memory shadow still protects us
  }
}

function flagSet(): void {
  memoryFlag = true;
  try {
    sessionStorage.setItem(RELOAD_FLAG, "1");
  } catch {
    /* storage blocked - the memory shadow carries the guard */
  }
}

/** True when this tab session already spent its one recovery reload. */
export function staleChunkRecoverySpent(): boolean {
  return flagGet();
}

/**
 * One guarded hard reload onto the fresh deployment. No-ops when the guard
 * is spent. Environment-safe: outside a browser (tests) it only records the
 * flag attempt and returns.
 */
export function recoverStaleChunk(reason: unknown): void {
  console.warn("[boot] asset trouble after deploy - reloading onto the fresh shell:", reason);
  if (flagGet()) return;
  flagSet();
  if (typeof location !== "undefined") location.reload();
}

/** Test hook: a fresh realm starts with the guard unspent. */
export function __resetStaleChunkGuardForTests(): void {
  memoryFlag = false;
}

/** A healthy boot clears the guard after a settling window, so a deploy
 * days later still gets its one recovery reload. */
export function clearStaleChunkGuardSoon(delayMs = 20_000): void {
  setTimeout(() => {
    memoryFlag = false;
    try {
      sessionStorage.removeItem(RELOAD_FLAG);
    } catch {
      /* storage blocked - nothing to clear */
    }
  }, delayMs);
}
