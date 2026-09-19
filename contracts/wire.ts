/**
 * BitWeb P2P wire protocol - browser edition.
 *
 * Nodes are browser tabs; the wire is WebRTC DataChannels (signaled through
 * the rendezvous configured in network.config.ts) or, for same-machine tabs
 * and the test suite, a BroadcastChannel. Every payload is fully validated
 * on receipt: a peer that sends invalid data has its strike counter bumped
 * and is dropped after MAX_PEER_FAILURES strikes. Nothing is ever trusted.
 *
 * Privacy: the wire carries chain data only. No fingerprints, no metadata
 * beyond the random peer id a tab announced itself with.
 */

// Single source of truth for the chain id lives in protocol.ts; the wire
// layer re-exports it so peers and consensus never drift apart.
export { CHAIN_ID } from "./protocol";
export const P2P_VERSION = 2;
export const NODE_AGENT = "bitweb-web-mainnet/2.0";

/** Blocks served per `blocks` message. */
export const P2P_BLOCK_BATCH = 16;
/** Deepest reorg a node will follow automatically. Deeper = manual review. */
export const MAX_REORG_DEPTH = 32;
/** Peer is dropped after this many protocol violations. */
import type { PopAttestation } from "@contracts/protocol";

export const MAX_PEER_FAILURES = 3;
/** Max simultaneous peer connections (spec cap). */
export const MAX_PEERS = 32;
/** Heartbeat interval - every peer gets a ping this often. */
export const HEARTBEAT_MS = 30_000;
/** Consecutive missed pongs before a peer is dropped. */
export const HEARTBEAT_MAX_MISSES = 3;
/**
 * Sybil resistance: right after the hello, each side sends the other a
 * random challenge nonce; the answer is valid when
 * dsha256("{nonce}:{solution}") starts with this many zero hex chars
 * (~65k double-SHA-256 evaluations - seconds of CPU, nothing to a honest
 * tab, expensive at connection-flood scale). A peer that does not answer
 * correctly within SYBIL_CHALLENGE_TIMEOUT_MS is dropped; data messages
 * from an unverified peer earn strikes.
 */
export const SYBIL_CHALLENGE_PREFIX = "0000";
/** Time a fresh peer gets to solve the handshake challenge. */
export const SYBIL_CHALLENGE_TIMEOUT_MS = 30_000;

/** Handshake. Peers with a different chainId or genesisHash are not us. */
export interface WireHello {
  chainId: string;
  p2pVersion: number;
  agent: string;
  genesisHash: string;
  height: number;
  tipHash: string;
  serverTime: number;
  /**
   * The sender's canonical PoP node id (its primary transport id). Peers
   * target THIS id when signing PoP attestations for this node; when this
   * node mines, the same id appears in the block as miner_peer_id so every
   * validator can recompute the attestation preimages. null = offline/solo.
   */
  nodeId?: string | null;
}

export interface WireTx {
  txid: string;
  type: "coinbase" | "transfer";
  fromAddress: string | null;
  toAddress: string;
  amount: number;
  fee: number;
  nonce: number | null;
  pubkey: string | null;
  signature: string | null;
  timestamp: number;
}

export interface WireBlock {
  height: number;
  hash: string;
  prevHash: string;
  merkleRoot: string;
  timestamp: number;
  nonce: number;
  target: string;
  miner: string;
  message: string | null;
  txs: WireTx[]; // [coinbase, ...transfers] in block order
  /**
   * PoP credits for this block: the 20% peer pool split equally. Their ids
   * (BTWBPOP1|height|index|to|amount) commit to the merkle root between the
   * coinbase id and the transfer ids. Absent on pre-PoP blocks = empty.
   */
  popTransfers?: Array<{ address: string; amount: number; index: number }>;
  /**
   * The miner's canonical PoP node id - the attestation target. null when a
   * solo miner has no transport identity (the peer pool simply burns).
   */
  minerPeerId?: string | null;
  /**
   * Peer-signed attestations backing every popTransfer above. Validation:
   * each signature must verify over the canonical preimage, the address set
   * must match the popTransfer set EXACTLY, and timestamps must sit within
   * POP_ATTEST_MAX_AGE_S of the block timestamp. Absent on old blocks = [].
   */
  popAttestations?: PopAttestation[];
}

// -- message envelope --------------------------------------------------------
// One JSON object per DataChannel message. `getBlocks`/`blocks` are the sync
// pair; `block`/`tx` are gossip; `peers` is peer exchange; ping/pong the
// heartbeat. Everything else is ignored (forward-compatible).
export type WireMessage =
  | { type: "hello"; hello: WireHello }
  | { type: "getBlocks"; from: number; count: number }
  | { type: "blocks"; blocks: WireBlock[] }
  | { type: "block"; block: WireBlock }
  | { type: "tx"; tx: WireTx }
  | { type: "peers"; ids: string[] }
  | { type: "challenge"; nonce: string }
  | { type: "challengeResponse"; nonce: string; solution: string }
  | { type: "pop_attestation"; attestation: PopAttestation }
  | { type: "ping"; t: number }
  | { type: "pong"; t: number };

/**
 * Transport hygiene, NOT consensus: any single wire message larger than this
 * is discarded unread. A full 16-block sync batch with packed txs and PoP
 * attestations is ~0.3 MB - 1 MiB leaves 3x headroom while capping the
 * memory/CPU a hostile peer can make us spend on JSON.parse per message.
 */
export const MAX_WIRE_MESSAGE_BYTES = 1 << 20; // 1 MiB

export function encodeMessage(m: WireMessage): string {
  return JSON.stringify(m);
}

/** Parse without trusting: unknown or oversized shapes come back as null, never throw. */
export function decodeMessage(raw: unknown): WireMessage | null {
  if (typeof raw !== "string") return null;
  if (raw.length > MAX_WIRE_MESSAGE_BYTES) return null; // flood control - drop unread
  try {
    const m = JSON.parse(raw) as { type?: unknown };
    if (m && typeof m === "object" && typeof m.type === "string") {
      return m as WireMessage;
    }
    return null;
  } catch {
    return null;
  }
}
