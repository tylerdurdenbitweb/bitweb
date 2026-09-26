/**
 * IdbStorage - the browser's full-node database on IndexedDB.
 *
 * Object stores (spec-fixed names):
 *   blocks        keyPath height      - index hash
 *   transactions  keyPath txid        - indexes blockHeight / fromAddress / toAddress
 *   mempool       keyPath txid        - indexes fromAddress / toAddress / createdAt
 *   balances      keyPath address     (the account table: balance + nonce + blocksMined)
 *   wallet        keyPath id          (key custody mirror - private key never leaves)
 *   meta          keyPath key         (totalSupply, prunedBelow, ...)
 *   snapshots     keyPath height      (account-state snapshot every 1,000 blocks)
 *
 * Monetary values persist through the u64 string codec (storage.ts) so the
 * on-disk form never depends on float semantics.
 *
 * Transaction discipline: chain mutations run inside ONE readwrite IDB
 * transaction spanning the five chain stores. Between its `await`s the code
 * only performs synchronous computation, so the transaction stays alive from
 * first read to last write - a throw aborts everything, exactly like the
 * server version's MySQL transaction.
 */
import { CHAIN_ID, type PopAttestation } from "@contracts/protocol";
import {
  fromU64,
  toU64,
  type AccountRow,
  type BlockRow,
  type ChainStorage,
  type ChainStorageTx,
  type MempoolTxRow,
  type SnapshotRow,
  type TxRow,
} from "./storage";

const DB_NAME = `bitweb-${CHAIN_ID}`;
const DB_VERSION = 2; // v2 adds the "snapshots" store
const CHAIN_STORES = ["blocks", "transactions", "mempool", "balances", "meta", "snapshots"] as const;
type ChainStore = (typeof CHAIN_STORES)[number];

// -- on-disk shapes (u64-string monetary fields) -----------------------------
interface PopDisk {
  address: string;
  amount: string;
  index: number;
}
interface BlockDisk
  extends Omit<BlockRow, "reward" | "popTransfers" | "feesBurned" | "minerPeerId" | "popAttestations"> {
  reward: string;
  popTransfers?: PopDisk[]; // optional: rows written before the PoP era
  feesBurned?: string; // optional: rows written before fee burning
  minerPeerId?: string | null; // optional: rows written before attestations
  popAttestations?: PopAttestation[]; // optional: rows written before attestations
}
interface TxDisk extends Omit<TxRow, "amount" | "fee"> {
  amount: string;
  fee: string;
}
interface MempoolDisk extends Omit<MempoolTxRow, "amount" | "fee"> {
  amount: string;
  fee: string;
}
interface AccountDisk extends Omit<AccountRow, "balance"> {
  balance: string;
}
interface SnapshotDisk {
  height: number;
  blockHash: string;
  totalSupply: string;
  accounts: AccountDisk[];
}

const blockToDisk = (b: BlockRow): BlockDisk => ({
  ...b,
  reward: toU64(b.reward),
  feesBurned: toU64(b.feesBurned),
  popTransfers: b.popTransfers.map((p) => ({ ...p, amount: toU64(p.amount) })),
});
const blockFromDisk = (b: BlockDisk): BlockRow => ({
  ...b,
  reward: fromU64(b.reward),
  // pre-PoP / pre-attestation rows carry no such fields - normalize exactly
  feesBurned: fromU64(b.feesBurned ?? "0"),
  popTransfers: (b.popTransfers ?? []).map((p) => ({ ...p, amount: fromU64(p.amount) })),
  minerPeerId: b.minerPeerId ?? null,
  popAttestations: b.popAttestations ?? [],
});
const txToDisk = (t: TxRow): TxDisk => ({ ...t, amount: toU64(t.amount), fee: toU64(t.fee) });
const txFromDisk = (t: TxDisk): TxRow => ({ ...t, amount: fromU64(t.amount), fee: fromU64(t.fee) });
const mpToDisk = (t: MempoolTxRow): MempoolDisk => ({
  ...t,
  amount: toU64(t.amount),
  fee: toU64(t.fee),
});
const mpFromDisk = (t: MempoolDisk): MempoolTxRow => ({
  ...t,
  amount: fromU64(t.amount),
  fee: fromU64(t.fee),
});
const accToDisk = (a: AccountRow): AccountDisk => ({ ...a, balance: toU64(a.balance) });
const accFromDisk = (a: AccountDisk): AccountRow => ({ ...a, balance: fromU64(a.balance) });
const snapToDisk = (s: SnapshotRow): SnapshotDisk => ({
  height: s.height,
  blockHash: s.blockHash,
  totalSupply: toU64(s.totalSupply),
  accounts: s.accounts.map(accToDisk),
});
const snapFromDisk = (s: SnapshotDisk): SnapshotRow => ({
  height: s.height,
  blockHash: s.blockHash,
  totalSupply: fromU64(s.totalSupply),
  accounts: s.accounts.map(accFromDisk),
});

// -- low-level helpers -------------------------------------------------------

/**
 * Thrown when an IndexedDB request/transaction never settles. iOS Safari can
 * zombie a connection across a page freeze (screen lock, bfcache, app
 * switcher): the handle stays "open" but every request queues forever -
 * before this guard existed, a single stalled request froze a sync overlay
 * or a boot forever with zero diagnostics.
 */
export class IdbStallError extends Error {
  constructor() {
    super("indexeddb request never settled - zombie connection after page sleep");
    this.name = "IdbStallError";
  }
}

/**
 * Legit operations here are all sub-second, so the guard only needs to be
 * above the slowest honest read on the slowest supported phone - not an
 * order of magnitude above it. The old 15s budget was that generous: a
 * single zombie read froze the sync overlay for 15s, the heal-retry circus
 * behind it could pin the window for a minute, and an iPhone watching a
 * static overlay re-locks its screen mid-heal (a fresh zombie). 6s is still
 * far beyond any honest operation and cuts the worst-case freeze by more
 * than half.
 */
const IDB_STALL_MS = 6_000;

/**
 * Race an IDB promise against the stall timer; a stall poisons the owner.
 * Exported (with an injectable clock) so the zombie-connection guard is
 * testable without a real IndexedDB; production callers never pass stallMs.
 */
export function withStallGuard<T>(
  inner: Promise<T>,
  onStall?: () => void,
  stallMs: number = IDB_STALL_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      onStall?.();
      reject(new IdbStallError());
    }, stallMs);
    inner.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function req<T>(r: IDBRequest<T>, onStall?: () => void, stallMs?: number): Promise<T> {
  return withStallGuard(
    new Promise<T>((resolve, reject) => {
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error ?? new Error("indexeddb request failed"));
    }),
    onStall,
    stallMs,
  );
}

/**
 * Opening the database gets the same zombie protection as every other
 * request: an installed PWA cold-starting next to a frozen sibling context
 * can see indexedDB.open() queue FOREVER (no success, no error, no blocked)
 * - before this guard, that was the "OPENING NODE DATABASE" screen hanging
 * until the app was killed. A late-settling attempt is closed immediately
 * so an untracked connection never leaks past the guard.
 */
const OPEN_STALL_MS = 10_000;
const OPEN_ATTEMPTS = 3;

function openDb(stallMs: number, onStall: () => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      onStall();
      reject(new IdbStallError());
    }, stallMs);
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains("blocks")) {
        const blocks = db.createObjectStore("blocks", { keyPath: "height" });
        blocks.createIndex("hash", "hash", { unique: true });
        const txs = db.createObjectStore("transactions", { keyPath: "txid" });
        txs.createIndex("blockHeight", "blockHeight");
        txs.createIndex("fromAddress", "fromAddress");
        txs.createIndex("toAddress", "toAddress");
        const mp = db.createObjectStore("mempool", { keyPath: "txid" });
        mp.createIndex("fromAddress", "fromAddress");
        mp.createIndex("toAddress", "toAddress");
        mp.createIndex("createdAt", "createdAt");
        db.createObjectStore("balances", { keyPath: "address" });
        db.createObjectStore("wallet", { keyPath: "id" });
        db.createObjectStore("meta", { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains("snapshots")) {
        db.createObjectStore("snapshots", { keyPath: "height" }); // v2
      }
    };
    r.onsuccess = () => {
      if (settled) {
        // the stall guard already abandoned this attempt - never leak the
        // late connection (untracked, it would block future version changes)
        try {
          r.result.close();
        } catch {
          /* already gone */
        }
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(r.result);
    };
    r.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(r.error ?? new Error("indexeddb open failed"));
    };
    r.onblocked = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error("indexeddb blocked by another tab version"));
    };
  });
}

/**
 * A stalled open means the request is frozen inside a dead context - it can
 * never be cancelled, so the recovery is a FRESH open call, a few times,
 * before the boot gives up and falls back to memory-only mode.
 */
async function openDbWithRetry(
  onStall: () => void,
  stallMs: number,
  attempts: number,
): Promise<IDBDatabase> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await openDb(stallMs, onStall);
    } catch (err) {
      if (!(err instanceof IdbStallError) || attempt >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 400));
    }
  }
}

/** Read-only helpers bound to any transaction-ish handle. */
function readsFrom(get: (store: ChainStore) => IDBObjectStore, onStall?: () => void, stallMs?: number) {
  const reqS = <T,>(r: IDBRequest<T>): Promise<T> => req(r, onStall, stallMs);
  const mpAll = async (): Promise<MempoolTxRow[]> => {
    const rows = (await reqS(get("mempool").getAll())) as MempoolDisk[];
    return rows
      .map(mpFromDisk)
      .sort((a, b) => a.createdAt - b.createdAt || a.txid.localeCompare(b.txid));
  };
  const blocksDesc = (limit: number): Promise<BlockRow[]> =>
    withStallGuard(
      new Promise<BlockRow[]>((resolve, reject) => {
        const out: BlockRow[] = [];
        const c = get("blocks").openCursor(null, "prev");
        c.onerror = () => reject(c.error);
        c.onsuccess = () => {
          const cur = c.result;
          if (!cur || out.length >= limit) return resolve(out);
          out.push(blockFromDisk(cur.value as BlockDisk));
          cur.continue();
        };
      }),
      onStall,
      stallMs,
    );
  return {
    async blockCount() {
      return reqS(get("blocks").count());
    },
    async tip() {
      const rows = await blocksDesc(1);
      return rows[0];
    },
    async blockAt(height: number) {
      const b = (await reqS(get("blocks").get(height))) as BlockDisk | undefined;
      return b ? blockFromDisk(b) : undefined;
    },
    async recentBlocks(limit: number) {
      return blocksDesc(Math.min(limit, 100));
    },
    async lastBlockTimestamps(limit: number) {
      return (await blocksDesc(limit)).map((b) => b.timestamp);
    },
    async hashrateWindow(limit: number) {
      return (await blocksDesc(limit)).map((b) => ({
        height: b.height,
        timestamp: b.timestamp,
        difficulty: b.difficulty,
      }));
    },
    async txByTxid(txid: string) {
      const t = (await reqS(get("transactions").get(txid))) as TxDisk | undefined;
      return t ? txFromDisk(t) : undefined;
    },
    async txsInBlock(height: number) {
      const rows = (await reqS(
        get("transactions").index("blockHeight").getAll(IDBKeyRange.only(height)),
      )) as TxDisk[];
      return rows
        .map(txFromDisk)
        .sort((a, b) => a.txIndex - b.txIndex || a.txid.localeCompare(b.txid));
    },
    async confirmedCount() {
      return reqS(get("transactions").count());
    },
    async recentTxs(limit: number) {
      const cap = Math.min(limit, 100);
      const out: TxRow[] = [];
      await withStallGuard(
        new Promise<void>((resolve, reject) => {
          const c = get("transactions").index("blockHeight").openCursor(null, "prev");
          c.onerror = () => reject(c.error);
          c.onsuccess = () => {
            const cur = c.result;
            if (!cur || out.length >= cap) return resolve();
            out.push(txFromDisk(cur.value as TxDisk));
            cur.continue();
          };
        }),
        onStall,
        stallMs,
      );
      return out.sort(
        (a, b) => b.blockHeight - a.blockHeight || b.timestamp - a.timestamp,
      );
    },
    async txHistoryFor(address: string, limit: number) {
      const [out, inc] = await Promise.all([
        reqS(get("transactions").index("fromAddress").getAll(IDBKeyRange.only(address))),
        reqS(get("transactions").index("toAddress").getAll(IDBKeyRange.only(address))),
      ]);
      const seen = new Map<string, TxRow>();
      for (const raw of [...out, ...inc] as TxDisk[]) {
        const t = txFromDisk(raw);
        seen.set(t.txid, t);
      }
      return [...seen.values()]
        .sort((a, b) => b.timestamp - a.timestamp || b.txid.localeCompare(a.txid))
        .slice(0, limit);
    },
    async mempoolTxByTxid(txid: string) {
      const t = (await reqS(get("mempool").get(txid))) as MempoolDisk | undefined;
      return t ? mpFromDisk(t) : undefined;
    },
    mempool: mpAll,
    async mempoolFrom(from: string) {
      return (await mpAll()).filter((t) => t.fromAddress === from);
    },
    async mempoolForAddress(address: string) {
      return (await mpAll()).filter(
        (t) => t.fromAddress === address || t.toAddress === address,
      );
    },
    async mempoolCount() {
      return reqS(get("mempool").count());
    },
    async account(address: string) {
      const a = (await reqS(get("balances").get(address))) as AccountDisk | undefined;
      return a ? accFromDisk(a) : undefined;
    },
    async activeAccountCount() {
      const all = (await reqS(get("balances").getAll())) as AccountDisk[];
      return all.filter((a) => fromU64(a.balance) > 0).length;
    },
    async allAccounts() {
      const all = (await reqS(get("balances").getAll())) as AccountDisk[];
      return all.map(accFromDisk);
    },
    async latestSnapshot() {
      const keys = (await reqS(get("snapshots").getAllKeys())) as number[];
      if (keys.length === 0) return undefined;
      const top = Math.max(...keys);
      const snap = (await reqS(get("snapshots").get(top))) as SnapshotDisk | undefined;
      return snap ? snapFromDisk(snap) : undefined;
    },
    async getMeta(key: string) {
      const row = (await reqS(get("meta").get(key))) as { key: string; value: string } | undefined;
      return row?.value;
    },
  };
}

type Reads = ReturnType<typeof readsFrom>;

export class IdbStorage implements ChainStorage {
  private db: IDBDatabase | null = null;
  private reads: Reads | null = null;
  /** Test hooks - production boots never pass these. */
  private readonly openStallMs: number;
  private readonly openAttempts: number;
  private readonly stallMs: number;

  constructor(opts: { openStallMs?: number; openAttempts?: number; stallMs?: number } = {}) {
    this.openStallMs = opts.openStallMs ?? OPEN_STALL_MS;
    this.openAttempts = opts.openAttempts ?? OPEN_ATTEMPTS;
    this.stallMs = opts.stallMs ?? IDB_STALL_MS;
  }
  /**
   * Set by any stalled request (see IdbStallError) or by reopen(): the
   * connection is considered a zombie and the next operation reopens it
   * before touching IndexedDB again.
   */
  private poisoned = false;
  /** Single-flight lock so concurrent callers share one reopen. */
  private reopening: Promise<void> | null = null;

  private onStall = (): void => {
    this.poisoned = true;
  };

  async open(): Promise<void> {
    await this.ensureOpen();
  }

  /**
   * Proactively reopen the connection (called on the wake path). IDB
   * close() is graceful - in-flight transactions settle or their stall
   * guards reject them - so this never corrupts or loses data.
   */
  async reopen(): Promise<void> {
    this.poisoned = true;
    await this.ensureOpen();
  }

  private async ensureOpen(): Promise<void> {
    if (this.db && !this.poisoned) return;
    if (this.reopening) return this.reopening;
    this.reopening = (async () => {
      try {
        const old = this.db;
        this.db = null;
        this.reads = null;
        try {
          old?.close();
        } catch {
          /* already gone */
        }
        const db = await openDbWithRetry(this.onStall, this.openStallMs, this.openAttempts);
        // Another tab upgrading the schema must not deadlock us: poison and
        // close - the next operation reopens on the new version by itself.
        db.onversionchange = () => {
          this.poisoned = true;
          try {
            db.close();
          } catch {
            /* already closed */
          }
        };
        this.db = db;
        this.reads = readsFrom(
          (store) => db.transaction(store, "readonly").objectStore(store),
          this.onStall,
          this.stallMs,
        );
        this.poisoned = false;
      } finally {
        this.reopening = null;
      }
    })();
    return this.reopening;
  }

  private async ro(): Promise<Reads> {
    await this.ensureOpen();
    if (!this.reads) throw new Error("IdbStorage not open");
    return this.reads;
  }

  /**
   * Zombie self-healing for pure operations (reads, wallet lookups): when a
   * request dies unsettled, the stall guard has already poisoned the
   * connection - reopen and run the SAME operation once more instead of
   * letting one frozen request kill a boot or a sync. Writes in chain
   * transactions are NOT retried here: a partially-applied transaction
   * cannot be replayed blindly, so transact() surfaces the stall and the
   * caller's own retry semantics (e.g. the sync gate's in-burst retry)
   * take over on the now-healthy connection.
   */
  private async healAndRetry<T>(op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (err) {
      if (!(err instanceof IdbStallError)) throw err;
      await this.reopen();
      return op();
    }
  }

  blockCount = async () => this.healAndRetry(async () => (await this.ro()).blockCount());
  tip = async () => this.healAndRetry(async () => (await this.ro()).tip());
  blockAt = async (h: number) => this.healAndRetry(async () => (await this.ro()).blockAt(h));
  recentBlocks = async (l: number) => this.healAndRetry(async () => (await this.ro()).recentBlocks(l));
  lastBlockTimestamps = async (l: number) => this.healAndRetry(async () => (await this.ro()).lastBlockTimestamps(l));
  hashrateWindow = async (l: number) => this.healAndRetry(async () => (await this.ro()).hashrateWindow(l));
  txByTxid = async (t: string) => this.healAndRetry(async () => (await this.ro()).txByTxid(t));
  txsInBlock = async (h: number) => this.healAndRetry(async () => (await this.ro()).txsInBlock(h));
  confirmedCount = async () => this.healAndRetry(async () => (await this.ro()).confirmedCount());
  recentTxs = async (l: number) => this.healAndRetry(async () => (await this.ro()).recentTxs(l));
  txHistoryFor = async (a: string, l: number) => this.healAndRetry(async () => (await this.ro()).txHistoryFor(a, l));
  mempoolTxByTxid = async (t: string) => this.healAndRetry(async () => (await this.ro()).mempoolTxByTxid(t));
  mempool = async () => this.healAndRetry(async () => (await this.ro()).mempool());
  mempoolFrom = async (f: string) => this.healAndRetry(async () => (await this.ro()).mempoolFrom(f));
  mempoolForAddress = async (a: string) => this.healAndRetry(async () => (await this.ro()).mempoolForAddress(a));
  mempoolCount = async () => this.healAndRetry(async () => (await this.ro()).mempoolCount());
  account = async (a: string) => this.healAndRetry(async () => (await this.ro()).account(a));
  activeAccountCount = async () => this.healAndRetry(async () => (await this.ro()).activeAccountCount());
  allAccounts = async () => this.healAndRetry(async () => (await this.ro()).allAccounts());
  latestSnapshot = async () => this.healAndRetry(async () => (await this.ro()).latestSnapshot());
  getMeta = async (k: string) => this.healAndRetry(async () => (await this.ro()).getMeta(k));

  async transact<T>(fn: (tx: ChainStorageTx) => Promise<T>): Promise<T> {
    await this.ensureOpen();
    if (!this.db) throw new Error("IdbStorage not open");
    const reqS = <R,>(r: IDBRequest<R>): Promise<R> => req(r, this.onStall, this.stallMs);
    const idbTx = this.db.transaction([...CHAIN_STORES], "readwrite");
    const store = (s: ChainStore) => idbTx.objectStore(s);
    const reads = readsFrom(store, this.onStall, this.stallMs);
    const tx: ChainStorageTx = {
      ...reads,
      async putBlock(b) {
        await reqS(store("blocks").put(blockToDisk(b)));
      },
      async putTx(t) {
        await reqS(store("transactions").put(txToDisk(t)));
      },
      async putMempoolTx(t) {
        await reqS(store("mempool").put(mpToDisk(t)));
      },
      async deleteMempoolTx(txid) {
        await reqS(store("mempool").delete(txid));
      },
      async purgeMempoolSuperseded(from, nonce) {
        const rows = (await reqS(
          store("mempool").index("fromAddress").getAll(IDBKeyRange.only(from)),
        )) as MempoolDisk[];
        for (const row of rows) {
          if (row.nonce <= nonce) await reqS(store("mempool").delete(row.txid));
        }
      },
      async deleteTxsInBlock(height) {
        const rows = (await reqS(
          store("transactions").index("blockHeight").getAllKeys(IDBKeyRange.only(height)),
        )) as string[];
        for (const key of rows) await reqS(store("transactions").delete(key));
      },
      async deleteBlock(height) {
        await reqS(store("blocks").delete(height));
      },
      async putAccount(acc) {
        await reqS(store("balances").put(accToDisk(acc)));
      },
      async putSnapshot(snap) {
        await reqS(store("snapshots").put(snapToDisk(snap)));
      },
      async setMeta(key, value) {
        await reqS(store("meta").put({ key, value }));
      },
    };
    const done = withStallGuard(
      new Promise<void>((resolve, reject) => {
        idbTx.oncomplete = () => resolve();
        idbTx.onabort = () => reject(idbTx.error ?? new Error("chain transaction aborted"));
      }),
      this.onStall,
      this.stallMs,
    );
    done.catch(() => undefined); // pre-attach: rejection is handled below
    try {
      const result = await fn(tx);
      await done; // durable commit before returning
      return result;
    } catch (err) {
      try {
        idbTx.abort(); // undo every request made so far
      } catch {
        /* transaction already finished */
      }
      try {
        await done;
      } catch {
        /* the abort rejection - expected here */
      }
      throw err;
    }
  }

  async deleteAll(): Promise<void> {
    await this.ensureOpen();
    if (!this.db) throw new Error("IdbStorage not open");
    const idbTx = this.db.transaction([...CHAIN_STORES], "readwrite");
    for (const s of CHAIN_STORES) idbTx.objectStore(s).clear();
    await withStallGuard(
      new Promise<void>((resolve, reject) => {
        idbTx.oncomplete = () => resolve();
        idbTx.onerror = () => reject(idbTx.error);
        idbTx.onabort = () => reject(idbTx.error ?? new Error("deleteAll aborted"));
      }),
      this.onStall,
      this.stallMs,
    );
  }

  // -- wallet store (outside chain transactions) ----------------------------
  // The wallet row is read during boot hydration: a zombie stall here used
  // to surface as a fatal NODE BOOT FAILURE. These are single-request
  // idempotent operations (get / put of the same value / delete), so the
  // heal-and-retry path is safe for all three.
  async walletGet(id: string): Promise<{ id: string; privHex: string } | undefined> {
    return this.healAndRetry(async () => {
      await this.ensureOpen();
      if (!this.db) throw new Error("IdbStorage not open");
      return (await req(
        this.db.transaction("wallet", "readonly").objectStore("wallet").get(id),
        this.onStall,
        this.stallMs,
      )) as { id: string; privHex: string } | undefined;
    });
  }

  async walletPut(privHex: string): Promise<void> {
    return this.healAndRetry(async () => {
      await this.ensureOpen();
      if (!this.db) throw new Error("IdbStorage not open");
      await req(
        this.db.transaction("wallet", "readwrite").objectStore("wallet").put({ id: "main", privHex }),
        this.onStall,
        this.stallMs,
      );
    });
  }

  async walletClear(): Promise<void> {
    return this.healAndRetry(async () => {
      await this.ensureOpen();
      if (!this.db) throw new Error("IdbStorage not open");
      await req(
        this.db.transaction("wallet", "readwrite").objectStore("wallet").delete("main"),
        this.onStall,
        this.stallMs,
      );
    });
  }
}
