/**
 * Early-warning counters - session-scoped, in-memory only, never gossiped,
 * never persisted. They exist so the UI can SHOW an attack or a degradation
 * while it happens (stale-block storms, sync churn, peer collapses) instead
 * of failing silently. Monotonic within the tab's lifetime; a refresh resets
 * them, which is fine: they describe the CURRENT session's network weather.
 */
export interface NetStats {
  /** Gossiped blocks that did not extend our tip (stale / side-chain / orphan). */
  gossipStale: number;
  /** Gossiped blocks that failed validation (the peer earned a strike). */
  gossipRejected: number;
  /** Deep catch-up runs started (peer advertised a longer chain). */
  syncsStarted: number;
  /** Blocks rolled back during sync forks (bounded by MAX_REORG_DEPTH). */
  syncRollbacks: number;
  /** Deep forks repaired by a full validate-and-adopt resync from a peer. */
  syncDeepResyncs: number;
  /** Links closed for any reason (churn, timeouts, strikes, bans). */
  peerDrops: number;
}

const counters: NetStats = {
  gossipStale: 0,
  gossipRejected: 0,
  syncsStarted: 0,
  syncRollbacks: 0,
  syncDeepResyncs: 0,
  peerDrops: 0,
};

export function bumpStat(key: keyof NetStats, by = 1): void {
  counters[key] += by;
}

/** A snapshot copy - callers must never mutate the live counters. */
export function getNetStats(): NetStats {
  return { ...counters };
}
