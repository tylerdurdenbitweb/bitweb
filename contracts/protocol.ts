/**
 * ===========================================================================
 *  BITWEB (BTWB) - PROTOCOL SPECIFICATION v1
 * ===========================================================================
 *
 *  This file is the single source of truth for the BitWeb consensus rules.
 *  It is shared verbatim between the reference node (api/) and every browser
 *  client (src/). Changing any constant or serialization here after genesis
 *  constitutes a hard fork.
 *
 *  Design goals vs. Bitcoin:
 *    - 60s block target (vs 600s)            -> faster first confirmation
 *    - retarget every 8 blocks (vs 2016)      -> difficulty tracks hashrate
 *    - max timestamp drift 15 min (vs 2 h)   -> tighter timestamp security
 *    - account model + sequential nonces     -> replay protection built-in,
 *                                              no change-address complexity
 *    - mining requires only a browser tab    -> one browser, one vote
 *    - ~2k lines of auditable TypeScript     -> the spec IS the code
 * ===========================================================================
 */

// -- identity ----------------------------------------------------------------
// This build is the MAINNET. The chain id is baked into every v2 signature
// (BTWBTX2|bitweb-mainnet-1|...), so coins and signatures can never cross
// over to a testnet or a lookalike fork.
export const CHAIN_ID = "bitweb-mainnet-1";
export const PROTOCOL_VERSION = 1;
export const TICKER = "BTWB";
export const ADDRESS_PREFIX = "btw1";

// -- monetary policy ---------------------------------------------------------
export const COIN = 100_000_000; // base units ("webs") per 1 BTWB
// SOFT CAP: the emission curve approaches this asymptotically - it is a
// reference point, NOT a hard limit. Nothing in consensus enforces it.
export const SOFT_CAP_SUPPLY = 42_000_000 * COIN; // base units
export const INITIAL_SUBSIDY = 50 * COIN; // base emission per block
// Bootstrap era: the first BOOTSTRAP_BLOCKS blocks pay 10x to seed the network.
export const BOOTSTRAP_MULTIPLIER = 10;
export const BOOTSTRAP_BLOCKS = 1_000;
// After bootstrap, emission decays exponentially: reward(h) =
// floor(INITIAL_SUBSIDY * e^(-EMISSION_DECAY_RATE * (h - BOOTSTRAP_BLOCKS))).
export const EMISSION_DECAY_RATE = 0.000005;
// Sanity bound for a single transfer (never reachable in practice).
export const MAX_MONEY = SOFT_CAP_SUPPLY;

// -- block reward distribution (PoW / PoP / burn) ----------------------------
// 70% to the miner - 20% divided equally among participating peers (PoP) -
// 10% burned forever. All rounding dust and any unclaimed PoP share (zero
// eligible peers) burns too - conservation is exact.
export const MINER_SHARE_PCT = 0.7;
export const POP_SHARE_PCT = 0.2;
export const MAX_POP_RECIPIENTS = 32; // one per connected peer, at most

/**
 * A peer-signed Proof-of-Participation attestation: the peer's wallet signs
 * "BTWBPOP_ATTEST|{miner_peer_id}|{address}|{timestamp}", cryptographically
 * binding (this miner, this payout address, this moment) together. Blocks
 * carry them so EVERY node can verify the PoP peer list independently.
 */
export interface PopAttestation {
  address: string; // the peer's payout address (derived from pubkey)
  pubkey: string; // 33-byte compressed secp256k1, hex
  signature: string; // 64-byte compact ECDSA, low-S, hex
  timestamp: number; // unix seconds - freshness window anchor
}
/** Consensus freshness: |block.timestamp - attestation.timestamp| <= this. */
export const POP_ATTEST_MAX_AGE_S = 300;
/** Policy: connected peers re-sign and re-gossip their attestation this often. */
export const POP_ATTEST_RESEND_MS = 60_000;

// -- fair mining -------------------------------------------------------------
// Every device on the network mines at the SAME speed: the worker sleeps
// after each batch so its rate never exceeds MINING_HASHRATE_CAP. When a
// user runs N worker threads, the cap is shared (rateLimit = cap / N), so
// extra threads only help slow devices reach the cap - never beyond it.
export const MINING_HASHRATE_CAP = 70_000; // hashes per second, per device
export const HASH_BATCH_SIZE = 1_000; // hashes between rate-limit checks
export const HASH_BATCH_INTERVAL = Math.ceil((HASH_BATCH_SIZE / MINING_HASHRATE_CAP) * 1000); // ~15 ms

// -- timing / consensus ------------------------------------------------------
export const TARGET_BLOCK_TIME = 60; // seconds
export const RETARGET_INTERVAL = 8; // blocks between difficulty retargets
export const RETARGET_CLAMP = 4; // max change factor per retarget (both ways)
export const MEDIAN_TIME_SPAN = 11; // blocks used for median-time-past
export const MAX_FUTURE_DRIFT = 900; // seconds a block may be ahead of node time
export const MAX_TXS_PER_BLOCK = 64; // transfers per block (coinbase extra)

// Miner cooldown: from the activation height on, one address may NOT mine two
// consecutive blocks - after a win it waits MINER_COOLDOWN_BLOCKS block(s) for
// someone else. Gated by height so chains mined before the rule existed stay
// valid; the whole bootstrap era (first 1,000 blocks) remains solo-friendly.
export const MINER_COOLDOWN_BLOCKS = 1;
export const MINER_COOLDOWN_ACTIVATION_HEIGHT = 2_000;

// State snapshots: every SNAPSHOT_INTERVAL blocks the node persists a full
// account-state snapshot locally. Boot recovery restores the latest snapshot
// and replays the blocks after it instead of replaying from genesis.
export const SNAPSHOT_INTERVAL = 1_000;
export const MAX_MEMPOOL_TXS = 512; // relay cap
export const TEMPLATE_TTL_MS = 120_000; // mining template validity

// -- difficulty --------------------------------------------------------------
/**
 * Difficulty 1 == target with 22 leading zero bits
 *             == 2^22 (~4.2M) expected double-SHA-256 evaluations per block.
 * Calibrated for browser CPUs (capped at MINING_HASHRATE_CAP per device):
 * a single browser finds a block in about a minute at difficulty 1; the
 * 8-block retarget then tracks the network upward automatically.
 * Target is always encoded as a 64-char lowercase hex string (256-bit BE).
 */
export const INITIAL_TARGET_HEX = "000003" + "f".repeat(58);
export const HASHES_AT_DIFFICULTY_1 = 2 ** 22;

// -- transactions ------------------------------------------------------------
export const MIN_TX_FEE = 1_000; // base units (0.00001 BTWB) minimum relay fee

// -- legal ---------------------------------------------------------------------
// The canonical disclaimer, rendered in the UI (Terminal page) and mirrored in
// the README's Legal section. There is no company, foundation or fund behind
// this - just code.
export const LEGAL_DISCLAIMER =
  "Experimental open-source software (MIT). Not financial advice. " +
  "BTWB has no promised value - coins are worth only what a free market " +
  "decides, which may be zero. Use at your own risk.";

// -- genesis -----------------------------------------------------------------
// Embedded in the coinbase of block #0 - unspendable forever, like the
// newspaper headline Satoshi hid in Bitcoin's genesis. A quote, not a pitch.
export const GENESIS_MESSAGE =
  "We're the middle children of history, man. No purpose or place. " +
  "We have no Great War. No Great Depression. " +
  "Our Great War is a spiritual war. Our Great Depression is our lives.";
export const GENESIS_PREV_HASH = "0".repeat(64);
// Genesis MUST be byte-identical on every node, so its timestamp is a
// hardcoded constant (like Bitcoin's 1231006505), never wall-clock time.
// 1787443200 = 2026-08-23T00:00:00Z - the mainnet's birthday. The manifesto
// message above survives from the testnet era; the clock restarts here.
export const GENESIS_TIMESTAMP = 1_787_443_200;

// -- canonical serializations ------------------------------------------------
// These MUST stay byte-identical across every implementation. A block or
// transaction is valid only if its hash commits to exactly these strings.

/** Block header preimage for proof-of-work (double-SHA-256 of this UTF-8). */
export function serializeHeader(h: {
  height: number;
  prevHash: string;
  merkleRoot: string;
  timestamp: number;
  nonce: number;
}): string {
  return `BTWB1|${h.height}|${h.prevHash}|${h.merkleRoot}|${h.timestamp}|${h.nonce}`;
}

/** The exact message a wallet signs (single SHA-256, then ECDSA/secp256k1). */
export function serializeTxForSig(t: {
  from: string;
  to: string;
  amount: number;
  fee: number;
  nonce: number;
}): string {
  return `BTWBTX1|${t.from}|${t.to}|${t.amount}|${t.fee}|${t.nonce}`;
}

/**
 * v2 signed preimage - binds the transfer to CHAIN_ID so a signature can
 * never be replayed onto a different network (testnet, fork, lookalike).
 * Nodes accept BOTH v1 and v2 signatures: historical blocks and in-flight
 * v1 transactions stay valid forever, so this is NOT a hard fork - but every
 * wallet produces v2 from the start, making v1 a legacy-only path.
 */
export function serializeTxForSigV2(t: {
  from: string;
  to: string;
  amount: number;
  fee: number;
  nonce: number;
}): string {
  return `BTWBTX2|${CHAIN_ID}|${t.from}|${t.to}|${t.amount}|${t.fee}|${t.nonce}`;
}

/** Full transaction preimage; its double-SHA-256 is the txid. */
export function serializeTxForId(t: {
  from: string;
  to: string;
  amount: number;
  fee: number;
  nonce: number;
  pubkey: string;
  signature: string;
}): string {
  return `${serializeTxForSig(t)}|${t.pubkey}|${t.signature}`;
}

/** v2 full transaction preimage; its double-SHA-256 is the v2 txid. */
export function serializeTxForIdV2(t: {
  from: string;
  to: string;
  amount: number;
  fee: number;
  nonce: number;
  pubkey: string;
  signature: string;
}): string {
  return `${serializeTxForSigV2(t)}|${t.pubkey}|${t.signature}`;
}

/** Coinbase preimage; its double-SHA-256 is the coinbase txid. */
export function serializeCoinbase(c: {
  height: number;
  to: string;
  amount: number;
}): string {
  return `BTWBCB1|${c.height}|${c.to}|${c.amount}`;
}

/**
 * PoP transfer preimage; its double-SHA-256 is the pop_transfer_id. PoP
 * transfers ride inside the block (popTransfers array) and commit to the
 * merkle root between the coinbase id and the transfer ids.
 */
export function serializePopTransfer(p: {
  height: number;
  index: number;
  to: string;
  amount: number;
}): string {
  return `BTWBPOP1|${p.height}|${p.index}|${p.to}|${p.amount}`;
}

/** The exact preimage a peer signs for a PoP attestation (single SHA-256 + ECDSA). */
export function serializePopAttestation(a: {
  minerPeerId: string;
  address: string;
  timestamp: number;
}): string {
  return `BTWBPOP_ATTEST|${a.minerPeerId}|${a.address}|${a.timestamp}`;
}

// -- addresses ---------------------------------------------------------------
// address = "btw1" + hash160_hex(40) + checksum_hex(8)          (52 chars)
// hash160  = RIPEMD-160(SHA-256(compressed_pubkey_33B))
// checksum = first 8 hex of double-SHA-256( ASCII "btw1" + hash160_hex )

export const ADDRESS_LENGTH = 52;
const ADDRESS_RE = /^btw1[0-9a-f]{48}$/;

export function isAddressFormat(addr: string): boolean {
  return ADDRESS_RE.test(addr);
}

export function addressChecksumHex(
  hash160Hex: string,
  dsha256Hex: (ascii: string) => string,
): string {
  return dsha256Hex(ADDRESS_PREFIX + hash160Hex).slice(0, 8);
}

export function buildAddress(
  hash160Hex: string,
  dsha256Hex: (ascii: string) => string,
): string {
  return ADDRESS_PREFIX + hash160Hex + addressChecksumHex(hash160Hex, dsha256Hex);
}

/** Full validation: format + checksum. `dsha256Hex` hashes an ASCII string. */
export function isValidAddress(
  addr: string,
  dsha256Hex: (ascii: string) => string,
): boolean {
  if (!isAddressFormat(addr)) return false;
  const hash160Hex = addr.slice(4, 44);
  return addr.slice(44) === addressChecksumHex(hash160Hex, dsha256Hex);
}

// -- emission schedule -------------------------------------------------------
// Bootstrap for the first 1,000 blocks (10x), then exponential decay forever:
// no cliffs, no eras - a smooth curve approaching the soft-cap reference.
export function getBlockReward(height: number): number {
  if (height <= 0) return 0; // genesis carries no subsidy
  if (height < BOOTSTRAP_BLOCKS) return INITIAL_SUBSIDY * BOOTSTRAP_MULTIPLIER;
  const adjustedHeight = height - BOOTSTRAP_BLOCKS;
  const decay = Math.exp(-EMISSION_DECAY_RATE * adjustedHeight);
  return Math.floor(INITIAL_SUBSIDY * decay);
}

/** The 70/20/10 split of one block's emission. The ONLY place this math lives. */
export interface RewardSplit {
  miner: number; // 70% - the coinbase amount
  popTotal: number; // 20% - before integer division among peers
  perPeer: number; // popTotal / peerCount, floored (0 when no peers)
  burn: number; // everything else: 10% + rounding dust + unclaimed PoP
}
export function splitBlockReward(height: number, peerCount: number): RewardSplit {
  const reward = getBlockReward(height);
  const miner = Math.floor(reward * MINER_SHARE_PCT);
  const popTotal = Math.floor(reward * POP_SHARE_PCT);
  const peers = Math.max(0, Math.min(peerCount, MAX_POP_RECIPIENTS));
  const perPeer = peers > 0 ? Math.floor(popTotal / peers) : 0;
  const burn = reward - miner - perPeer * peers;
  return { miner, popTotal, perPeer, burn };
}

// -- difficulty math ---------------------------------------------------------
export function targetToBigInt(targetHex: string): bigint {
  return BigInt("0x" + targetHex);
}

export function bigIntToTargetHex(t: bigint): string {
  return t.toString(16).padStart(64, "0");
}

/** Relative difficulty: 1.0 == initial target. */
export function difficultyOf(targetHex: string): number {
  const t = Number(targetToBigInt(targetHex));
  const i = Number(targetToBigInt(INITIAL_TARGET_HEX));
  return (i + 1) / (t + 1);
}

/**
 * A hash meets the target iff hash < target. Both are 64-char lowercase hex,
 * so lexicographic comparison is exactly numeric comparison.
 */
export function hashMeetsTarget(hashHex: string, targetHex: string): boolean {
  return (
    /^[0-9a-f]{64}$/.test(hashHex) &&
    /^[0-9a-f]{64}$/.test(targetHex) &&
    hashHex < targetHex
  );
}

// -- checkpoints ---------------------------------------------------------------
// Low-difficulty rewrite defense. At 22-bit difficulty a forged chain is
// cheap to re-mine, so the software pins known-good hashes: a block at a
// pinned height whose hash differs is rejected outright (consensus, not UI),
// and no reorg or import may ever cross the highest pinned height.
/** Every CHECKPOINT_INTERVAL blocks a new pin is added as the network grows. */
export const CHECKPOINT_INTERVAL = 1_000;
/**
 * Pinned checkpoints (height -> hash). Height 0 is the deterministic genesis
 * (computed from GENESIS_* constants - byte-identical on every node) and is
 * pinned here so the constant and the code can never drift apart; a protocol
 * test recomputes it. Later heights are added by the network operators every
 * CHECKPOINT_INTERVAL blocks once the chain is long enough to know them.
 */
export const CHECKPOINTS: Readonly<Record<number, string>> = {
  0: "c56c7b1e6bd77fb1cce41b3cb76d05a54c3bfd719db2942066daddf3a52352c3",
};

/** The pinned hash for a height, or null when the height is not checkpointed. */
export function checkpointHashAt(height: number): string | null {
  return CHECKPOINTS[height] ?? null;
}

/** The highest pinned height at or below `height` (0 when only genesis is pinned). */
export function highestCheckpointAtOrBelow(height: number): number {
  let best = 0;
  for (const key of Object.keys(CHECKPOINTS)) {
    const h = Number(key);
    if (h <= height && h > best) best = h;
  }
  return best;
}

/** Post-retarget target given the actual timespan of the last interval. */
export function retargetTargetHex(
  prevTargetHex: string,
  actualTimespan: number,
): string {
  const expected = RETARGET_INTERVAL * TARGET_BLOCK_TIME;
  const span = Math.min(
    Math.max(Math.floor(actualTimespan), Math.floor(expected / RETARGET_CLAMP)),
    expected * RETARGET_CLAMP,
  );
  const max = targetToBigInt(INITIAL_TARGET_HEX);
  let next = (targetToBigInt(prevTargetHex) * BigInt(span)) / BigInt(expected);
  if (next > max) next = max; // never easier than difficulty 1
  if (next < 1n) next = 1n;
  return bigIntToTargetHex(next);
}

// -- units -------------------------------------------------------------------
export function unitsToCoins(units: number): string {
  const neg = units < 0;
  const abs = Math.abs(Math.trunc(units));
  const whole = Math.floor(abs / COIN);
  const frac = abs % COIN;
  const fracStr = frac.toString().padStart(8, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${fracStr ? "." + fracStr : ""}`;
}

/** Parse a decimal BTWB string ("1.25") into base units. null if invalid. */
export function parseCoins(input: string): number | null {
  const m = /^(\d+)(?:\.(\d{1,8}))?$/.exec(input.trim());
  if (!m) return null;
  const units = Number(m[1]) * COIN + Number((m[2] ?? "").padEnd(8, "0"));
  if (!Number.isSafeInteger(units) || units > MAX_MONEY) return null;
  return units;
}

// -- misc --------------------------------------------------------------------
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
