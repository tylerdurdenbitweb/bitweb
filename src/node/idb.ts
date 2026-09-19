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
function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error("indexeddb request failed"));
  });
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
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
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error("indexeddb open failed"));
    r.onblocked = () => reject(new Error("indexeddb blocked by another tab version"));
  });
}

/** Read-only helpers bound to any transaction-ish handle. */
function readsFrom(get: (store: ChainStore) => IDBObjectStore) {
  const mpAll = async (): Promise<MempoolTxRow[]> => {
    const rows = (await req(get("mempool").getAll())) as MempoolDisk[];
    return rows
      .map(mpFromDisk)
      .sort((a, b) => a.createdAt - b.createdAt || a.txid.localeCompare(b.txid));
  };
  const blocksDesc = (limit: number): Promise<BlockRow[]> =>
    new Promise((resolve, reject) => {
      const out: BlockRow[] = [];
      const c = get("blocks").openCursor(null, "prev");
      c.onerror = () => reject(c.error);
      c.onsuccess = () => {
        const cur = c.result;
        if (!cur || out.length >= limit) return resolve(out);
        out.push(blockFromDisk(cur.value as BlockDisk));
        cur.continue();
      };
    });
  return {
    async blockCount() {
      return req(get("blocks").count());
    },
    async tip() {
      const rows = await blocksDesc(1);
      return rows[0];
    },
    async blockAt(height: number) {
      const b = (await req(get("blocks").get(height))) as BlockDisk | undefined;
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
      const t = (await req(get("transactions").get(txid))) as TxDisk | undefined;
      return t ? txFromDisk(t) : undefined;
    },
    async txsInBlock(height: number) {
      const rows = (await req(
        get("transactions").index("blockHeight").getAll(IDBKeyRange.only(height)),
      )) as TxDisk[];
      return rows
        .map(txFromDisk)
        .sort((a, b) => a.txIndex - b.txIndex || a.txid.localeCompare(b.txid));
    },
    async confirmedCount() {
      return req(get("transactions").count());
    },
    async recentTxs(limit: number) {
      const cap = Math.min(limit, 100);
      const out: TxRow[] = [];
      await new Promise<void>((resolve, reject) => {
        const c = get("transactions").index("blockHeight").openCursor(null, "prev");
        c.onerror = () => reject(c.error);
        c.onsuccess = () => {
          const cur = c.result;
          if (!cur || out.length >= cap) return resolve();
          out.push(txFromDisk(cur.value as TxDisk));
          cur.continue();
        };
      });
      return out.sort(
        (a, b) => b.blockHeight - a.blockHeight || b.timestamp - a.timestamp,
      );
    },
    async txHistoryFor(address: string, limit: number) {
      const [out, inc] = await Promise.all([
        req(get("transactions").index("fromAddress").getAll(IDBKeyRange.only(address))),
        req(get("transactions").index("toAddress").getAll(IDBKeyRange.only(address))),
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
      const t = (await req(get("mempool").get(txid))) as MempoolDisk | undefined;
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
      return req(get("mempool").count());
    },
    async account(address: string) {
      const a = (await req(get("balances").get(address))) as AccountDisk | undefined;
      return a ? accFromDisk(a) : undefined;
    },
    async activeAccountCount() {
      const all = (await req(get("balances").getAll())) as AccountDisk[];
      return all.filter((a) => fromU64(a.balance) > 0).length;
    },
    async allAccounts() {
      const all = (await req(get("balances").getAll())) as AccountDisk[];
      return all.map(accFromDisk);
    },
    async latestSnapshot() {
      const keys = (await req(get("snapshots").getAllKeys())) as number[];
      if (keys.length === 0) return undefined;
      const top = Math.max(...keys);
      const snap = (await req(get("snapshots").get(top))) as SnapshotDisk | undefined;
      return snap ? snapFromDisk(snap) : undefined;
    },
    async getMeta(key: string) {
      const row = (await req(get("meta").get(key))) as { key: string; value: string } | undefined;
      return row?.value;
    },
  };
}

type Reads = ReturnType<typeof readsFrom>;

export class IdbStorage implements ChainStorage {
  private db: IDBDatabase | null = null;
  private reads: Reads | null = null;

  async open(): Promise<void> {
    if (this.db) return;
    this.db = await openDb();
    // If another tab ever upgrades the schema, yield immediately instead of
    // deadlocking its open() (blocked-event) - this tab reopens on reload.
    this.db.onversionchange = () => this.db?.close();
    const db = this.db;
    this.reads = readsFrom((store) => db.transaction(store, "readonly").objectStore(store));
  }

  private r(): Reads {
    if (!this.reads) throw new Error("IdbStorage not open");
    return this.reads;
  }

  blockCount = () => this.r().blockCount();
  tip = () => this.r().tip();
  blockAt = (h: number) => this.r().blockAt(h);
  recentBlocks = (l: number) => this.r().recentBlocks(l);
  lastBlockTimestamps = (l: number) => this.r().lastBlockTimestamps(l);
  hashrateWindow = (l: number) => this.r().hashrateWindow(l);
  txByTxid = (t: string) => this.r().txByTxid(t);
  txsInBlock = (h: number) => this.r().txsInBlock(h);
  confirmedCount = () => this.r().confirmedCount();
  recentTxs = (l: number) => this.r().recentTxs(l);
  txHistoryFor = (a: string, l: number) => this.r().txHistoryFor(a, l);
  mempoolTxByTxid = (t: string) => this.r().mempoolTxByTxid(t);
  mempool = () => this.r().mempool();
  mempoolFrom = (f: string) => this.r().mempoolFrom(f);
  mempoolForAddress = (a: string) => this.r().mempoolForAddress(a);
  mempoolCount = () => this.r().mempoolCount();
  account = (a: string) => this.r().account(a);
  activeAccountCount = () => this.r().activeAccountCount();
  allAccounts = () => this.r().allAccounts();
  latestSnapshot = () => this.r().latestSnapshot();
  getMeta = (k: string) => this.r().getMeta(k);

  async transact<T>(fn: (tx: ChainStorageTx) => Promise<T>): Promise<T> {
    if (!this.db) throw new Error("IdbStorage not open");
    const idbTx = this.db.transaction([...CHAIN_STORES], "readwrite");
    const store = (s: ChainStore) => idbTx.objectStore(s);
    const reads = readsFrom(store);
    const tx: ChainStorageTx = {
      ...reads,
      async putBlock(b) {
        await req(store("blocks").put(blockToDisk(b)));
      },
      async putTx(t) {
        await req(store("transactions").put(txToDisk(t)));
      },
      async putMempoolTx(t) {
        await req(store("mempool").put(mpToDisk(t)));
      },
      async deleteMempoolTx(txid) {
        await req(store("mempool").delete(txid));
      },
      async purgeMempoolSuperseded(from, nonce) {
        const rows = (await req(
          store("mempool").index("fromAddress").getAll(IDBKeyRange.only(from)),
        )) as MempoolDisk[];
        for (const row of rows) {
          if (row.nonce <= nonce) await req(store("mempool").delete(row.txid));
        }
      },
      async deleteTxsInBlock(height) {
        const rows = (await req(
          store("transactions").index("blockHeight").getAllKeys(IDBKeyRange.only(height)),
        )) as string[];
        for (const key of rows) await req(store("transactions").delete(key));
      },
      async deleteBlock(height) {
        await req(store("blocks").delete(height));
      },
      async putAccount(acc) {
        await req(store("balances").put(accToDisk(acc)));
      },
      async putSnapshot(snap) {
        await req(store("snapshots").put(snapToDisk(snap)));
      },
      async setMeta(key, value) {
        await req(store("meta").put({ key, value }));
      },
    };
    const done = new Promise<void>((resolve, reject) => {
      idbTx.oncomplete = () => resolve();
      idbTx.onabort = () => reject(idbTx.error ?? new Error("chain transaction aborted"));
    });
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
    if (!this.db) throw new Error("IdbStorage not open");
    const idbTx = this.db.transaction([...CHAIN_STORES], "readwrite");
    for (const s of CHAIN_STORES) idbTx.objectStore(s).clear();
    await new Promise<void>((resolve, reject) => {
      idbTx.oncomplete = () => resolve();
      idbTx.onerror = () => reject(idbTx.error);
      idbTx.onabort = () => reject(idbTx.error ?? new Error("deleteAll aborted"));
    });
  }

  // -- wallet store (outside chain transactions) ----------------------------
  async walletGet(id: string): Promise<{ id: string; privHex: string } | undefined> {
    if (!this.db) throw new Error("IdbStorage not open");
    return (await req(
      this.db.transaction("wallet", "readonly").objectStore("wallet").get(id),
    )) as { id: string; privHex: string } | undefined;
  }

  async walletPut(privHex: string): Promise<void> {
    if (!this.db) throw new Error("IdbStorage not open");
    await req(
      this.db.transaction("wallet", "readwrite").objectStore("wallet").put({ id: "main", privHex }),
    );
  }

  async walletClear(): Promise<void> {
    if (!this.db) throw new Error("IdbStorage not open");
    await req(this.db.transaction("wallet", "readwrite").objectStore("wallet").delete("main"));
  }
}
