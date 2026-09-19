/**
 * BitWeb proof-of-work worker.
 * Iterates (timestamp, nonce) over the canonical header preimage
 *   BTWB1|{height}|{prevHash}|{merkleRoot}|{timestamp}|{nonce}
 * and reports any double-SHA-256 digest below the target.
 * Runs fully client-side; the node independently re-verifies all work.
 *
 * Hot loop is allocation-free: the constant header prefix is absorbed once
 * per timestamp slice into a clonable SHA-256 state; each try only digests
 * the few nonce digits (mid-state reuse, ~2.4x faster than naive re-hash).
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { HASH_BATCH_SIZE } from "@contracts/protocol";

export interface MinerStartMsg {
  type: "start";
  /** echoed back in `found` so the controller can drop stale-template wins */
  templateId: string;
  height: number;
  prevHash: string;
  merkleRoot: string;
  targetHex: string;
  minTimestamp: number; // node rejects older timestamps - clamp for clock skew
  stride: number; // number of workers sharing the nonce space
  offset: number; // this worker's lane
  /**
   * This worker's share of MINING_HASHRATE_CAP (cap / thread count), in
   * hashes per second. The fair-mining rule: every device - phone or
   * supercomputer - mines under the SAME global ceiling, so extra threads
   * can only divide the cap, never exceed it.
   */
  rateLimit: number;
}

export interface MinerStopMsg {
  type: "stop";
}

export interface MinerFoundMsg {
  type: "found";
  templateId: string;
  timestamp: number;
  nonce: number;
  hash: string;
}

export interface MinerStatsMsg {
  type: "stats";
  hashes: number;
  elapsedMs: number;
}

export type MinerInMsg = MinerStartMsg | MinerStopMsg;
export type MinerOutMsg = MinerFoundMsg | MinerStatsMsg;

let running = false;

/** digest < target, both 32-byte big-endian */
function meetsTarget(digest: Uint8Array, target: Uint8Array): boolean {
  for (let i = 0; i < 32; i++) {
    if (digest[i] !== target[i]) return digest[i] < target[i];
  }
  return false; // equal is not below
}

function toHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}

/** write decimal digits of `v` into `buf`, return the sub-slice used */
function writeDigits(buf: Uint8Array, v: number): Uint8Array {
  let p = buf.length;
  do {
    buf[--p] = 48 + (v % 10);
    v = Math.floor(v / 10);
  } while (v > 0);
  return buf.subarray(p);
}

async function mine(msg: MinerStartMsg): Promise<void> {
  const target = hexToBytes(msg.targetHex);
  const headPrefix = `BTWB1|${msg.height}|${msg.prevHash}|${msg.merkleRoot}|`;
  const digitBuf = new Uint8Array(16);
  let nonce = msg.offset;
  let hashes = 0;
  let lastReport = performance.now();
  // Fair-mining throttle: HASH_BATCH_SIZE hashes, then sleep until the batch
  // would have taken at the permitted rate. rateLimit <= 0 means uncapped
  // (tests only - the UI always passes cap / threads).
  const batchIntervalMs =
    msg.rateLimit > 0 ? Math.ceil((HASH_BATCH_SIZE / msg.rateLimit) * 1000) : 0;

  while (running) {
    const timestamp = Math.max(Math.floor(Date.now() / 1000), msg.minTimestamp);
    const base = sha256.create();
    base.update(utf8ToBytes(`${headPrefix}${timestamp}|`));

    // grind this timestamp slice for up to ~400ms, then roll the timestamp
    const sliceEnd = performance.now() + 400;
    while (running && performance.now() < sliceEnd) {
      const batchStart = performance.now();
      for (let i = 0; i < HASH_BATCH_SIZE && running; i++) {
        const attempt = base.clone();
        attempt.update(writeDigits(digitBuf, nonce));
        const digest = sha256(attempt.digest());
        hashes++;
        if (meetsTarget(digest, target)) {
          const out: MinerFoundMsg = {
            type: "found",
            templateId: msg.templateId,
            timestamp,
            nonce,
            hash: toHex(digest),
          };
          postMessage(out);
        }
        nonce += msg.stride;
        if (nonce > Number.MAX_SAFE_INTEGER - msg.stride * 4096) nonce = msg.offset;
      }
      // Throttle to this worker's share of the global hashrate cap; the
      // sleep doubles as the yield that lets stop messages land promptly.
      const elapsed = performance.now() - batchStart;
      if (elapsed < batchIntervalMs) {
        await new Promise((r) => setTimeout(r, batchIntervalMs - elapsed));
      } else {
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    const now = performance.now();
    if (now - lastReport >= 1000) {
      const out: MinerStatsMsg = {
        type: "stats",
        hashes,
        elapsedMs: now - lastReport,
      };
      postMessage(out);
      hashes = 0;
      lastReport = now;
    }
  }
}

onmessage = (e: MessageEvent<MinerInMsg>) => {
  if (e.data.type === "start") {
    running = false; // stop any previous loop
    // microtask gap lets a prior loop observe the flag before we restart
    setTimeout(() => {
      running = true;
      void mine(e.data as MinerStartMsg);
    }, 0);
  } else if (e.data.type === "stop") {
    running = false;
  }
};
