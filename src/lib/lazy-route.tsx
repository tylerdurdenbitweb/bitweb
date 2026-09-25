/**
 * Defensive React.lazy for route chunks.
 *
 * Vite's loader already turns a 404'd chunk into a rejection (which the
 * entrypoint's vite:preloadError listener recovers from). Safari adds a
 * quieter failure: an interrupted or cache-corrupted fetch can RESOLVE as
 * an empty module namespace, and React.lazy then crashes reading `.default`
 * off it - the "MODULE CRASH / undefined is not an object" screen. This
 * wrapper validates the namespace BEFORE React sees it: a chunk without its
 * default export means the asset layer is stale, so it routes through the
 * same guarded one-shot reload as a chunk 404. If the reload was already
 * spent this session, a descriptive error reaches the route boundary
 * instead of an infinite reload loop.
 */
import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import { recoverStaleChunk, staleChunkRecoverySpent } from "./chunk-recovery";

export async function loadRouteChunk<T extends ComponentType<unknown>>(
  loader: () => Promise<{ default: T }>,
): Promise<{ default: T }> {
  const m = await loader();
  if (!m || typeof m.default !== "function") {
    if (!staleChunkRecoverySpent()) {
      recoverStaleChunk("lazy route chunk resolved without a default export");
      // the page is reloading - never let React commit the broken chunk
      return new Promise<{ default: T }>(() => {});
    }
    throw new Error("lazy route chunk resolved without a default export");
  }
  return m;
}

export function lazyRoute<T extends ComponentType<unknown>>(
  loader: () => Promise<{ default: T }>,
): LazyExoticComponent<T> {
  return lazy(() => loadRouteChunk(loader));
}
