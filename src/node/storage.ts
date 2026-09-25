/**
 * Chain storage - adapter interface + in-memory implementation.
 *
 * The chain state machine (chain.ts) never touches IndexedDB directly; it
 * speaks to this interface. Two adapters exist:
 *   - MemoryStorage - for unit tests and the two-tab BroadcastChannel sim
 *   - IdbStorage    - the real browser persistence (idb.ts)
 *
 * All mutation happens inside `transact`, which must be atomic: either the
 * whole callback commits or nothing does (the memory adapter snapshots and
 * rolls back; the IDB adapter uses a real readwrite transaction).
 */

// -- row shapes --------------------------------------------------------------
import type { PopAttestation } from "@contracts/protocol";

/** One Proof-of-Participation credit: a share of the block's 20% peer pool. */
export interface PopTransfer {
  address: string;
  amount: number;
  index: number; // position inside the block's popTransfers array (0-based)
}

export interface BlockRow {
  height: number;
  hash: string;
  prevHash: string;
  merkleRoot: string;
  timestamp: number;
  nonce: number;
  target: string;
  difficulty: number;
  reward: number; // the miner's 70% coinbase share (subsidy only - fees burn)
  txCount: number;
  miner: string;
  message: string | null;
  popTransfers: PopTransfer[]; // the 20% peer-pool credits ([] before PoP era)
  feesBurned: number; // total transfer fees destroyed by this block
  /**
   * The miner's canonical PoP node id - the target every attestation below
   * was signed for (null for solo/offline miners and pre-attestation rows).
   */
  minerPeerId: string | null;
  /**
   * The peer-signed attestations backing popTransfers, stored so this node
   * can serve full validation data to syncing peers ([] on old rows).
   */
  popAttestations: PopAttestation[];
}

/** A confirmed transaction (lives in the `transactions` store). */
export interface TxRow {
  txid: string;
  blockHeight: number;
  type: "coinbase" | "transfer" | "pop";
  fromAddress: string | null;
  toAddress: string;
  amount: number;
  fee: number;
  nonce: number | null;
  txIndex: number;
  pubkey: string | null;
  signature: string | null;
  timestamp: number;
}

/** A pending transfer (lives in the `mempool` store). */
export interface MempoolTxRow {
  txid: string;
  type: "transfer";
  fromAddress: string;
  toAddress: string;
  amount: number;
  fee: number;
  nonce: number;
  pubkey: string;
  signature: string;
  timestamp: number;
  createdAt: number; // ms - admission order
}

export interface AccountRow {
  address: string;
  balance: number;
  nonce: number;
  blocksMined: number;
}

/**
 * A full account-state snapshot, written every SNAPSHOT_INTERVAL blocks.
 * Snapshots are a LOCAL fast path only: they let boot recovery restore the
 * derived balances table without replaying the whole chain. They are never
 * gossiped - trusting a remote snapshot would be trusting unverifiable state.
 */
export interface SnapshotRow {
  height: number;
  blockHash: string;
  totalSupply: number;
  accounts: AccountRow[];
}

// -- u64 codec (the "BigInt wrapper") ----------------------------------------
// Every monetary value is a non-negative integer bounded by SOFT_CAP_SUPPLY
// (2.1e15 base units < 2^53), so `number` is exact. On disk the values are
// marshalled as decimal strings: the wire/DB representation never depends on
// float semantics, and a future migration to BigInt is a one-line change in
// these two functions instead of a schema break.
export function toU64(n: number): string {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`u64 out of range: ${n}`);
  return String(n);
}

export function fromU64(s: string): number {
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < 0 || String(n) !== s) {
    throw new Error(`corrupt u64 in storage: ${s}`);
  }
  return n;
}

// -- the adapter contract ----------------------------------------------------
/** Every read operation - shared by the plain adapter and the in-tx view. */
export interface ChainStorageReader {
  // blocks
  blockCount(): Promise<number>;
  tip(): Promise<BlockRow | undefined>;
  blockAt(height: number): Promise<BlockRow | undefined>;
  recentBlocks(limit: number): Promise<BlockRow[]>;
  /** Timestamps of the `limit` most recent blocks, tip-first. */
  lastBlockTimestamps(limit: number): Promise<number[]>;
  /** Sliding window for hashrate: `limit` most recent blocks, tip-first. */
  hashrateWindow(
    limit: number,
  ): Promise<Array<{ height: number; timestamp: number; difficulty: number }>>;

  // confirmed transactions
  txByTxid(txid: string): Promise<TxRow | undefined>;
  txsInBlock(height: number): Promise<TxRow[]>; // ordered by txIndex, txid
  confirmedCount(): Promise<number>;
  recentTxs(limit: number): Promise<TxRow[]>;
  txHistoryFor(address: string, limit: number): Promise<TxRow[]>;

  // mempool
  mempoolTxByTxid(txid: string): Promise<MempoolTxRow | undefined>;
  mempool(): Promise<MempoolTxRow[]>; // ordered by createdAt, txid
  mempoolFrom(from: string): Promise<MempoolTxRow[]>;
  mempoolForAddress(address: string): Promise<MempoolTxRow[]>;
  mempoolCount(): Promise<number>;

  // accounts ("balances" store)
  account(address: string): Promise<AccountRow | undefined>;
  activeAccountCount(): Promise<number>;
  /** Every account row - snapshot writes and the supply invariant check. */
  allAccounts(): Promise<AccountRow[]>;

  // snapshots
  /** The highest stored state snapshot, if any. */
  latestSnapshot(): Promise<SnapshotRow | undefined>;

  // meta
  getMeta(key: string): Promise<string | undefined>;
}

export interface ChainStorage extends ChainStorageReader {
  /** Atomic read-modify-write over ALL stores. Throws -> nothing persists. */
  transact<T>(fn: (tx: ChainStorageTx) => Promise<T>): Promise<T>;

  /** Wipe every store (protocol-epoch reset). */
  deleteAll(): Promise<void>;

  /**
   * Close and reopen the underlying connection. iOS Safari can zombie an
   * IndexedDB connection across a page freeze (requests then NEVER settle),
   * so the wake path calls this proactively; in-memory storages simply do
   * not implement it. Reopening never loses data - IDB close() is graceful.
   */
  reopen?(): Promise<void>;
}

export interface ChainStorageTx extends ChainStorageReader {
  putBlock(b: BlockRow): Promise<void>;
  putTx(tx: TxRow): Promise<void>;
  putMempoolTx(tx: MempoolTxRow): Promise<void>;
  deleteMempoolTx(txid: string): Promise<void>;
  /** Delete pending rows from `from` with nonce <= `nonce` (superseded). */
  purgeMempoolSuperseded(from: string, nonce: number): Promise<void>;
  deleteTxsInBlock(height: number): Promise<void>;
  deleteBlock(height: number): Promise<void>;
  putAccount(acc: AccountRow): Promise<void>;
  putSnapshot(snap: SnapshotRow): Promise<void>;
  setMeta(key: string, value: string): Promise<void>;
}

// ===========================================================================
//  MEMORY ADAPTER - tests + BroadcastChannel simulation
// ===========================================================================

interface MemoryState {
  blocks: Map<number, BlockRow>;
  txs: Map<string, TxRow>;
  mempool: Map<string, MempoolTxRow>;
  accounts: Map<string, AccountRow>;
  snapshots: Map<number, SnapshotRow>;
  meta: Map<string, string>;
}

function cloneState(s: MemoryState): MemoryState {
  return {
    blocks: new Map(structuredClone([...s.blocks])),
    txs: new Map(structuredClone([...s.txs])),
    mempool: new Map(structuredClone([...s.mempool])),
    accounts: new Map(structuredClone([...s.accounts])),
    snapshots: new Map(structuredClone([...s.snapshots])),
    meta: new Map(structuredClone([...s.meta])),
  };
}

function stateView(s: MemoryState) {
  const blocksDesc = () => [...s.blocks.values()].sort((a, b) => b.height - a.height);
  const mempoolAsc = () =>
    [...s.mempool.values()].sort(
      (a, b) => a.createdAt - b.createdAt || a.txid.localeCompare(b.txid),
    );
  return {
    async blockCount() {
      return s.blocks.size;
    },
    async tip() {
      return blocksDesc()[0];
    },
    async blockAt(height: number) {
      return s.blocks.get(height);
    },
    async recentBlocks(limit: number) {
      return blocksDesc().slice(0, Math.min(limit, 100));
    },
    async lastBlockTimestamps(limit: number) {
      return blocksDesc()
        .slice(0, limit)
        .map((b) => b.timestamp);
    },
    async hashrateWindow(limit: number) {
      return blocksDesc()
        .slice(0, limit)
        .map((b) => ({ height: b.height, timestamp: b.timestamp, difficulty: b.difficulty }));
    },
    async txByTxid(txid: string) {
      return s.txs.get(txid);
    },
    async txsInBlock(height: number) {
      return [...s.txs.values()]
        .filter((t) => t.blockHeight === height)
        .sort((a, b) => a.txIndex - b.txIndex || a.txid.localeCompare(b.txid));
    },
    async confirmedCount() {
      return s.txs.size;
    },
    async recentTxs(limit: number) {
      return [...s.txs.values()]
        .sort((a, b) => b.blockHeight - a.blockHeight || b.timestamp - a.timestamp)
        .slice(0, Math.min(limit, 100));
    },
    async txHistoryFor(address: string, limit: number) {
      return [...s.txs.values()]
        .filter((t) => t.fromAddress === address || t.toAddress === address)
        .sort((a, b) => b.timestamp - a.timestamp || b.txid.localeCompare(a.txid))
        .slice(0, limit);
    },
    async mempoolTxByTxid(txid: string) {
      return s.mempool.get(txid);
    },
    async mempool() {
      return mempoolAsc();
    },
    async mempoolFrom(from: string) {
      return mempoolAsc().filter((t) => t.fromAddress === from);
    },
    async mempoolForAddress(address: string) {
      return mempoolAsc().filter(
        (t) => t.fromAddress === address || t.toAddress === address,
      );
    },
    async mempoolCount() {
      return s.mempool.size;
    },
    async account(address: string) {
      return s.accounts.get(address);
    },
    async activeAccountCount() {
      return [...s.accounts.values()].filter((a) => a.balance > 0).length;
    },
    async allAccounts() {
      return [...s.accounts.values()].map((a) => structuredClone(a));
    },
    async latestSnapshot() {
      const heights = [...s.snapshots.keys()].sort((a, b) => b - a);
      const snap = heights.length === 0 ? undefined : s.snapshots.get(heights[0]);
      return snap ? structuredClone(snap) : undefined;
    },
    async getMeta(key: string) {
      return s.meta.get(key);
    },
  };
}

export class MemoryStorage implements ChainStorage {
  private state: MemoryState = {
    blocks: new Map(),
    txs: new Map(),
    mempool: new Map(),
    accounts: new Map(),
    snapshots: new Map(),
    meta: new Map(),
  };

  private view = stateView(this.state);

  // reads delegate to the live view
  blockCount = () => this.view.blockCount();
  tip = () => this.view.tip();
  blockAt = (h: number) => this.view.blockAt(h);
  recentBlocks = (l: number) => this.view.recentBlocks(l);
  lastBlockTimestamps = (l: number) => this.view.lastBlockTimestamps(l);
  hashrateWindow = (l: number) => this.view.hashrateWindow(l);
  txByTxid = (t: string) => this.view.txByTxid(t);
  txsInBlock = (h: number) => this.view.txsInBlock(h);
  confirmedCount = () => this.view.confirmedCount();
  recentTxs = (l: number) => this.view.recentTxs(l);
  txHistoryFor = (a: string, l: number) => this.view.txHistoryFor(a, l);
  mempoolTxByTxid = (t: string) => this.view.mempoolTxByTxid(t);
  mempool = () => this.view.mempool();
  mempoolFrom = (f: string) => this.view.mempoolFrom(f);
  mempoolForAddress = (a: string) => this.view.mempoolForAddress(a);
  mempoolCount = () => this.view.mempoolCount();
  account = (a: string) => this.view.account(a);
  activeAccountCount = () => this.view.activeAccountCount();
  allAccounts = () => this.view.allAccounts();
  latestSnapshot = () => this.view.latestSnapshot();
  getMeta = (k: string) => this.view.getMeta(k);

  async transact<T>(fn: (tx: ChainStorageTx) => Promise<T>): Promise<T> {
    // optimistic: run against the live state, roll back on any throw
    const backup = cloneState(this.state);
    const s = this.state;
    const tx: ChainStorageTx = {
      ...stateView(s),
      async putBlock(b) {
        s.blocks.set(b.height, structuredClone(b));
      },
      async putTx(t) {
        s.txs.set(t.txid, structuredClone(t));
      },
      async putMempoolTx(t) {
        s.mempool.set(t.txid, structuredClone(t));
      },
      async deleteMempoolTx(txid) {
        s.mempool.delete(txid);
      },
      async purgeMempoolSuperseded(from, nonce) {
        for (const [id, t] of s.mempool) {
          if (t.fromAddress === from && t.nonce <= nonce) s.mempool.delete(id);
        }
      },
      async deleteTxsInBlock(height) {
        for (const [id, t] of s.txs) if (t.blockHeight === height) s.txs.delete(id);
      },
      async deleteBlock(height) {
        s.blocks.delete(height);
      },
      async putAccount(acc) {
        s.accounts.set(acc.address, structuredClone(acc));
      },
      async putSnapshot(snap) {
        s.snapshots.set(snap.height, structuredClone(snap));
      },
      async setMeta(key, value) {
        s.meta.set(key, value);
      },
    };
    try {
      return await fn(tx);
    } catch (err) {
      this.state = backup;
      this.view = stateView(this.state);
      throw err;
    }
  }

  async deleteAll(): Promise<void> {
    this.state = {
      blocks: new Map(),
      txs: new Map(),
      mempool: new Map(),
      accounts: new Map(),
      snapshots: new Map(),
      meta: new Map(),
    };
    this.view = stateView(this.state);
  }
}
