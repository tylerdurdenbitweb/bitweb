/**
 * BitWeb browser node - chain state machine.
 *
 * A line-for-line port of the server reference node (api/node/chain.ts),
 * speaking to a ChainStorage adapter instead of MySQL. Every consensus rule
 * is identical: same genesis, same serializations, same retarget math, same
 * projected-state block application, same MAX_REORG_DEPTH rollback.
 *
 * Concurrency: every state mutation is serialized through `withLock` and
 * committed inside one atomic storage transaction, so the chain can never
 * observe a half-applied block or a half-rolled-back reorg.
 */
import {
  BOOTSTRAP_BLOCKS,
  GENESIS_MESSAGE,
  GENESIS_PREV_HASH,
  GENESIS_TIMESTAMP,
  HASHES_AT_DIFFICULTY_1,
  INITIAL_TARGET_HEX,
  MAX_FUTURE_DRIFT,
  MAX_MEMPOOL_TXS,
  MAX_MONEY,
  MAX_POP_RECIPIENTS,
  MAX_TXS_PER_BLOCK,
  MEDIAN_TIME_SPAN,
  MINER_COOLDOWN_ACTIVATION_HEIGHT,
  MIN_TX_FEE,
  POP_ATTEST_MAX_AGE_S,
  RETARGET_INTERVAL,
  SNAPSHOT_INTERVAL,
  TEMPLATE_TTL_MS,
  buildAddress,
  checkpointHashAt,
  difficultyOf,
  hashMeetsTarget,
  highestCheckpointAtOrBelow,
  nowSeconds,
  retargetTargetHex,
  serializeCoinbase,
  serializeHeader,
  getBlockReward,
  splitBlockReward,
  serializePopTransfer,
  type PopAttestation,
} from "@contracts/protocol";
import { CHAIN_ID, MAX_REORG_DEPTH, P2P_VERSION, type WireBlock, type WireTx } from "@contracts/wire";
import {
  addressFromPubkey,
  checkAddress,
  dsha256Hex,
  isValidPubkeyHex,
  merkleRootHex,
  txidOfTransfer,
  verifyPopAttestationSignature,
  verifyTransferSignature,
  type TransferInput,
} from "./blockchain";
import type {
  AccountRow,
  BlockRow,
  ChainStorage,
  ChainStorageTx,
  MempoolTxRow,
  PopTransfer,
  TxRow,
} from "./storage";
import {
  beginChainUpdate,
  resetChainGate,
  setChainGateDetail,
  setChainGateProgress,
} from "./chain-gate";
import { setBootPhase, setBootProgress } from "./boot-progress";

/** Consensus/state validation failure - the peer that caused it earns a strike. */
export class ChainValidationError extends Error {}

/**
 * LOCAL template-construction refusal: this wallet mined the current tip,
 * so consensus forbids it the very next block (rotation rule, active since
 * height MINER_COOLDOWN_ACTIVATION_HEIGHT). Not a chain fault - nobody gets
 * a strike - but it must be distinguishable from real template errors, so
 * the miner can park quietly and wait for another miner's block instead of
 * retrying a wall. The message text matches the consensus rule verbatim.
 */
export class MinerCooldownError extends ChainValidationError {}

function bad(msg: string): never {
  throw new ChainValidationError(msg);
}

/** Gossip hooks - the P2P layer registers here, keeping imports one-way. */
export const chainHooks = {
  onBlockAccepted: [] as Array<(height: number) => void>,
  onTxAccepted: [] as Array<(t: TransferInput) => void>,
  /**
   * Fired when the WHOLE chain was replaced by a validated longer remote
   * chain (deep-fork repair). Routine one-block applies and bounded
   * rollbacks never fire this - a fire means history moved a lot, which is
   * exactly what a rewrite attempt looks like. The UI turns it into a loud
   * notification: consensus stays silent, the human gets told.
   */
  onChainReplaced: [] as Array<(tip: { height: number; hash: string }) => void>,
};

function fireBlockAccepted(height: number): void {
  for (const cb of chainHooks.onBlockAccepted) {
    try {
      cb(height);
    } catch {
      /* gossip must never break consensus */
    }
  }
}

function fireTxAccepted(t: TransferInput): void {
  for (const cb of chainHooks.onTxAccepted) {
    try {
      cb(t);
    } catch {
      /* gossip must never break consensus */
    }
  }
}

/** The peer-count source for the info view - registered by the P2P layer. */
let peerCountProvider: () => number = () => 0;
export function setPeerCountProvider(fn: () => number): void {
  peerCountProvider = fn;
}

/**
 * PoP attestation source - registered by the P2P layer. Returns the CURRENTLY
 * valid peer-signed attestations this node holds (signature-verified against
 * our own node id, inside the freshness margin). The block template pays
 * each attested address an equal share of the block's 20% peer pool.
 */
let popAttestationsProvider: () => PopAttestation[] = () => [];
export function setPopAttestationsProvider(fn: () => PopAttestation[]): void {
  popAttestationsProvider = fn;
}

/** Our own canonical PoP node id (what peers sign attestations FOR). */
let popMinerNodeIdProvider: () => string | null = () => null;
export function setPopMinerNodeIdProvider(fn: () => string | null): void {
  popMinerNodeIdProvider = fn;
}

// ===========================================================================
//  INIT / GENESIS
// ===========================================================================

let storage: ChainStorage | null = null;
let initPromise: Promise<void> | null = null;

export function initChain(s: ChainStorage): Promise<void> {
  if (storage && storage !== s) throw new Error("chain already bound to a storage");
  storage = s;
  // A freshly booted node cannot be mid-update: drop any leftover gate
  // count from a torn-down realm so the UI never pins the UPDATING overlay.
  resetChainGate();
  if (!initPromise) {
    initPromise = bootstrapGenesis().catch((err) => {
      initPromise = null; // allow retry on next call
      throw err;
    });
  }
  return initPromise;
}

function db(): ChainStorage {
  if (!storage) throw new Error("chain storage not bound");
  return storage;
}

/** The one true genesis block - identical on every node, computed from constants. */
function genesisParts() {
  const zeroAddr = buildAddress("0".repeat(40), dsha256Hex);
  const cbTxid = dsha256Hex(serializeCoinbase({ height: 0, to: zeroAddr, amount: 0 }));
  const merkleRoot = merkleRootHex([cbTxid]);
  const hash = dsha256Hex(
    serializeHeader({
      height: 0,
      prevHash: GENESIS_PREV_HASH,
      merkleRoot,
      timestamp: GENESIS_TIMESTAMP,
      nonce: 0,
    }),
  );
  return { zeroAddr, cbTxid, merkleRoot, hash, ts: GENESIS_TIMESTAMP };
}

/**
 * A database whose block #0 is not the deterministic genesis belongs to a
 * previous protocol epoch. A trivially young chain (only ever bootstrap test
 * blocks) is reset automatically so redeploys converge; a grown chain refuses
 * to boot rather than silently fork - that is a human decision.
 */
const EPOCH_RESET_MAX_HEIGHT = 8;

async function bootstrapGenesis(): Promise<void> {
  const s = db();
  const { zeroAddr, cbTxid, merkleRoot, hash, ts } = genesisParts();
  const n = await s.blockCount();

  if (n > 0) {
    const g = await s.blockAt(0);
    if (g && g.hash === hash) {
      await recoverChainStateIfNeeded(s);
      return; // current epoch - nothing else to do
    }
    const tip = await s.tip();
    const tipHeight = tip?.height ?? 0;
    if (tipHeight > EPOCH_RESET_MAX_HEIGHT) {
      throw new Error(
        `genesis mismatch: this database carries a chain from a previous protocol epoch ` +
          `(height ${tipHeight}). Refusing to boot - export what you need and reset manually.`,
      );
    }
    console.warn(
      `[bitweb] previous protocol epoch detected (height ${tipHeight}) - resetting bootstrap chain`,
    );
    await s.deleteAll();
  }

  await s.transact(async (tx) => {
    await tx.putBlock({
      height: 0,
      hash,
      prevHash: GENESIS_PREV_HASH,
      merkleRoot,
      timestamp: ts,
      nonce: 0,
      target: INITIAL_TARGET_HEX,
      difficulty: 1,
      reward: 0,
      txCount: 1,
      miner: zeroAddr,
      message: GENESIS_MESSAGE,
      popTransfers: [],
      feesBurned: 0,
      minerPeerId: null,
      popAttestations: [],
    });
    await tx.putTx({
      txid: cbTxid,
      blockHeight: 0,
      type: "coinbase",
      fromAddress: null,
      toAddress: zeroAddr,
      amount: 0,
      fee: 0,
      nonce: null,
      txIndex: 0,
      pubkey: null,
      signature: null,
      timestamp: ts,
    });
    await tx.setMeta("totalSupply", "0");
  });
  console.info(`[bitweb] genesis block sealed: height=0 hash=${hash}`);
}

/**
 * Boot-time integrity check + state recovery. The blocks and transactions
 * stores are the source of truth; the balances table and totalSupply are
 * derived from them. Two invariants must always hold:
 * `sum(balances) === totalSupply` AND `totalSupply ===` the supply implied
 * by the stored blocks themselves. If partial storage loss (or drift left
 * behind by any historical version) ever breaks either, rebuild the derived
 * state instead of booting corrupted: zero every account, then replay every
 * block through the exact same application path as live blocks. The replay
 * starts at genesis when the full block history is present; when early
 * blocks are gone (pruned/evicted), the latest state snapshot above the gap
 * is the only remaining anchor and is used as the base instead.
 */
/**
 * Verified-supply checkpoint (meta key `recoveryCheckpoint`, JSON
 * `{height, expected}`): written after every healthy boot check and every
 * rebuild, it pins the block-implied supply `sum(reward + pop - fees)`
 * through `height`. Block rows are append-only and were verified when the
 * checkpoint was written, so later boots only scan the rows ABOVE it -
 * boot stays O(new blocks) instead of O(all blocks) as the chain grows.
 * It is a performance anchor only, never a trust shortcut: the balances
 * invariant is always checked in full, drift above the checkpoint is
 * still caught (the cached value disagrees with the corrupted caches),
 * and any rebuild still re-derives everything from the blocks store or a
 * state snapshot exactly as before. A missing/garbage row just costs one
 * full scan.
 */
const RECOVERY_CHECKPOINT_KEY = "recoveryCheckpoint";
/** Block rows are read in parallel chunks: sequential one-row IDB reads
 *  dominated boot time on grown chains. */
const RECOVERY_READ_CHUNK = 64;

interface RecoveryCheckpoint {
  height: number;
  expected: number;
}

function parseRecoveryCheckpoint(raw: string | undefined, tipHeight: number): RecoveryCheckpoint | null {
  if (raw === undefined) return null;
  try {
    const v = JSON.parse(raw) as Partial<RecoveryCheckpoint>;
    if (
      Number.isInteger(v.height) &&
      v.height! >= 0 &&
      v.height! <= tipHeight &&
      Number.isFinite(v.expected) &&
      v.expected! >= 0
    ) {
      return { height: v.height!, expected: v.expected! };
    }
  } catch {
    /* garbage row - fall through to the full scan */
  }
  return null;
}

/** Read block rows [from, to] in parallel chunks; undefined where missing. */
async function readBlockRows(
  s: ChainStorage,
  from: number,
  to: number,
): Promise<Array<BlockRow | undefined>> {
  const out: Array<BlockRow | undefined> = new Array(to - from + 1);
  for (let base = from; base <= to; base += RECOVERY_READ_CHUNK) {
    const end = Math.min(base + RECOVERY_READ_CHUNK - 1, to);
    const rows = await Promise.all(
      Array.from({ length: end - base + 1 }, (_, i) => s.blockAt(base + i)),
    );
    for (let i = 0; i < rows.length; i++) out[base - from + i] = rows[i];
  }
  return out;
}

async function recoverChainStateIfNeeded(s: ChainStorage): Promise<void> {
  const blocks = await s.blockCount();
  if (blocks <= 1) return; // genesis-only chain has no derived state to lose
  const tip = await s.tip();
  if (!tip) return;
  const supplyRow = await s.getMeta("totalSupply");
  const supply = supplyRow === undefined ? 0 : Number(supplyRow);
  const accounts = await s.allAccounts();
  const held = accounts.reduce((sum, a) => sum + a.balance, 0);

  // The blocks store is the ONLY trust anchor: totalSupply is a cache of
  // `sum(reward + popTransfers - feesBurned)` over every block, and balances
  // are a cache of the same ledger. Recompute the block-implied supply and
  // demand BOTH caches agree with it. Any drift - from any version, any
  // cause - heals here on boot, deterministically, identically on every
  // device that holds the same chain. The checkpoint lets a verified chain
  // skip re-reading rows an earlier boot already proved.
  const checkpoint = parseRecoveryCheckpoint(await s.getMeta(RECOVERY_CHECKPOINT_KEY), tip.height);
  const scanFrom = checkpoint ? checkpoint.height + 1 : 1;
  let expected: number | null = checkpoint ? checkpoint.expected : 0;
  if (scanFrom <= tip.height) {
    setBootPhase("verifying stored chain");
    setBootProgress(scanFrom - 1, tip.height);
    const rows = await readBlockRows(s, scanFrom, tip.height);
    for (let i = 0; i < rows.length; i++) {
      const b = rows[i];
      if (!b) {
        expected = null;
        break;
      }
      expected! += b.reward + b.popTransfers.reduce((sum, pt) => sum + pt.amount, 0) - b.feesBurned;
      if (i % RECOVERY_READ_CHUNK === RECOVERY_READ_CHUNK - 1) {
        setBootProgress(scanFrom + i, tip.height);
      }
    }
    setBootProgress(tip.height, tip.height);
  }
  if (held === supply && (expected === null || expected === supply)) {
    // healthy boot - pin how far the blocks store was proven, so the next
    // boot only pays for what arrived since
    if (expected !== null) {
      await s.transact(async (tx) => {
        await tx.setMeta(
          RECOVERY_CHECKPOINT_KEY,
          JSON.stringify({ height: tip.height, expected } satisfies RecoveryCheckpoint),
        );
      });
    }
    return;
  }

  // Rebuild anchor probe - deliberately independent of the checkpointed
  // check above: replay from genesis needs COMPLETE row history, and only
  // this probe can say whether we have it. A complete history means replay
  // from genesis and IGNORE state snapshots - a snapshot written by the same
  // path that drifted would re-import the drift. When early history is
  // unavailable (pruned away or evicted), the latest snapshot ABOVE the gap
  // is the only remaining anchor: heal from it instead. (Runs only on the
  // disaster path - a healthy boot never pays for it.)
  const probe = await readBlockRows(s, 1, tip.height);
  const snap = probe.some((r) => !r) ? ((await s.latestSnapshot()) ?? null) : null;
  const replayFrom = snap ? snap.height + 1 : 1;
  if (snap && snap.height >= tip.height) return; // nothing replayable above it
  console.warn(
    `[bitweb] derived state broken (balances sum ${held}, supply ${supply}` +
      `${expected === null ? "" : `, blocks imply ${expected}`}) - rebuilding` +
      (snap ? ` from snapshot #${snap.height}` : " from the blocks store"),
  );

  // Read every row the replay needs BEFORE the write transaction: replayed
  // heights are deleted and re-applied below, and a read during the tx would
  // already see the deletes.
  interface ReplayRow {
    block: BlockRow;
    included: MempoolTxRow[];
    coinbaseTxid: string;
  }
  setBootPhase("rebuilding derived state");
  setBootProgress(0, tip.height - replayFrom + 1);
  const rows: ReplayRow[] = [];
  for (let base = replayFrom; base <= tip.height; base += RECOVERY_READ_CHUNK) {
    const end = Math.min(base + RECOVERY_READ_CHUNK - 1, tip.height);
    const chunkBlocks = await readBlockRows(s, base, end);
    const chunkTxs = await Promise.all(
      Array.from({ length: end - base + 1 }, (_, i) => s.txsInBlock(base + i)),
    );
    for (let i = 0; i < chunkBlocks.length; i++) {
      const b = chunkBlocks[i];
      if (!b) {
        throw new Error(`chain corrupted: block ${base + i} is missing - cannot rebuild state`);
      }
      const txs = chunkTxs[i];
      const cb = txs.find((t) => t.type === "coinbase");
      if (!cb) throw new Error(`chain corrupted: block ${b.height} has no coinbase row`);
      rows.push({
        block: b,
        coinbaseTxid: cb.txid,
        included: txs
          .filter((t) => t.type === "transfer")
          .map((t) => ({
            txid: t.txid,
            type: "transfer",
            fromAddress: t.fromAddress as string,
            toAddress: t.toAddress,
            amount: t.amount,
            fee: t.fee,
            nonce: t.nonce as number,
            pubkey: t.pubkey as string,
            signature: t.signature as string,
            timestamp: t.timestamp,
            createdAt: 0, // admission order is irrelevant at apply time
          })),
      });
    }
    setBootProgress(rows.length, tip.height - replayFrom + 1);
  }

  await s.transact(async (tx) => {
    // Zero ALL derived state first: the replay below ADDS every block's
    // deltas, so any surviving balance/nonce would be counted twice. In the
    // snapshot fallback the snapshot's own rows are then restored as the
    // base. The result is a pure function of trusted anchors - nothing else.
    for (const acc of await tx.allAccounts()) {
      await tx.putAccount({ ...acc, balance: 0, nonce: 0, blocksMined: 0 });
    }
    if (snap) {
      for (const acc of snap.accounts) await tx.putAccount(acc);
      await tx.setMeta("totalSupply", String(snap.totalSupply));
    } else {
      await tx.setMeta("totalSupply", "0");
    }
    for (const r of rows) {
      const b = r.block;
      await tx.deleteTxsInBlock(b.height);
      await tx.deleteBlock(b.height);
      await applyBlockInTx(tx, {
        height: b.height,
        hash: b.hash,
        prevHash: b.prevHash,
        merkleRoot: b.merkleRoot,
        timestamp: b.timestamp,
        nonce: b.nonce,
        target: b.target,
        miner: b.miner,
        message: b.message,
        coinbaseTxid: r.coinbaseTxid,
        coinbaseAmount: b.reward,
        popTransfers: b.popTransfers,
        popAttestations: b.popAttestations,
        minerPeerId: b.minerPeerId,
        feesBurned: b.feesBurned,
        included: r.included,
      });
    }
  });
  invalidateInfoCache();
  // The rebuild re-derived everything from trusted anchors - pin it, so the
  // next boot verifies only what arrives from now on.
  const healed = Number((await s.getMeta("totalSupply")) ?? "0");
  await s.transact(async (tx) => {
    await tx.setMeta(
      RECOVERY_CHECKPOINT_KEY,
      JSON.stringify({ height: tip.height, expected: healed } satisfies RecoveryCheckpoint),
    );
  });
  console.info(
    `[bitweb] state rebuild complete: ${rows.length} block(s) replayed` +
      (snap ? ` on top of snapshot #${snap.height}` : " from genesis"),
  );
}

/** Exported for tests and diagnostics: run the boot recovery check on demand. */
export function recoverChainState(): Promise<void> {
  return recoverChainStateIfNeeded(db());
}

// ===========================================================================
//  CHAIN READS (internal)
// ===========================================================================

async function getTip(): Promise<BlockRow> {
  const tip = await db().tip();
  if (!tip) throw new Error("chain not initialized");
  return tip;
}

/** Median-time-past over the MEDIAN_TIME_SPAN most recent blocks. */
async function medianTimePast(): Promise<number> {
  const times = (await db().lastBlockTimestamps(MEDIAN_TIME_SPAN)).sort((a, b) => a - b);
  return times[Math.floor((times.length - 1) / 2)];
}

/** The target a new block at `height` must meet, given current tip. */
async function expectedTargetForHeight(height: number, tip: BlockRow): Promise<string> {
  if (height === 0) return INITIAL_TARGET_HEX;
  if (height % RETARGET_INTERVAL !== 0) return tip.target;
  const first = await db().blockAt(height - RETARGET_INTERVAL);
  if (!first) throw new Error("retarget window missing");
  return retargetTargetHex(tip.target, tip.timestamp - first.timestamp);
}

async function getTotalSupply(): Promise<number> {
  const v = await db().getMeta("totalSupply");
  return v === undefined ? 0 : Number(v);
}

// ===========================================================================
//  MEMPOOL ADMISSION
// ===========================================================================

// Relay-policy bound per sender (chain.ts-local on purpose: this is node
// policy like Bitcoin's mempool limits, not a consensus rule - blocks are
// valid or invalid regardless of what any mempool holds).
export const MAX_MEMPOOL_PER_SENDER = 64;

export async function admitTransfer(input: TransferInput): Promise<{ txid: string }> {
  const { from, to, amount, fee, nonce } = input;

  if (!checkAddress(from)) bad("invalid sender address (checksum failed)");
  if (!checkAddress(to)) bad("invalid recipient address (checksum failed)");
  if (!Number.isInteger(amount) || amount < 1) bad("amount must be >= 1 base unit");
  if (!Number.isInteger(fee) || fee < MIN_TX_FEE) bad(`fee must be >= ${MIN_TX_FEE} base units`);
  if (amount + fee > MAX_MONEY) bad("amount exceeds max money");
  if (!Number.isInteger(nonce) || nonce < 0) bad("invalid nonce");
  if (!isValidPubkeyHex(input.pubkey)) bad("invalid public key");
  if (addressFromPubkey(input.pubkey) !== from) bad("public key does not match sender address");
  if (!verifyTransferSignature(input)) bad("invalid signature");

  const txid = txidOfTransfer(input);

  await db().transact(async (tx) => {
    if ((await tx.mempoolCount()) >= MAX_MEMPOOL_TXS) {
      bad("mempool full, try again after the next block");
    }
    const acc = await tx.account(from);
    const confirmedNonce = acc?.nonce ?? 0;
    const confirmedBalance = acc?.balance ?? 0;
    const pendingFrom = await tx.mempoolFrom(from);

    // Relay policy, NOT consensus: one sender may hold at most this many
    // pending slots. Without it a single funded wallet can occupy all
    // MAX_MEMPOOL_TXS slots with min-fee spam and lock everyone else out
    // until blocks drain the queue. Block validity is unaffected either way.
    if (pendingFrom.length >= MAX_MEMPOOL_PER_SENDER) {
      bad(`too many pending transactions from one sender (max ${MAX_MEMPOOL_PER_SENDER})`);
    }

    const expectedNonce = confirmedNonce + pendingFrom.length;
    if (nonce !== expectedNonce) {
      bad(`bad nonce: expected ${expectedNonce}, got ${nonce}`);
    }
    const pendingSpend = pendingFrom.reduce((s, t) => s + t.amount + t.fee, 0);
    if (confirmedBalance - pendingSpend < amount + fee) {
      bad("insufficient funds (including pending transactions)");
    }
    if ((await tx.mempoolTxByTxid(txid)) || (await tx.txByTxid(txid))) {
      bad("duplicate transaction");
    }
    await tx.putMempoolTx({
      txid,
      type: "transfer",
      fromAddress: from,
      toAddress: to,
      amount,
      fee,
      nonce,
      pubkey: input.pubkey,
      signature: input.signature,
      timestamp: nowSeconds(),
      createdAt: Date.now(),
    });
  });
  fireTxAccepted(input);
  invalidateInfoCache();
  return { txid };
}

// ===========================================================================
//  MINING - TEMPLATES & BLOCK SUBMISSION
// ===========================================================================

interface BlockTemplate {
  id: string;
  height: number;
  prevHash: string;
  target: string;
  merkleRoot: string;
  miner: string;
  coinbaseTxid: string;
  coinbaseAmount: number; // the miner's 70% share (subsidy only - fees burn)
  fees: number; // total transfer fees - burned at apply, shown for info
  popTransfers: PopTransfer[]; // the 20% peer-pool credits committed here
  popAttestations: PopAttestation[]; // the peer signatures backing each credit
  minerPeerId: string | null; // our node id - the attestation target
  included: MempoolTxRow[]; // transfers, in block order
  minTimestamp: number;
  expiresMs: number;
}

const templates = new Map<string, BlockTemplate>();

function sweepTemplates(): void {
  const now = Date.now();
  for (const [id, t] of templates) if (t.expiresMs <= now) templates.delete(id);
}

function newTemplateId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface TemplateView {
  templateId: string;
  height: number;
  prevHash: string;
  target: string;
  merkleRoot: string;
  minTimestamp: number;
  expiresAt: number; // unix seconds
  reward: number; // the miner's 70% coinbase share
  fees: number; // burned at apply - never paid
  txCount: number;
  popRecipients: number; // peers sharing the 20% pool
  popPerPeer: number; // each peer's credit
}

export async function buildTemplate(minerAddress: string): Promise<TemplateView> {
  if (!checkAddress(minerAddress)) bad("invalid miner address (checksum failed)");
  sweepTemplates();

  const tip = await getTip();
  const height = tip.height + 1;
  if (violatesMinerCooldown(height, minerAddress, tip.miner)) {
    throw new MinerCooldownError(
      "miner cooldown: you mined the previous block - wait for another miner",
    );
  }
  const target = await expectedTargetForHeight(height, tip);
  const mtp = await medianTimePast();
  const minTimestamp = Math.max(mtp + 1, tip.timestamp + 1);

  // Select mempool txs: fee-priority order, per-sender sequential nonces,
  // projected-balance sufficiency. Permanently invalid rows are purged.
  const mempool = (await db().mempool()).sort(
    (a, b) => b.fee - a.fee || a.createdAt - b.createdAt,
  );

  const senderState = new Map<string, { nonce: number; balance: number }>();
  const included: MempoolTxRow[] = [];
  const purge: string[] = [];

  for (const t of mempool) {
    if (included.length >= MAX_TXS_PER_BLOCK) break;
    if (!senderState.has(t.fromAddress)) {
      const acc = await db().account(t.fromAddress);
      senderState.set(t.fromAddress, { nonce: acc?.nonce ?? 0, balance: acc?.balance ?? 0 });
    }
    const st = senderState.get(t.fromAddress)!;
    if (t.nonce < st.nonce) {
      purge.push(t.txid); // superseded by a confirmed tx - dead forever
      continue;
    }
    if (t.nonce !== st.nonce) continue; // gap - wait for the missing nonce
    if (st.balance < t.amount + t.fee) continue; // insufficient projected funds
    st.nonce += 1;
    st.balance -= t.amount + t.fee;
    included.push(t);
  }
  if (purge.length > 0) {
    await db().transact(async (tx) => {
      for (const id of purge) await tx.deleteMempoolTx(id);
    });
  }

  // -- 70/20/10 emission split --
  // Fees are NOT in the coinbase: 100% of them burn at apply time. The 20%
  // peer pool is split equally among peers that PROVED participation with a
  // signed attestation targeting OUR node id. No attestation -> no share.
  const fees = included.reduce((s, t) => s + t.fee, 0);
  const minerPeerId = popMinerNodeIdProvider();
  const nowS = nowSeconds();
  const byAddress = new Map<string, PopAttestation>();
  for (const a of popAttestationsProvider()) {
    if (minerPeerId === null) break; // solo/offline: nothing can target us
    if (a.address === minerAddress || !checkAddress(a.address)) continue;
    // margin: the block still has to be FOUND, and validation measures the
    // attestation age at the BLOCK's timestamp - keep 60s of headroom
    if (Math.abs(nowS - a.timestamp) > POP_ATTEST_MAX_AGE_S - 60) continue;
    if (
      !verifyPopAttestationSignature({
        minerPeerId,
        address: a.address,
        timestamp: a.timestamp,
        pubkey: a.pubkey,
        signature: a.signature,
      })
    ) {
      continue;
    }
    const prev = byAddress.get(a.address);
    if (!prev || a.timestamp > prev.timestamp) byAddress.set(a.address, a);
  }
  const popAttestations = [...byAddress.values()].slice(0, MAX_POP_RECIPIENTS);
  const split = splitBlockReward(height, popAttestations.length);
  const coinbaseAmount = split.miner;
  const popTransfers: PopTransfer[] = popAttestations.map((a, index) => ({
    address: a.address,
    amount: split.perPeer,
    index,
  }));
  const coinbaseTxid = dsha256Hex(
    serializeCoinbase({ height, to: minerAddress, amount: coinbaseAmount }),
  );
  const popIds = popTransfers.map((pt) =>
    dsha256Hex(
      serializePopTransfer({ height, index: pt.index, to: pt.address, amount: pt.amount }),
    ),
  );
  const txids = [coinbaseTxid, ...popIds, ...included.map((t) => t.txid)];
  const merkleRoot = merkleRootHex(txids);

  const template: BlockTemplate = {
    id: newTemplateId(),
    height,
    prevHash: tip.hash,
    target,
    merkleRoot,
    miner: minerAddress,
    minerPeerId,
    coinbaseTxid,
    coinbaseAmount,
    fees,
    popTransfers,
    popAttestations,
    included,
    minTimestamp,
    expiresMs: Date.now() + TEMPLATE_TTL_MS,
  };
  templates.set(template.id, template);

  return {
    templateId: template.id,
    height,
    prevHash: template.prevHash,
    target,
    merkleRoot,
    minTimestamp,
    expiresAt: Math.floor(template.expiresMs / 1000),
    reward: coinbaseAmount,
    fees,
    txCount: included.length,
    popRecipients: popTransfers.length,
    popPerPeer: split.perPeer,
  };
}

// -- single-writer lock ------------------------------------------------------
let lockChain: Promise<unknown> = Promise.resolve();

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = lockChain.then(fn, fn);
  lockChain = run.catch(() => undefined);
  return run;
}

// ===========================================================================
//  SHARED BLOCK APPLICATION - one path for mined and received blocks
// ===========================================================================

interface ApplyParams {
  height: number;
  hash: string;
  prevHash: string;
  merkleRoot: string;
  timestamp: number;
  nonce: number;
  target: string;
  miner: string;
  message: string | null;
  coinbaseTxid: string;
  coinbaseAmount: number; // the miner's 70% share (subsidy only)
  popTransfers: PopTransfer[]; // the 20% peer-pool credits
  popAttestations: PopAttestation[]; // peer signatures proving participation
  minerPeerId: string | null; // the miner's node id - attestation target
  feesBurned: number; // total transfer fees - destroyed, never re-minted
  included: MempoolTxRow[]; // transfers in exact block order (txIndex = position + 1)
}

/**
 * Miner cooldown (consensus from MINER_COOLDOWN_ACTIVATION_HEIGHT): one
 * address may not mine two consecutive blocks - after a win it waits one
 * block for someone else. Pure and exported so every layer (template,
 * application, tests) enforces the exact same rule.
 */
export function violatesMinerCooldown(
  height: number,
  miner: string,
  prevMiner: string | null,
): boolean {
  return height >= MINER_COOLDOWN_ACTIVATION_HEIGHT && prevMiner !== null && miner === prevMiner;
}

/**
 * CRYPTOGRAPHIC PoP verification - the fix for the miner-declared peer list.
 * Every attestation must carry a valid signature over the canonical preimage
 * (binding THIS miner's node id, the payout address and the timestamp), must
 * be fresh relative to the block timestamp, and the attested address set must
 * match the block's PoP payout set EXACTLY: a peer without an attestation
 * cannot be paid, and an attestation cannot go unpaid. Boolean per contract -
 * the caller turns false into a ChainValidationError.
 */
export function validatePoPAttestations(block: {
  minerPeerId: string | null;
  miner: string;
  timestamp: number;
  popTransfers: PopTransfer[];
  popAttestations: PopAttestation[];
}): boolean {
  const atts = block.popAttestations;
  if (atts.length === 0) return block.popTransfers.length === 0; // pool burns
  if (block.minerPeerId === null || block.minerPeerId.length === 0) return false;
  if (atts.length > MAX_POP_RECIPIENTS) return false;

  const attested: string[] = [];
  for (const a of atts) {
    if (!Number.isInteger(a.timestamp)) return false;
    if (Math.abs(block.timestamp - a.timestamp) > POP_ATTEST_MAX_AGE_S) return false;
    if (!checkAddress(a.address)) return false;
    if (a.address === block.miner) return false; // miner cannot attest itself
    if (
      !verifyPopAttestationSignature({
        minerPeerId: block.minerPeerId,
        address: a.address,
        timestamp: a.timestamp,
        pubkey: a.pubkey,
        signature: a.signature,
      })
    ) {
      return false;
    }
    attested.push(a.address);
  }
  // one address, one share: duplicates would let a single sockpuppet key
  // claim several pool shares - the attested set must be distinct
  if (new Set(attested).size !== attested.length) return false;
  // exact match: same multiset of addresses on both sides
  if (attested.length !== block.popTransfers.length) return false;
  const lhs = attested.slice().sort();
  const rhs = block.popTransfers.map((pt) => pt.address).sort();
  return lhs.every((addr, i) => addr === rhs[i]);
}

/**
 * Applies a fully header-validated block to chain state. Runs inside the
 * caller's storage transaction; any throw rolls the whole block back.
 *
 * Transfers are re-validated against *projected* per-sender state (nonce and
 * balance tracked across the block), so multiple txs from one sender in a
 * single block validate exactly like the template builder selected them.
 */
async function applyBlockInTx(tx: ChainStorageTx, p: ApplyParams): Promise<void> {
  // 0. PoP attestations are re-verified INSIDE the application path, so a
  // locally-mined block is held to exactly the same standard as a wire one.
  if (
    !validatePoPAttestations({
      minerPeerId: p.minerPeerId,
      miner: p.miner,
      timestamp: p.timestamp,
      popTransfers: p.popTransfers,
      popAttestations: p.popAttestations,
    })
  ) {
    throw new ChainValidationError("invalid PoP attestations");
  }

  // 0b. Miner cooldown: from the activation height, the previous block's
  // miner must sit this one out. Local submissions and wire blocks are held
  // to the same rule - one check, inside the shared application path.
  if (p.height >= MINER_COOLDOWN_ACTIVATION_HEIGHT) {
    const prev = await tx.blockAt(p.height - 1);
    if (violatesMinerCooldown(p.height, p.miner, prev?.miner ?? null)) {
      throw new ChainValidationError("miner cooldown: same miner as the previous block");
    }
  }

  // 1. Re-validate every included transfer against projected state.
  const projected = new Map<string, { nonce: number; balance: number }>();
  for (const t of p.included) {
    if (!projected.has(t.fromAddress)) {
      const acc = await tx.account(t.fromAddress);
      projected.set(t.fromAddress, { nonce: acc?.nonce ?? 0, balance: acc?.balance ?? 0 });
    }
    const st = projected.get(t.fromAddress)!;
    if (st.nonce !== t.nonce) {
      throw new ChainValidationError(`tx ${t.txid.slice(0, 12)}... nonce invalidated by chain state`);
    }
    if (st.balance < t.amount + t.fee) {
      throw new ChainValidationError(`tx ${t.txid.slice(0, 12)}... insufficient funds at apply time`);
    }
    st.nonce += 1;
    st.balance -= t.amount + t.fee;
  }

  // 2. The block row itself.
  await tx.putBlock({
    height: p.height,
    hash: p.hash,
    prevHash: p.prevHash,
    merkleRoot: p.merkleRoot,
    timestamp: p.timestamp,
    nonce: p.nonce,
    target: p.target,
    difficulty: difficultyOf(p.target),
    reward: p.coinbaseAmount,
    txCount: p.included.length + 1,
    miner: p.miner,
    message: p.message,
    popTransfers: p.popTransfers,
    feesBurned: p.feesBurned,
    minerPeerId: p.minerPeerId,
    popAttestations: p.popAttestations,
  });

  // 3. Transfers: confirm mempool rows, or insert rows first seen on the wire.
  for (let i = 0; i < p.included.length; i++) {
    const t = p.included[i];
    const pending = await tx.mempoolTxByTxid(t.txid);
    const confirmed = pending ? null : await tx.txByTxid(t.txid);
    if (confirmed) {
      throw new ChainValidationError(`tx ${t.txid.slice(0, 12)}... already confirmed`);
    }
    if (pending) await tx.deleteMempoolTx(t.txid);
    await tx.putTx({
      txid: t.txid,
      blockHeight: p.height,
      type: "transfer",
      fromAddress: t.fromAddress,
      toAddress: t.toAddress,
      amount: t.amount,
      fee: t.fee,
      nonce: t.nonce,
      txIndex: i + 1,
      pubkey: t.pubkey,
      signature: t.signature,
      timestamp: t.timestamp,
    });
  }

  // 4. Coinbase.
  await tx.putTx({
    txid: p.coinbaseTxid,
    blockHeight: p.height,
    type: "coinbase",
    fromAddress: null,
    toAddress: p.miner,
    amount: p.coinbaseAmount,
    fee: 0,
    nonce: null,
    txIndex: 0,
    pubkey: null,
    signature: null,
    timestamp: p.timestamp,
  });

  // 4b. PoP credits - one confirmed row per peer-pool share, committed to
  // the merkle root by its BTWBPOP1 id. These are credits, not transfers:
  // no sender, no nonce, no signature.
  for (let i = 0; i < p.popTransfers.length; i++) {
    const pt = p.popTransfers[i];
    await tx.putTx({
      txid: dsha256Hex(
        serializePopTransfer({ height: p.height, index: pt.index, to: pt.address, amount: pt.amount }),
      ),
      blockHeight: p.height,
      type: "pop",
      fromAddress: null,
      toAddress: pt.address,
      amount: pt.amount,
      fee: 0,
      nonce: null,
      txIndex: 1 + p.included.length + i,
      pubkey: null,
      signature: null,
      timestamp: p.timestamp,
    });
  }

  // 5. Account deltas (merged per address, read-modify-write in-tx).
  const delta = new Map<string, { balance: number; nonce: number | null; mined: number }>();
  const entry = (a: string) => {
    let e = delta.get(a);
    if (!e) {
      e = { balance: 0, nonce: null, mined: 0 };
      delta.set(a, e);
    }
    return e;
  };
  entry(p.miner).balance += p.coinbaseAmount;
  entry(p.miner).mined += 1;
  for (const pt of p.popTransfers) {
    entry(pt.address).balance += pt.amount;
  }
  for (const t of p.included) {
    entry(t.fromAddress).balance -= t.amount + t.fee;
    entry(t.fromAddress).nonce = t.nonce + 1;
    entry(t.toAddress).balance += t.amount;
  }

  for (const [address, d] of delta) {
    const row = await tx.account(address);
    if (!row) {
      if (d.balance < 0) throw new ChainValidationError("negative balance on new account");
      const acc: AccountRow = {
        address,
        balance: d.balance,
        nonce: d.nonce ?? 0,
        blocksMined: d.mined,
      };
      await tx.putAccount(acc);
    } else {
      const newBalance = row.balance + d.balance;
      if (newBalance < 0) throw new ChainValidationError("negative balance");
      await tx.putAccount({
        address,
        balance: newBalance,
        nonce: d.nonce ?? row.nonce,
        blocksMined: row.blocksMined + d.mined,
      });
    }
  }

  // 6. Supply: mint the distributed shares, destroy the fees. The 10% burn
  // share (+ dust + unclaimed pool) never enters supply at all - it simply
  // isn't minted; burned fees are minted-out again here.
  const popSum = p.popTransfers.reduce((sum, pt) => sum + pt.amount, 0);
  const supplyRow = await tx.getMeta("totalSupply");
  const supply = supplyRow === undefined ? 0 : Number(supplyRow);
  const newSupply = supply + p.coinbaseAmount + popSum - p.feesBurned;
  await tx.setMeta("totalSupply", String(newSupply));

  // 6b. Periodic state snapshot: a LOCAL fast path for boot recovery (never
  // gossiped - remote snapshots would be unverifiable state).
  if (p.height > 0 && p.height % SNAPSHOT_INTERVAL === 0) {
    await tx.putSnapshot({
      height: p.height,
      blockHash: p.hash,
      totalSupply: newSupply,
      accounts: await tx.allAccounts(),
    });
  }

  // 7. Purge mempool rows superseded by the applied nonces.
  for (const t of p.included) {
    await tx.purgeMempoolSuperseded(t.fromAddress, t.nonce);
  }
}

// -- local miner submission --------------------------------------------------
export interface SubmitResult {
  accepted: true;
  height: number;
  hash: string;
  reward: number;
  txCount: number;
  miner: string;
}

export function submitBlock(
  templateId: string,
  timestamp: number,
  nonce: number,
): Promise<SubmitResult> {
  // committing our own mined block is a chain mutation like any other:
  // the gate marks the node updating for the (short) apply
  const done = beginChainUpdate("committing your mined block");
  return withLock(() => submitBlockLocked(templateId, timestamp, nonce)).finally(() => done());
}

async function submitBlockLocked(
  templateId: string,
  timestamp: number,
  nonce: number,
): Promise<SubmitResult> {
  const template = templates.get(templateId);
  if (!template) bad("template unknown or expired - request a fresh one");
  templates.delete(templateId);

  try {
    if (template.expiresMs <= Date.now()) bad("template expired - request a fresh one");
    const tip = await getTip();
    if (tip.hash !== template.prevHash || tip.height + 1 !== template.height) {
      bad("stale template: the chain tip moved - request a fresh one");
    }
    const now = nowSeconds();
    if (!Number.isInteger(timestamp) || timestamp < template.minTimestamp) {
      bad(`timestamp too old: must be >= ${template.minTimestamp}`);
    }
    if (timestamp > now + MAX_FUTURE_DRIFT) {
      bad("timestamp too far in the future");
    }

    const hash = dsha256Hex(
      serializeHeader({
        height: template.height,
        prevHash: template.prevHash,
        merkleRoot: template.merkleRoot,
        timestamp,
        nonce,
      }),
    );
    if (!hashMeetsTarget(hash, template.target)) bad("insufficient proof-of-work");

    try {
      await db().transact(async (tx) => {
        await applyBlockInTx(tx, {
          height: template.height,
          hash,
          prevHash: template.prevHash,
          merkleRoot: template.merkleRoot,
          timestamp,
          nonce,
          target: template.target,
          miner: template.miner,
          message: null,
          coinbaseTxid: template.coinbaseTxid,
          coinbaseAmount: template.coinbaseAmount,
          popTransfers: template.popTransfers,
          popAttestations: template.popAttestations,
          minerPeerId: template.minerPeerId,
          feesBurned: template.fees,
          included: template.included,
        });
      });
    } catch (err) {
      if (err instanceof ChainValidationError) bad(err.message);
      throw err;
    }

    invalidateInfoCache();
    fireBlockAccepted(template.height);
    return {
      accepted: true,
      height: template.height,
      hash,
      reward: template.coinbaseAmount,
      txCount: template.included.length + 1,
      miner: template.miner,
    };
  } finally {
    templates.clear(); // tip moved or template consumed - everything is stale
  }
}

// -- blocks received from peers ----------------------------------------------

/**
 * Full validation + application of a block received over the wire. The block
 * must extend our current tip by exactly one (sync walks forks separately).
 * Throws ChainValidationError on any rule violation - the peer gets a strike.
 */
export function applyWireBlock(wb: WireBlock): Promise<{ height: number; hash: string }> {
  return withLock(() => applyWireBlockLocked(wb));
}

async function applyWireBlockLocked(wb: WireBlock): Promise<{ height: number; hash: string }> {
  if (!Number.isInteger(wb.height) || wb.height < 1) {
    throw new ChainValidationError("bad height");
  }
  if (!/^[0-9a-f]{64}$/.test(wb.hash) || !/^[0-9a-f]{64}$/.test(wb.prevHash)) {
    throw new ChainValidationError("malformed hashes");
  }
  if (!/^[0-9a-f]{64}$/.test(wb.merkleRoot) || !/^[0-9a-f]{64}$/.test(wb.target)) {
    throw new ChainValidationError("malformed merkle root or target");
  }
  if (!checkAddress(wb.miner)) throw new ChainValidationError("invalid miner address");
  if (!Number.isInteger(wb.nonce) || wb.nonce < 0 || wb.nonce > Number.MAX_SAFE_INTEGER) {
    throw new ChainValidationError("bad nonce");
  }
  if (!Array.isArray(wb.txs) || wb.txs.length < 1 || wb.txs.length > MAX_TXS_PER_BLOCK + 1) {
    throw new ChainValidationError("bad tx count");
  }

  // Checkpoint pins are absolute: a pinned height accepts exactly one hash,
  // no matter how much proof-of-work a forged rewrite carries.
  const pin = checkpointHashAt(wb.height);
  if (pin !== null && wb.hash !== pin) {
    throw new ChainValidationError(
      `checkpoint mismatch at height ${wb.height} - pinned history cannot be rewritten`,
    );
  }

  const tip = await getTip();
  if (wb.height !== tip.height + 1 || wb.prevHash !== tip.hash) {
    throw new ChainValidationError("block does not extend our tip");
  }
  const expectedTarget = await expectedTargetForHeight(wb.height, tip);
  if (wb.target !== expectedTarget) {
    throw new ChainValidationError("wrong difficulty target");
  }
  const mtp = await medianTimePast();
  const minTs = Math.max(mtp + 1, tip.timestamp + 1);
  if (!Number.isInteger(wb.timestamp) || wb.timestamp < minTs) {
    throw new ChainValidationError("timestamp too old");
  }
  if (wb.timestamp > nowSeconds() + MAX_FUTURE_DRIFT) {
    throw new ChainValidationError("timestamp too far in the future");
  }
  const hash = dsha256Hex(
    serializeHeader({
      height: wb.height,
      prevHash: wb.prevHash,
      merkleRoot: wb.merkleRoot,
      timestamp: wb.timestamp,
      nonce: wb.nonce,
    }),
  );
  if (hash !== wb.hash) throw new ChainValidationError("hash does not match header");
  if (!hashMeetsTarget(hash, wb.target)) {
    throw new ChainValidationError("insufficient proof-of-work");
  }

  // -- coinbase --
  const cb = wb.txs[0];
  if (
    cb.type !== "coinbase" ||
    cb.fromAddress !== null ||
    cb.toAddress !== wb.miner ||
    cb.fee !== 0 ||
    cb.nonce !== null ||
    cb.pubkey !== null ||
    cb.signature !== null ||
    cb.timestamp !== wb.timestamp
  ) {
    throw new ChainValidationError("malformed coinbase");
  }
  // -- PoP distribution --
  // The peer list is no longer miner-declared: every recipient must be backed
  // by a peer-signed attestation (re-verified in applyBlockInTx). Here we
  // check shapes, the exact equal split and the merkle commitment.
  const pops = wb.popTransfers ?? [];
  const atts = wb.popAttestations ?? [];
  if (wb.minerPeerId !== undefined && wb.minerPeerId !== null) {
    if (typeof wb.minerPeerId !== "string" || wb.minerPeerId.length > 64) {
      throw new ChainValidationError("bad miner peer id");
    }
  }
  if (!Array.isArray(atts) || atts.length > MAX_POP_RECIPIENTS) {
    throw new ChainValidationError("bad PoP attestation list");
  }
  for (const a of atts) {
    if (
      typeof a?.address !== "string" ||
      typeof a?.pubkey !== "string" ||
      typeof a?.signature !== "string" ||
      !Number.isInteger(a?.timestamp)
    ) {
      throw new ChainValidationError("malformed PoP attestation");
    }
  }
  if (pops.length > MAX_POP_RECIPIENTS) {
    throw new ChainValidationError("too many PoP transfers");
  }
  const split = splitBlockReward(wb.height, pops.length);
  const seenPopIdx = new Set<number>();
  const popIds: string[] = [];
  for (const pt of pops) {
    if (!checkAddress(pt.address)) throw new ChainValidationError("invalid PoP address");
    if (pt.address === wb.miner) throw new ChainValidationError("miner cannot be a PoP recipient");
    if (!Number.isInteger(pt.amount) || pt.amount < 0) {
      throw new ChainValidationError("bad PoP amount");
    }
    if (pt.amount !== split.perPeer) throw new ChainValidationError("PoP share is not an equal split");
    if (!Number.isInteger(pt.index) || pt.index < 0 || pt.index >= pops.length || seenPopIdx.has(pt.index)) {
      throw new ChainValidationError("bad PoP index");
    }
    seenPopIdx.add(pt.index);
    popIds.push(
      dsha256Hex(
        serializePopTransfer({ height: wb.height, index: pt.index, to: pt.address, amount: pt.amount }),
      ),
    );
  }
  if (seenPopIdx.size !== pops.length) throw new ChainValidationError("PoP indexes not dense");

  const transfers = wb.txs.slice(1);
  const fees = transfers.reduce((s, t) => s + t.fee, 0);
  // Coinbase = the miner's 70% share of emission. Fees are NOT added - they burn.
  if (cb.amount !== split.miner) {
    throw new ChainValidationError("coinbase pays wrong amount");
  }
  const coinbaseTxid = dsha256Hex(
    serializeCoinbase({ height: wb.height, to: wb.miner, amount: cb.amount }),
  );
  if (cb.txid !== coinbaseTxid) throw new ChainValidationError("coinbase txid mismatch");

  // -- transfers: full stateless validation (state check happens in-tx) --
  const seen = new Set<string>([cb.txid]);
  const included: MempoolTxRow[] = [];
  for (const t of transfers) {
    if (t.type !== "transfer") throw new ChainValidationError("coinbase must come first");
    if (t.fromAddress === null || t.nonce === null || t.pubkey === null || t.signature === null) {
      throw new ChainValidationError("malformed transfer");
    }
    const shape: TransferInput = {
      from: t.fromAddress,
      to: t.toAddress,
      amount: t.amount,
      fee: t.fee,
      nonce: t.nonce,
      pubkey: t.pubkey,
      signature: t.signature,
    };
    if (!checkAddress(shape.from) || !checkAddress(shape.to)) {
      throw new ChainValidationError("invalid address in transfer");
    }
    if (!Number.isInteger(shape.amount) || shape.amount < 1) {
      throw new ChainValidationError("bad amount");
    }
    if (!Number.isInteger(shape.fee) || shape.fee < MIN_TX_FEE) {
      throw new ChainValidationError("fee below minimum");
    }
    if (shape.amount + shape.fee > MAX_MONEY) throw new ChainValidationError("amount too large");
    if (!Number.isInteger(shape.nonce) || shape.nonce < 0 || shape.nonce > 2 ** 31 - 1) {
      throw new ChainValidationError("bad tx nonce");
    }
    if (!Number.isInteger(t.timestamp) || t.timestamp < 1_500_000_000) {
      throw new ChainValidationError("bad tx timestamp");
    }
    if (!isValidPubkeyHex(shape.pubkey)) throw new ChainValidationError("invalid public key");
    if (addressFromPubkey(shape.pubkey) !== shape.from) {
      throw new ChainValidationError("pubkey does not match sender");
    }
    if (!verifyTransferSignature(shape)) throw new ChainValidationError("invalid signature");
    if (txidOfTransfer(shape) !== t.txid) throw new ChainValidationError("txid mismatch");
    if (seen.has(t.txid)) throw new ChainValidationError("duplicate tx in block");
    seen.add(t.txid);
    included.push({
      txid: t.txid,
      type: "transfer",
      fromAddress: t.fromAddress,
      toAddress: t.toAddress,
      amount: t.amount,
      fee: t.fee,
      nonce: t.nonce,
      pubkey: t.pubkey,
      signature: t.signature,
      timestamp: t.timestamp,
      createdAt: Date.now(),
    });
  }

  const merkle = merkleRootHex([cb.txid, ...popIds, ...included.map((t) => t.txid)]);
  if (merkle !== wb.merkleRoot) throw new ChainValidationError("merkle root mismatch");

  await db().transact(async (tx) => {
    await applyBlockInTx(tx, {
      height: wb.height,
      hash: wb.hash,
      prevHash: wb.prevHash,
      merkleRoot: wb.merkleRoot,
      timestamp: wb.timestamp,
      nonce: wb.nonce,
      target: wb.target,
      miner: wb.miner,
      message: wb.message,
      coinbaseTxid: cb.txid,
      coinbaseAmount: cb.amount,
      popTransfers: pops.map((pt) => ({ address: pt.address, amount: pt.amount, index: pt.index })),
      popAttestations: atts.map((a) => ({
        address: a.address,
        pubkey: a.pubkey,
        signature: a.signature,
        timestamp: a.timestamp,
      })),
      minerPeerId: wb.minerPeerId ?? null,
      feesBurned: fees,
      included,
    });
  });
  templates.clear(); // tip moved
  invalidateInfoCache();
  return { height: wb.height, hash: wb.hash };
}

// ===========================================================================
//  REORG ROLLBACK - undo blocks down to a fork point
// ===========================================================================

/**
 * Undoes blocks from the tip down to `targetHeight + 1`, restoring balances,
 * nonces, supply and mempool exactly. Refuses to roll back deeper than
 * MAX_REORG_DEPTH - a fork that deep needs a human, not an algorithm.
 */
export function rollbackToHeight(targetHeight: number): Promise<number> {
  const done = beginChainUpdate("rolling back to the fork point");
  return withLock(async () => {
    const tip = await getTip();
    if (!Number.isInteger(targetHeight) || targetHeight < 0 || targetHeight >= tip.height) {
      throw new ChainValidationError("invalid rollback target");
    }
    if (tip.height - targetHeight > MAX_REORG_DEPTH) {
      throw new ChainValidationError("reorg deeper than safety limit - refusing");
    }
    // Never roll back across a pinned checkpoint: that history is final.
    const floor = highestCheckpointAtOrBelow(tip.height);
    if (targetHeight < floor) {
      throw new ChainValidationError(`reorg across checkpoint #${floor} refused - pinned history is final`);
    }
    await db().transact(async (tx) => {
      for (let h = tip.height; h > targetHeight; h--) {
        await undoBlockInTx(tx, h);
      }
    });
    templates.clear();
    invalidateInfoCache();
    return targetHeight;
  }).finally(() => done());
}

async function undoBlockInTx(tx: ChainStorageTx, height: number): Promise<void> {
  const block = await tx.blockAt(height);
  if (!block) throw new ChainValidationError(`undo: block ${height} missing`);

  const blockTxs = await tx.txsInBlock(height);
  const transfers = blockTxs
    .filter((t) => t.type === "transfer")
    // reverse block order: per sender, highest nonce first
    .sort((a, b) => b.txIndex - a.txIndex || a.txid.localeCompare(b.txid));

  for (const t of transfers) {
    const sender = await tx.account(t.fromAddress!);
    if (!sender) throw new ChainValidationError("undo: sender account missing");
    await tx.putAccount({
      ...sender,
      balance: sender.balance + t.amount + t.fee,
      nonce: t.nonce!,
    });

    const recipient = await tx.account(t.toAddress);
    if (!recipient) throw new ChainValidationError("undo: recipient account missing");
    const recBal = recipient.balance - t.amount;
    if (recBal < 0) throw new ChainValidationError("undo: negative recipient balance");
    await tx.putAccount({ ...recipient, balance: recBal });

    // back to the mempool - it may be mined again on the winning chain
    await tx.putMempoolTx({
      txid: t.txid,
      type: "transfer",
      fromAddress: t.fromAddress!,
      toAddress: t.toAddress,
      amount: t.amount,
      fee: t.fee,
      nonce: t.nonce!,
      pubkey: t.pubkey!,
      signature: t.signature!,
      timestamp: t.timestamp,
      createdAt: Date.now(),
    });
  }

  // reverse PoP payouts: each recipient loses exactly the credit applied
  const popRows = blockTxs.filter((t) => t.type === "pop");
  let popSum = 0;
  for (const pop of popRows) {
    popSum += pop.amount;
    const recipient = await tx.account(pop.toAddress);
    if (!recipient) throw new ChainValidationError("undo: PoP recipient account missing");
    const bal = recipient.balance - pop.amount;
    if (bal < 0) throw new ChainValidationError("undo: negative PoP recipient balance");
    await tx.putAccount({ ...recipient, balance: bal });
  }

  // every transfer now has a mempool copy; drop the whole block's confirmed
  // rows (transfers + coinbase + PoP payouts) and then the block itself
  await tx.deleteTxsInBlock(height);

  const miner = await tx.account(block.miner);
  if (miner) {
    const mb = miner.balance - block.reward;
    if (mb < 0) throw new ChainValidationError("undo: negative miner balance");
    await tx.putAccount({
      ...miner,
      balance: mb,
      blocksMined: Math.max(0, miner.blocksMined - 1),
    });
  }

  await tx.deleteBlock(height);

  // apply minted (miner share + PoP payouts) and burned the fees, so the
  // exact reverse is: remove the minted part, re-mint the burned fees
  const feeSum = transfers.reduce((sum, t) => sum + t.fee, 0);
  const supplyRow = await tx.getMeta("totalSupply");
  const supply = supplyRow === undefined ? 0 : Number(supplyRow);
  await tx.setMeta("totalSupply", String(supply - (block.reward + popSum - feeSum)));
}

// ===========================================================================
//  READ VIEWS (UI layer)
// ===========================================================================

const HASHRATE_WINDOW = 30;

/**
 * Micro-cache for the network snapshot. `info` is the most-polled view on the
 * node (every open terminal tab, every few seconds) and computes several
 * aggregate scans; a 2-second TTL collapses that load while staying fresher
 * than any UI can perceive. Every state mutation calls invalidateInfoCache(),
 * so the cache never survives a change for longer than the TTL.
 */
const INFO_CACHE_TTL_MS = 2_000;
let infoCache: { at: number; value: InfoView } | null = null;

export function invalidateInfoCache(): void {
  infoCache = null;
}

/** Genesis hash is immutable once sealed - cache it for the tab's lifetime. */
let cachedGenesisHash: string | null = null;

async function genesisHash(): Promise<string> {
  if (!cachedGenesisHash) {
    const g = await db().blockAt(0);
    if (!g) throw new Error("chain not initialized");
    cachedGenesisHash = g.hash;
  }
  return cachedGenesisHash;
}

type InfoView = Awaited<ReturnType<typeof computeInfo>>;

export async function getInfo(): Promise<InfoView> {
  const now = Date.now();
  if (infoCache && now - infoCache.at < INFO_CACHE_TTL_MS) return infoCache.value;
  const value = await computeInfo();
  infoCache = { at: now, value };
  return value;
}

// -- total burned (derived: everything ever emitted minus what still exists) --
// Block rewards are a pure function of height, so the lifetime emission sum
// can be cached BY HEIGHT and extended incrementally - one getBlockReward per
// new block. A rollback/import that lowers the tip rebuilds the sum from
// scratch (rare, and even 100k heights are a few ms of Math.exp). Fees and
// unminted shares need no tracking of their own: they are exactly the gap
// between lifetime emission and the live totalSupply.
let emissionCache = { height: 0, sum: 0 };

function emissionSumThrough(height: number): number {
  if (height < emissionCache.height) emissionCache = { height: 0, sum: 0 };
  for (let h = emissionCache.height + 1; h <= height; h++) {
    emissionCache.sum += getBlockReward(h);
  }
  emissionCache.height = height;
  return emissionCache.sum;
}

async function computeInfo() {
  const s = db();
  const tip = await getTip();
  const height = tip.height;

  const window = await s.hashrateWindow(HASHRATE_WINDOW);

  let hashrate = 0;
  let avgBlockTime: number | null = null;
  if (window.length >= 2) {
    // Genesis is excluded: it carries a fixed historic timestamp (by design),
    // so including it would poison the span with ~27 years of fake block time.
    const ordered = window
      .filter((b) => b.height > 0)
      .sort((a, b) => a.height - b.height);
    const span = ordered[ordered.length - 1].timestamp - ordered[0].timestamp;
    const intervals = ordered.length - 1;
    if (span > 0) {
      const expectedHashes = ordered
        .slice(1)
        .reduce((sum, b) => sum + b.difficulty * HASHES_AT_DIFFICULTY_1, 0);
      hashrate = expectedHashes / span;
      avgBlockTime = span / intervals;
    }
  }

  const [mempoolSize, txsTotal, activeAccounts, totalSupply] = await Promise.all([
    s.mempoolCount(),
    s.confirmedCount(),
    s.activeAccountCount(),
    getTotalSupply(),
  ]);

  return {
    chainId: CHAIN_ID,
    protocolVersion: P2P_VERSION,
    height,
    tipHash: tip.hash,
    tipTimestamp: tip.timestamp,
    target: tip.target,
    difficulty: difficultyOf(tip.target),
    hashrate,
    avgBlockTime,
    mempoolSize,
    txsTotal,
    activeAccounts,
    peerCount: peerCountProvider(),
    totalSupply,
    // exact by construction: every base unit ever emitted either still exists
    // in totalSupply or was burned (split burn + dust + unclaimed PoP + fees)
    totalBurned: emissionSumThrough(height) - totalSupply,
    blockReward: getBlockReward(height + 1),
    // what the next block would pay right now, given the current attestations
    rewardSplit: splitBlockReward(height + 1, popAttestationsProvider().length),
    nextRetargetIn:
      height % RETARGET_INTERVAL === 0
        ? RETARGET_INTERVAL
        : RETARGET_INTERVAL - (height % RETARGET_INTERVAL),
    bootstrapBlocksLeft: Math.max(0, BOOTSTRAP_BLOCKS - (height + 1)),
    genesisHash: await genesisHash(),
    genesisMessage: GENESIS_MESSAGE,
    serverTime: nowSeconds(),
  };
}

export async function getRecentBlocks(limit: number): Promise<BlockRow[]> {
  return db().recentBlocks(Math.min(limit, 100));
}

export async function getRecentTxs(limit: number): Promise<TxRow[]> {
  return db().recentTxs(Math.min(limit, 100));
}

export async function getMempool(limit = 100): Promise<MempoolTxRow[]> {
  const rows = await db().mempool();
  return rows.slice(0, Math.min(limit, 100));
}

/**
 * Local mempool rows for re-gossip. Relay convenience, NOT consensus:
 * receivers dedupe by txid and run full admission checks on every row,
 * so sharing stale rows is always safe.
 */
export async function getLocalMempool(): Promise<MempoolTxRow[]> {
  return db().mempool();
}

export async function getAddressOverview(address: string) {
  if (!checkAddress(address)) bad("invalid address (checksum failed)");
  const s = db();
  const tip = await getTip();
  const acc = await s.account(address);

  const pending = await s.mempoolForAddress(address);
  const pendingOut = pending.filter((t) => t.fromAddress === address);
  const pendingSpend = pendingOut.reduce((sum, t) => sum + t.amount + t.fee, 0);
  const history = await s.txHistoryFor(address, 50);

  return {
    address,
    balance: acc?.balance ?? 0,
    available: (acc?.balance ?? 0) - pendingSpend,
    nonce: acc?.nonce ?? 0,
    nextNonce: (acc?.nonce ?? 0) + pendingOut.length,
    blocksMined: acc?.blocksMined ?? 0,
    pending,
    history,
    tipHeight: tip.height,
  };
}

// ===========================================================================
//  WIRE VIEWS (P2P layer)
// ===========================================================================

/** Tip height + hash - cheap sync check. */
export async function getTipSummary(): Promise<{ height: number; hash: string }> {
  const tip = await getTip();
  return { height: tip.height, hash: tip.hash };
}

/** Genesis hash - the network's DNA. Peers with a different one are not us. */
export async function getGenesisHash(): Promise<string> {
  return genesisHash();
}

/** A block and its txs in exact block order, ready for the wire. */
export async function getWireBlock(height: number): Promise<WireBlock | null> {
  const s = db();
  const b = await s.blockAt(height);
  if (!b) return null;
  const prunedBelow = Number((await s.getMeta("prunedBelow")) ?? "0");
  if (height < prunedBelow) return null; // txs pruned - cannot serve this height
  const blockTxs = await s.txsInBlock(height);
  return {
    height: b.height,
    hash: b.hash,
    prevHash: b.prevHash,
    merkleRoot: b.merkleRoot,
    timestamp: b.timestamp,
    nonce: b.nonce,
    target: b.target,
    miner: b.miner,
    message: b.message,
    popTransfers: b.popTransfers.map((pt: PopTransfer) => ({
      address: pt.address,
      amount: pt.amount,
      index: pt.index,
    })),
    minerPeerId: b.minerPeerId,
    popAttestations: b.popAttestations.map((a) => ({
      address: a.address,
      pubkey: a.pubkey,
      signature: a.signature,
      timestamp: a.timestamp,
    })),
    // PoP payouts ride in `popTransfers`, not the tx list - the wire tx array
    // stays exactly [coinbase, ...transfers] for merkle/signature checks
    txs: blockTxs
      .filter((t) => t.type !== "pop")
      .map((t) => ({
        txid: t.txid,
        type: t.type as "coinbase" | "transfer",
        fromAddress: t.fromAddress,
        toAddress: t.toAddress,
        amount: t.amount,
        fee: t.fee,
        nonce: t.nonce,
        pubkey: t.pubkey,
        signature: t.signature,
        timestamp: t.timestamp,
      })),
  };
}

// ===========================================================================
//  CHAIN EXPORT / IMPORT - portability across site migrations
// ===========================================================================

export interface ChainExport {
  format: "bitweb-chain-1";
  chainId: string;
  height: number;
  exportedAt: number;
  blocks: WireBlock[];
}

/**
 * Raised when an import meets a local chain that has already moved past
 * genesis and disagrees with the file. Carries BOTH tips so the UI can show
 * them side by side and demand an explicit, informed confirmation before
 * anything is replaced. Never thrown when the file simply continues what we
 * already have (same tip = idempotent no-op).
 */
export class ChainConflictError extends Error {
  readonly name: string = "ChainConflictError";
  /** "fork" = equal height, different tip. Downgrades use the subclass below. */
  readonly kind: "fork" | "downgrade" = "fork";
  readonly local: { height: number; hash: string };
  readonly incoming: { height: number; hash: string };
  constructor(local: { height: number; hash: string }, incoming: { height: number; hash: string }) {
    super(
      `local chain tip (#${local.height} ${local.hash.slice(0, 16)}...) differs from the file ` +
        `(#${incoming.height} ${incoming.hash.slice(0, 16)}...) - explicit confirmation required`,
    );
    this.local = local;
    this.incoming = incoming;
  }
}

/**
 * The file is SHORTER than the local chain: importing it would silently
 * delete blocks. Blocked by default - even { replace: true } is not enough.
 * Only { replace: true, allowDowngrade: true } (the UI's dangerous-override
 * dialog, which shows BOTH heights AND BOTH tip hashes) unlocks it, and the
 * override is logged.
 */
export class ChainDowngradeError extends ChainConflictError {
  readonly name = "ChainDowngradeError";
  readonly kind = "downgrade" as const;
  constructor(local: { height: number; hash: string }, incoming: { height: number; hash: string }) {
    super(local, incoming);
    this.message =
      `Imported chain is SHORTER (H:${incoming.height}) than your local chain ` +
      `(H:${local.height}). Importing would lose ${local.height - incoming.height} block(s). Blocked.`;
    Object.setPrototypeOf(this, ChainDowngradeError.prototype);
  }
}

// -- strict schema -------------------------------------------------------------
// The export file is untrusted input. It is rebuilt field by field against a
// whitelist: unknown fields are dropped, wrong types are rejected. Nothing
// from the file reaches the chain - or the DOM - unless it passes here first.

const HEX64_RE = /^[0-9a-f]{64}$/;
const MAX_BLOCKS_PER_EXPORT = 1_000_000;
const MAX_BLOCK_MESSAGE_CHARS = 4_096;

function asRecord(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) bad(`${what}: not an object`);
  return v as Record<string, unknown>;
}
function asInt(v: unknown, what: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) {
    bad(`${what}: bad integer`);
  }
  return v;
}
function asStr(v: unknown, what: string, maxLen: number): string {
  if (typeof v !== "string" || v.length > maxLen) bad(`${what}: bad string`);
  return v;
}
function asHex64(v: unknown, what: string): string {
  if (typeof v !== "string" || !HEX64_RE.test(v)) bad(`${what}: malformed hash`);
  return v;
}
function asOptStr(v: unknown, what: string, maxLen: number): string | null {
  if (v === null || v === undefined) return null;
  return asStr(v, what, maxLen);
}

function sanitizeWireTx(v: unknown): WireTx {
  const o = asRecord(v, "tx");
  if (o.type !== "coinbase" && o.type !== "transfer") bad("tx: unknown type");
  return {
    txid: asHex64(o.txid, "tx.txid"),
    type: o.type,
    fromAddress: asOptStr(o.fromAddress, "tx.fromAddress", 128),
    toAddress: asStr(o.toAddress, "tx.toAddress", 128),
    amount: asInt(o.amount, "tx.amount", 0, MAX_MONEY),
    fee: asInt(o.fee, "tx.fee", 0, MAX_MONEY),
    nonce: o.nonce === null || o.nonce === undefined ? null : asInt(o.nonce, "tx.nonce", 0, 2 ** 31 - 1),
    pubkey: asOptStr(o.pubkey, "tx.pubkey", 256),
    signature: asOptStr(o.signature, "tx.signature", 256),
    timestamp: asInt(o.timestamp, "tx.timestamp", 0, Number.MAX_SAFE_INTEGER),
  };
}

function sanitizeWireBlock(v: unknown): WireBlock {
  const o = asRecord(v, "block");
  if (!Array.isArray(o.txs) || o.txs.length < 1 || o.txs.length > MAX_TXS_PER_BLOCK + 1) {
    bad("block: bad tx count");
  }
  if (o.popTransfers !== undefined && !Array.isArray(o.popTransfers)) bad("block: bad PoP list");
  if (o.popAttestations !== undefined && !Array.isArray(o.popAttestations)) {
    bad("block: bad PoP attestation list");
  }
  return {
    height: asInt(o.height, "block.height", 0, Number.MAX_SAFE_INTEGER),
    hash: asHex64(o.hash, "block.hash"),
    prevHash: asHex64(o.prevHash, "block.prevHash"),
    merkleRoot: asHex64(o.merkleRoot, "block.merkleRoot"),
    timestamp: asInt(o.timestamp, "block.timestamp", 1, Number.MAX_SAFE_INTEGER),
    nonce: asInt(o.nonce, "block.nonce", 0, Number.MAX_SAFE_INTEGER),
    target: asHex64(o.target, "block.target"),
    miner: asStr(o.miner, "block.miner", 128),
    message: asOptStr(o.message, "block.message", MAX_BLOCK_MESSAGE_CHARS),
    txs: o.txs.map(sanitizeWireTx),
    popTransfers: (o.popTransfers ?? []).map((p: unknown) => {
      const r = asRecord(p, "popTransfer");
      return {
        address: asStr(r.address, "pop.address", 128),
        amount: asInt(r.amount, "pop.amount", 0, MAX_MONEY),
        index: asInt(r.index, "pop.index", 0, MAX_POP_RECIPIENTS),
      };
    }),
    minerPeerId: asOptStr(o.minerPeerId, "block.minerPeerId", 64),
    popAttestations: (o.popAttestations ?? []).map((a: unknown) => {
      const r = asRecord(a, "popAttestation");
      return {
        address: asStr(r.address, "attestation.address", 128),
        pubkey: asStr(r.pubkey, "attestation.pubkey", 256),
        signature: asStr(r.signature, "attestation.signature", 256),
        timestamp: asInt(r.timestamp, "attestation.timestamp", 0, Number.MAX_SAFE_INTEGER),
      };
    }),
  };
}

/**
 * Parses an unknown blob into a clean ChainExport. Every surviving field is
 * type-checked; everything else is dropped. Throws on the first violation.
 */
export function sanitizeChainExport(data: unknown): ChainExport {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    bad("not a bitweb chain export");
  }
  const o = data as Record<string, unknown>;
  if (o.format !== "bitweb-chain-1") bad("not a bitweb chain export");
  if (
    !Array.isArray(o.blocks) ||
    o.blocks.length < 1 ||
    o.blocks.length > MAX_BLOCKS_PER_EXPORT
  ) {
    bad("not a bitweb chain export");
  }
  const blocks = o.blocks.map(sanitizeWireBlock);
  const height = asInt(o.height, "export.height", 0, Number.MAX_SAFE_INTEGER);
  if (height !== blocks[blocks.length - 1].height) {
    bad("declared height does not match the last block");
  }
  return {
    format: "bitweb-chain-1",
    chainId: asStr(o.chainId, "export.chainId", 128),
    height,
    exportedAt: asInt(o.exportedAt, "export.exportedAt", 0, Number.MAX_SAFE_INTEGER),
    blocks,
  };
}

// -- zero-trust file validation -------------------------------------------------

/**
 * Full static validation of an export file with ZERO storage access. Every
 * block hash is recomputed from its PoW preimage and checked against the
 * target schedule implied by the file itself; linkage, height sequence,
 * timestamp rules, miner cooldown, the coinbase amount and miner binding,
 * PoP splits and attestation signatures, merkle roots, transfer signatures
 * and the checkpoint pins are all verified - and the entire monetary ledger
 * is replayed in memory (balances + nonces, credited at end of block exactly
 * like applyBlockInTx) so a file that overspends never reaches storage.
 * Throws on the FIRST failure: an import is all-or-nothing, never partial.
 *
 * Cooperative slicing: a full replay is PURE CPU (PoW rehash per block, every
 * secp256k1 signature, the whole ledger) - on a grown chain that is minutes
 * of unbroken main-thread work, which is exactly what made Safari declare
 * the page unresponsive and beach-ball the whole browser. The loop below
 * hands the event loop a macrotask every ~VALIDATE_SLICE_MS so paint, input
 * and IDB callbacks stay alive. Validation ORDER and semantics are
 * bit-identical to the synchronous version - only scheduling changes.
 */
const VALIDATE_SLICE_MS = 12;

async function validateExportBlocks(blocks: WireBlock[]): Promise<void> {
  const g = genesisParts();
  const first = blocks[0];
  if (
    first.height !== 0 ||
    first.hash !== g.hash ||
    first.prevHash !== GENESIS_PREV_HASH ||
    first.merkleRoot !== g.merkleRoot ||
    first.timestamp !== g.ts ||
    first.nonce !== 0 ||
    first.miner !== g.zeroAddr ||
    first.message !== GENESIS_MESSAGE ||
    first.minerPeerId !== null ||
    (first.popTransfers?.length ?? 0) > 0 ||
    (first.popAttestations?.length ?? 0) > 0 ||
    first.txs.length !== 1 ||
    first.txs[0].type !== "coinbase" ||
    first.txs[0].txid !== g.cbTxid ||
    first.txs[0].amount !== 0
  ) {
    bad("export does not start from our genesis");
  }

  const ledger = new Map<string, { nonce: number; balance: number }>();
  const seenTxids = new Set<string>([g.cbTxid]);
  const acct = (a: string) => {
    let e = ledger.get(a);
    if (!e) {
      e = { nonce: 0, balance: 0 };
      ledger.set(a, e);
    }
    return e;
  };

  let sliceStartedAt = Date.now();
  const validateTotal = blocks.length - 1;
  for (let i = 1; i < blocks.length; i++) {
    if (Date.now() - sliceStartedAt >= VALIDATE_SLICE_MS) {
      // Progress rides the same gate channel as the apply phase, so a long
      // validation shows live numbers instead of looking frozen.
      setChainGateDetail(`validating block ${i}/${validateTotal}`);
      setChainGateProgress(i, validateTotal);
      await new Promise((r) => setTimeout(r, 0));
      sliceStartedAt = Date.now();
    }
    const wb = blocks[i];
    const prev = blocks[i - 1];
    if (wb.height !== i) bad(`height gap in export at block ${wb.height}`);
    if (wb.prevHash !== prev.hash) bad(`broken linkage at height ${wb.height}`);

    const pin = checkpointHashAt(wb.height);
    if (pin !== null && wb.hash !== pin) {
      bad(`checkpoint mismatch at height ${wb.height} - pinned history cannot be rewritten`);
    }

    // target schedule, replayed from the file's own prefix
    let expectedTarget: string;
    if (wb.height % RETARGET_INTERVAL === 0) {
      const firstInWindow = blocks[wb.height - RETARGET_INTERVAL];
      if (!firstInWindow) bad("retarget window missing from export");
      expectedTarget = retargetTargetHex(prev.target, prev.timestamp - firstInWindow.timestamp);
    } else {
      expectedTarget = prev.target;
    }
    if (wb.target !== expectedTarget) bad("wrong difficulty target");

    // timestamps: median-time-past over the file prefix, strictly increasing
    const windowStart = Math.max(0, i - MEDIAN_TIME_SPAN);
    const times = blocks
      .slice(windowStart, i)
      .map((b) => b.timestamp)
      .sort((a, b) => a - b);
    const mtp = times[Math.floor((times.length - 1) / 2)];
    if (wb.timestamp < Math.max(mtp + 1, prev.timestamp + 1)) bad("timestamp too old");
    if (wb.timestamp > nowSeconds() + MAX_FUTURE_DRIFT) bad("timestamp too far in the future");

    // proof-of-work: recompute the hash from the header preimage
    const hash = dsha256Hex(
      serializeHeader({
        height: wb.height,
        prevHash: wb.prevHash,
        merkleRoot: wb.merkleRoot,
        timestamp: wb.timestamp,
        nonce: wb.nonce,
      }),
    );
    if (hash !== wb.hash) bad("hash does not match header");
    if (!hashMeetsTarget(hash, wb.target)) bad("insufficient proof-of-work");

    if (!checkAddress(wb.miner)) bad("invalid miner address");
    if (violatesMinerCooldown(wb.height, wb.miner, prev.miner)) {
      bad("miner cooldown: same miner as the previous block");
    }

    // coinbase: bound to the miner, paying exactly the 70% share for the height
    const cb = wb.txs[0];
    if (
      cb.type !== "coinbase" ||
      cb.fromAddress !== null ||
      cb.toAddress !== wb.miner ||
      cb.fee !== 0 ||
      cb.nonce !== null ||
      cb.pubkey !== null ||
      cb.signature !== null ||
      cb.timestamp !== wb.timestamp
    ) {
      bad("malformed coinbase");
    }
    const pops = wb.popTransfers ?? [];
    const atts = wb.popAttestations ?? [];
    const split = splitBlockReward(wb.height, pops.length);
    if (cb.amount !== split.miner) bad("coinbase pays wrong amount");
    const coinbaseTxid = dsha256Hex(
      serializeCoinbase({ height: wb.height, to: wb.miner, amount: cb.amount }),
    );
    if (cb.txid !== coinbaseTxid) bad("coinbase txid mismatch");
    if (seenTxids.has(cb.txid)) bad("duplicate coinbase id");
    seenTxids.add(cb.txid);

    // PoP credits: shapes, the exact equal split, dense indexes, signatures
    if (pops.length > MAX_POP_RECIPIENTS) bad("too many PoP transfers");
    const seenIdx = new Set<number>();
    const popIds: string[] = [];
    for (const pt of pops) {
      if (!checkAddress(pt.address)) bad("invalid PoP address");
      if (pt.address === wb.miner) bad("miner cannot be a PoP recipient");
      if (pt.amount !== split.perPeer) bad("PoP share is not an equal split");
      if (pt.index < 0 || pt.index >= pops.length || seenIdx.has(pt.index)) bad("bad PoP index");
      seenIdx.add(pt.index);
      popIds.push(
        dsha256Hex(serializePopTransfer({ height: wb.height, index: pt.index, to: pt.address, amount: pt.amount })),
      );
    }
    if (seenIdx.size !== pops.length) bad("PoP indexes not dense");
    if (
      !validatePoPAttestations({
        minerPeerId: wb.minerPeerId ?? null,
        miner: wb.miner,
        timestamp: wb.timestamp,
        popTransfers: pops,
        popAttestations: atts,
      })
    ) {
      bad("invalid PoP attestations");
    }

    // transfers: full stateless validation, then ledger replay. Recipient
    // credits land at END OF BLOCK - exactly like applyBlockInTx's delta
    // merge - so an in-block chained spend fails here just as on-chain.
    const blockCredits: Array<[string, number]> = [[wb.miner, cb.amount]];
    for (const pt of pops) blockCredits.push([pt.address, pt.amount]);
    const includedIds: string[] = [];
    for (const t of wb.txs.slice(1)) {
      if (t.type !== "transfer") bad("coinbase must come first");
      if (t.fromAddress === null || t.nonce === null || t.pubkey === null || t.signature === null) {
        bad("malformed transfer");
      }
      if (!checkAddress(t.fromAddress) || !checkAddress(t.toAddress)) {
        bad("invalid address in transfer");
      }
      if (t.amount < 1) bad("bad amount");
      if (t.fee < MIN_TX_FEE) bad("fee below minimum");
      if (t.amount + t.fee > MAX_MONEY) bad("amount too large");
      if (t.timestamp < 1_500_000_000) bad("bad tx timestamp");
      if (!isValidPubkeyHex(t.pubkey)) bad("invalid public key");
      if (addressFromPubkey(t.pubkey) !== t.fromAddress) bad("pubkey does not match sender");
      const shape: TransferInput = {
        from: t.fromAddress,
        to: t.toAddress,
        amount: t.amount,
        fee: t.fee,
        nonce: t.nonce,
        pubkey: t.pubkey,
        signature: t.signature,
      };
      if (!verifyTransferSignature(shape)) bad("invalid signature");
      if (txidOfTransfer(shape) !== t.txid) bad("txid mismatch");
      if (seenTxids.has(t.txid)) bad("duplicate tx in export");
      seenTxids.add(t.txid);
      const st = acct(t.fromAddress);
      if (st.nonce !== t.nonce) bad(`tx ${t.txid.slice(0, 12)}... nonce invalidated by chain state`);
      if (st.balance < t.amount + t.fee) {
        bad(`tx ${t.txid.slice(0, 12)}... insufficient funds at apply time`);
      }
      st.nonce += 1;
      st.balance -= t.amount + t.fee;
      blockCredits.push([t.toAddress, t.amount]);
      includedIds.push(t.txid);
    }

    // merkle commitment, recomputed from the file's own transactions
    const merkle = merkleRootHex([cb.txid, ...popIds, ...includedIds]);
    if (merkle !== wb.merkleRoot) bad("merkle root mismatch");

    for (const [addr, amount] of blockCredits) acct(addr).balance += amount;
  }
}

// -- export-time secret net ------------------------------------------------------

const SECRET_FIELD_NAME = /priv|secret|seed|wif|password/i;

function assertNoSecretFields(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoSecretFields(v, `${path}[${i}]`));
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_FIELD_NAME.test(k)) {
        throw new Error(`export refused: secret-like field "${path}.${k}"`);
      }
      assertNoSecretFields(v, `${path}.${k}`);
    }
  }
}

/**
 * Safety net between the chain and the file on disk. The chain is public
 * data and the wallet store is never read by export, so this should be a
 * no-op - but if any future code path ever smuggles key material into a
 * block field, the export dies loudly instead of leaking it. When the
 * caller knows a secret (its own wallet key hex), the serialized payload is
 * additionally scanned for that exact string.
 */
export function assertExportCarriesNoSecrets(data: ChainExport, knownSecrets: string[] = []): void {
  assertNoSecretFields(data, "export");
  const json = JSON.stringify(data);
  for (const s of knownSecrets) {
    if (s && s.length >= 32 && json.includes(s)) {
      throw new Error("export refused: wallet key material detected in payload");
    }
  }
}

/**
 * Serializes the whole local chain (genesis .. tip) as a portable file for
 * site migration: the chain survives the domain it is served from. Fails
 * loudly if any height is unavailable locally (pruned history cannot be
 * exported - pruning and full portability are mutually exclusive). The
 * output carries only whitelisted public chain fields - no secrets, ever.
 */
export async function exportChain(): Promise<ChainExport> {
  const tip = await getTip();
  const blocks: WireBlock[] = [];
  for (let h = 0; h <= tip.height; h++) {
    const wb = await getWireBlock(h);
    if (!wb) {
      throw new ChainValidationError(`export: block ${h} unavailable (history pruned)`);
    }
    blocks.push(sanitizeWireBlock(wb)); // whitelist serialization: exactly the wire fields
  }
  const data: ChainExport = {
    format: "bitweb-chain-1",
    chainId: CHAIN_ID,
    height: tip.height,
    exportedAt: nowSeconds(),
    blocks,
  };
  assertExportCarriesNoSecrets(data);
  return data;
}

/**
 * Wipes the chain stores and reseals the deterministic genesis. The wallet
 * store is NOT touched - replacing the chain must never cost anyone their
 * keys. There is no undo: callers must fully validate whatever replaces the
 * old chain BEFORE this runs (importChain does exactly that).
 */
async function resetChainToGenesisLocked(): Promise<void> {
  await db().deleteAll();
  await bootstrapGenesis();
  templates.clear();
  invalidateInfoCache();
}

export function resetChainToGenesis(): Promise<void> {
  return withLock(resetChainToGenesisLocked);
}

/** What an import did. `applied: false` = the file's tip was already ours. */
export interface ImportResult {
  height: number;
  applied: boolean;
}

export interface ImportOptions {
  /** Explicit confirmation for an equal-height fork (default: keep local). */
  replace?: boolean;
  /**
   * Dangerous override for a SHORTER file. Requires `replace` as well; the
   * UI must show both heights and both tip hashes before setting this.
   */
  allowDowngrade?: boolean;
}

/**
 * Imports a chain export. Zero trust: the whole file is schema-sanitized and
 * statically validated (every hash, the target schedule, linkage, cooldown,
 * coinbase splits, merkle roots, signatures, checkpoints, a full in-memory
 * ledger replay) BEFORE a single write, then applied through the exact
 * wire-sync path. Height rules, evaluated against the LOCAL tip:
 * - same tip hash: idempotent no-op ("already up to date"), applied: false.
 * - file SHORTER than local: ChainDowngradeError by default - importing
 *   would lose blocks. Only { replace, allowDowngrade } applies it, and the
 *   override is logged with both heights and both tip hashes.
 * - equal height, different tip: ChainConflictError (kind "fork"); the
 *   default is ALWAYS keep-local, { replace: true } opts into the file.
 * - file LONGER than local (the normal case): applied directly.
 * Balances/spendable are the derived state of the applied blocks, so they
 * are recomputed by construction on every path that mutates the chain.
 */
export async function importChain(data: unknown, opts?: ImportOptions): Promise<ImportResult> {
  // From the first byte of validation to the last applied block the gate
  // is held: mining cannot start, running mining pauses, and the UPDATING
  // overlay stays up until balances/supply are fully recomputed below.
  const gateDone = beginChainUpdate("importing a chain file");
  try {
    setChainGateDetail("validating file");
    const file = sanitizeChainExport(data);
    if (file.chainId !== CHAIN_ID) {
      bad("chain id mismatch - this export is from another network");
    }
    // all-or-nothing: prove the file in full before touching storage
    await validateExportBlocks(file.blocks);
    const fileTip = file.blocks[file.blocks.length - 1];

    return await withLock(async () => {
      const tip = await getTip();
      const local = { height: tip.height, hash: tip.hash };
      const incoming = { height: file.height, hash: fileTip.hash };
      if (fileTip.hash === tip.hash) return { height: tip.height, applied: false };

      const applyFile = async (): Promise<ImportResult> => {
        try {
          if (tip.height > 0) await resetChainToGenesisLocked();
          const total = file.blocks.length - 1;
          for (let i = 1; i < file.blocks.length; i++) {
            await applyWireBlockLocked(file.blocks[i]);
            // 32-block cadence: progress stays live without drowning the
            // overlay in one event per block on huge files
            if (i % 32 === 0 || i === total) {
              setChainGateDetail(`applying block ${i}/${total}`);
              setChainGateProgress(i, total);
            }
          }
        } catch (err) {
          // the file passed static validation, so this is unreachable in
          // practice - but if it ever happens, nothing partial may survive
          await resetChainToGenesisLocked();
          throw err;
        }
        return { height: file.height, applied: true };
      };

      // NEVER downgrade by default: a shorter file would lose local blocks.
      if (file.height < tip.height) {
        if (!opts?.replace || !opts?.allowDowngrade) {
          throw new ChainDowngradeError(local, incoming);
        }
        console.warn(
          `[bitweb] DANGEROUS OVERRIDE: replacing LONGER local chain #${local.height} ` +
            `(${local.hash}) with SHORTER import #${incoming.height} (${incoming.hash}) - ` +
            `${local.height - incoming.height} block(s) lost`,
        );
        return applyFile();
      }

      // Equal-length fork: the default is keep-local; replace is opt-in.
      if (file.height === tip.height && tip.height > 0 && !opts?.replace) {
        throw new ChainConflictError(local, incoming);
      }

      // Longer file (normal case), a confirmed fork, or a fresh node: apply.
      return applyFile();
    });
  } finally {
    gateDone();
  }
}

/**
 * Adopt a fully-downloaded REMOTE chain (deep-fork repair during sync).
 * Same zero-trust discipline as importChain: the candidate is proven in
 * memory FIRST (validateExportBlocks replays every hash, target, timestamp,
 * signature, PoP split and the whole monetary ledger), and local storage is
 * wiped only after that proof - so a peer serving garbage can never destroy
 * a valid local chain. The caller (p2p sync) holds the chain gate and has
 * already confirmed the remote chain is strictly longer. Returns the new
 * tip height.
 */
export function adoptRemoteChain(blocks: WireBlock[]): Promise<number> {
  if (blocks.length === 0) throw new ChainValidationError("empty remote chain");
  return withLock(async () => {
    await validateExportBlocks(blocks);
    const tip = await getTip();
    if (tip.height > 0) await resetChainToGenesisLocked();
    try {
      const total = blocks.length - 1;
      for (let i = 1; i < blocks.length; i++) {
        await applyWireBlockLocked(blocks[i]);
        // 32-block cadence: progress stays live without one event per block
        if (i % 32 === 0 || i === total) {
          setChainGateDetail(`applying block ${i}/${total}`);
          setChainGateProgress(i, total);
        }
      }
    } catch (err) {
      // Static validation already passed, so this is unreachable in
      // practice - but if it ever happens, nothing partial may survive.
      await resetChainToGenesisLocked();
      throw err;
    }
    const newTip = blocks[blocks.length - 1];
    for (const cb of chainHooks.onChainReplaced) {
      try {
        cb({ height: newTip.height, hash: newTip.hash });
      } catch {
        /* notifications must never break consensus */
      }
    }
    return newTip.height;
  });
}

/**
 * Pruning strategy (opt-in, off by default): delete confirmed TRANSACTIONS
 * below `keepFromHeight` - block headers always stay - and record the water
 * mark in meta.prunedBelow. Balances are already the derived state, so the
 * node keeps validating and mining; it simply stops being able to SERVE
 * historical blocks to syncing peers (they fetch those heights elsewhere).
 * Never prunes within the reorg window: rollback needs the txs of the last
 * MAX_REORG_DEPTH blocks.
 */
export function pruneConfirmedTxsBelow(keepFromHeight: number): Promise<number> {
  const done = beginChainUpdate("pruning old history");
  return withLock(async () => {
    const tip = await getTip();
    const safeHorizon = tip.height - MAX_REORG_DEPTH;
    if (keepFromHeight > safeHorizon) {
      bad(`refusing to prune: horizon ${keepFromHeight} is inside the reorg window`);
    }
    let removed = 0;
    await db().transact(async (tx) => {
      for (let h = 0; h < keepFromHeight; h++) {
        const rows = await tx.txsInBlock(h);
        if (rows.length > 0) {
          await tx.deleteTxsInBlock(h);
          removed += rows.length;
        }
      }
      await tx.setMeta("prunedBelow", String(keepFromHeight));
    });
    return removed;
  }).finally(() => done());
}
