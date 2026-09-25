/**
 * Pure view-model helpers for the Dashboard page - no React, no node handle,
 * so the mapping logic is unit-testable in a plain node environment.
 */
import type { PeerView } from "@/node/p2p";
import type { BlockRow, TxRow } from "@/node/storage";

/**
 * Confirmed transactions grouped by the block that included them, each group
 * kept in canonical block order (txIndex ascending). The dashboard renders a
 * block's contents from this map; a block whose txs fall outside the fetched
 * recent window simply has no entry (the UI says so instead of guessing).
 */
export function txsByBlock(txs: readonly TxRow[]): Map<number, TxRow[]> {
  const map = new Map<number, TxRow[]>();
  for (const tx of txs) {
    const bucket = map.get(tx.blockHeight);
    if (bucket) bucket.push(tx);
    else map.set(tx.blockHeight, [tx]);
  }
  for (const bucket of map.values()) bucket.sort((a, b) => a.txIndex - b.txIndex);
  return map;
}

/**
 * Peer rows, best first: most recently seen link at the top, ties broken by
 * the longer-lived connection (a stable peer outranks a flapping one).
 * Never mutates the engine's array.
 */
export function sortPeers(peers: readonly PeerView[]): PeerView[] {
  return [...peers].sort(
    (a, b) => b.lastSeen - a.lastSeen || a.connectedAt - b.connectedAt,
  );
}

/**
 * One-word link condition from the lastSeen lag. "live" links answer within
 * two gossip cycles; past 45s the engine is already probing; past 2min the
 * row is about to drop. Thresholds are display-only - the engine owns all
 * real timeout decisions.
 */
export type LinkHealth = "live" | "quiet" | "stale";

export function linkHealth(peer: Pick<PeerView, "lastSeen">, nowMs: number): LinkHealth {
  const lag = nowMs - peer.lastSeen;
  if (lag <= 45_000) return "live";
  if (lag <= 120_000) return "quiet";
  return "stale";
}

/**
 * Aggregate fee/burn totals for a block's contents footer. Coinbase and pop
 * rows pay no fee, so the sum is exactly the transfer fees the block burned.
 */
export function blockFeeTotals(txs: readonly TxRow[]): { fees: number; transfers: number } {
  let fees = 0;
  let transfers = 0;
  for (const tx of txs) {
    fees += tx.fee;
    if (tx.type === "transfer") transfers += 1;
  }
  return { fees, transfers };
}

/** Whether a recent-blocks row has its contents inside the fetched tx window. */
export function blockContentsAvailable(block: BlockRow, txs: Map<number, TxRow[]>): boolean {
  return block.txCount === 0 || txs.has(block.height);
}
