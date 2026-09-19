/**
 * Checkpoint pin generator - turns a chain export file into the CHECKPOINTS
 * entries for contracts/protocol.ts.
 *
 *   usage:  npx vite-node scripts/checkpoints-from-export.ts bitweb-chain-12345.json
 *
 * Why this exists: the live chain lives in users' browsers - no server ever
 * sees it. The operator exports the canonical chain from a synced node
 * (Terminal page -> EXPORT CHAIN), and this script derives pins TRUSTLESSLY:
 * every block header hash is recomputed from its fields with the consensus
 * serialization (never trusting the stored hash), prevHash linkage and PoW
 * (hash < declared target) are re-checked, and height 0 must match the
 * genesis pin. A file that fails any of this yields NO pins.
 *
 * The retarget schedule is intentionally NOT re-validated here: importing
 * the file into a node already does full consensus validation; this tool
 * answers one question - which hashes are safe to PIN.
 *
 * Safety margin: pins are emitted only for heights that are multiples of
 * CHECKPOINT_INTERVAL and at least PIN_SAFETY_MARGIN blocks below the tip,
 * so ordinary micro-forks near the tip can never contradict a pin.
 */
import { readFileSync } from "node:fs";
import {
  CHECKPOINT_INTERVAL,
  CHAIN_ID,
  CHECKPOINTS,
  hashMeetsTarget,
  serializeHeader,
} from "../contracts/protocol";
import { MAX_REORG_DEPTH } from "../contracts/wire";
import { dsha256Hex } from "../src/node/blockchain";
import { sanitizeChainExport } from "../src/node/chain";

/** Pins must sit at least this far below the tip (2x the reorg window). */
export const PIN_SAFETY_MARGIN = 2 * MAX_REORG_DEPTH; // 64 blocks

export interface DerivedCheckpoints {
  tip: number;
  tipHash: string;
  blocksChecked: number;
  /** [height, hash] pairs ready to paste into CHECKPOINTS. */
  pins: Array<[number, string]>;
}

/**
 * Trustless pin derivation from a parsed chain export. Throws on ANY
 * inconsistency - a failed file yields no pins, never best-effort pins.
 */
export function deriveCheckpoints(parsed: unknown): DerivedCheckpoints {
  const data = sanitizeChainExport(parsed); // strict shape validation
  if (data.chainId !== CHAIN_ID) {
    throw new Error(`chain id mismatch: file is "${data.chainId}", this build is "${CHAIN_ID}"`);
  }
  const blocks = data.blocks;
  if (blocks.length === 0) throw new Error("empty export");

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.height !== i) {
      throw new Error(`height gap at index ${i}: got height ${b.height} (full exports start at genesis)`);
    }
    const recomputed = dsha256Hex(
      serializeHeader({
        height: b.height,
        prevHash: b.prevHash,
        merkleRoot: b.merkleRoot,
        timestamp: b.timestamp,
        nonce: b.nonce,
      }),
    );
    if (recomputed !== b.hash) {
      throw new Error(`block ${b.height}: stored hash does not match recomputed header hash`);
    }
    if (b.height > 0 && !hashMeetsTarget(b.hash, b.target)) {
      // height 0 is exempt, exactly like consensus: the genesis hash is a
      // pinned constant, not a proof-of-work product.
      throw new Error(`block ${b.height}: hash does not meet its declared target`);
    }
    if (i > 0 && b.prevHash !== blocks[i - 1].hash) {
      throw new Error(`block ${b.height}: prevHash does not chain to block ${i - 1}`);
    }
  }
  if (blocks[0].hash !== CHECKPOINTS[0]) {
    throw new Error("the file's genesis does not match the pinned genesis - wrong network?");
  }

  const tip = blocks[blocks.length - 1].height;
  const pins: Array<[number, string]> = [];
  for (const b of blocks) {
    if (b.height === 0) continue; // genesis is already pinned in protocol.ts
    if (b.height % CHECKPOINT_INTERVAL !== 0) continue;
    if (b.height > tip - PIN_SAFETY_MARGIN) continue; // too close to the tip
    pins.push([b.height, b.hash]);
  }
  return { tip, tipHash: blocks[blocks.length - 1].hash, blocksChecked: blocks.length, pins };
}

// -- CLI wrapper ---------------------------------------------------------------
// Run with: npx vite-node scripts/checkpoints-from-export.ts <file>
// vite-node drops the script path from process.argv (argv[2] is already the
// first user argument), so the import-vs-CLI guard keys off the test runner
// instead: vitest always sets VITEST in its workers.
const invokedAsScript = !process.env.VITEST;
if (invokedAsScript) {
  const fail = (msg: string): never => {
    console.error(`REFUSED: ${msg}`);
    process.exit(1);
    throw new Error(msg); // unreachable - keeps the never type honest for tsc
  };
  const file = process.argv[2];
  if (!file) fail("usage: npx vite-node scripts/checkpoints-from-export.ts <chain-export.json>");

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    fail(`cannot read/parse ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const out: DerivedCheckpoints = (() => {
    try {
      return deriveCheckpoints(parsed);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err)); // never
    }
  })();

  console.log(`file:    ${file}`);
  console.log(`tip:     #${out.tip.toLocaleString("en-US")} (${out.tipHash})`);
  console.log(
    `checked: ${out.blocksChecked.toLocaleString("en-US")} blocks - every header hash recomputed,`,
  );
  console.log(`         prevHash linkage + PoW target verified, genesis pin matched`);
  console.log(
    `margin:  pins only at multiples of ${CHECKPOINT_INTERVAL}, <= tip - ${PIN_SAFETY_MARGIN}`,
  );
  console.log("");

  if (out.pins.length === 0) {
    console.log(
      `No new pins yet: the next candidate height is the next multiple of ` +
        `${CHECKPOINT_INTERVAL} at or below tip-${PIN_SAFETY_MARGIN} ` +
        `(= ${(out.tip - PIN_SAFETY_MARGIN).toLocaleString("en-US")}).`,
    );
    process.exit(0);
  }

  console.log(`Add to CHECKPOINTS in contracts/protocol.ts:\n`);
  console.log(out.pins.map(([h, hash]) => `  ${h}: "${hash}",`).join("\n"));
  console.log("");
  console.log(`Then bump the release and ship. Nodes WITHOUT this update keep`);
  console.log(`validating as before; updated nodes reject any fork crossing a pin.`);
}
