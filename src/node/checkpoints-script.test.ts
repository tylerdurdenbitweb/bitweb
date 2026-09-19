/**
 * Checkpoint pin generator tests - deriveCheckpoints() against synthetic
 * chains. Block 0 is the REAL genesis (rebuilt from consensus constants, so
 * the pin match is genuine); later blocks carry a trivially easy declared
 * target - the generator deliberately does not re-validate the retarget
 * schedule (full validation happens on import into a node), so this suite
 * isolates what IS new logic: hash re-computation, linkage, and pin
 * selection (multiples of the interval + the below-tip safety margin).
 */
import { describe, expect, it } from "vitest";
import {
  buildAddress,
  CHECKPOINT_INTERVAL,
  CHECKPOINTS,
  CHAIN_ID,
  GENESIS_PREV_HASH,
  GENESIS_TIMESTAMP,
  INITIAL_TARGET_HEX,
  serializeCoinbase,
  serializeHeader,
} from "@contracts/protocol";
import type { WireBlock, WireTx } from "@contracts/wire";
import { dsha256Hex, merkleRootHex } from "./blockchain";
import {
  deriveCheckpoints,
  PIN_SAFETY_MARGIN,
} from "../../scripts/checkpoints-from-export";

const ZERO_ADDR = buildAddress("0".repeat(40), dsha256Hex);
const EASY_TARGET = "f".repeat(64); // every hash qualifies - pin selection only

function coinbaseTx(height: number, amount: number): WireTx {
  return {
    txid: dsha256Hex(serializeCoinbase({ height, to: ZERO_ADDR, amount })),
    type: "coinbase",
    fromAddress: null,
    toAddress: ZERO_ADDR,
    amount,
    fee: 0,
    nonce: null,
    pubkey: null,
    signature: null,
    timestamp: GENESIS_TIMESTAMP + height * 60,
  };
}

/** The byte-exact real genesis block (same recipe as the protocol test). */
function realGenesis(): WireBlock {
  const cb = coinbaseTx(0, 0);
  const merkle = merkleRootHex([cb.txid]);
  const hash = dsha256Hex(
    serializeHeader({
      height: 0,
      prevHash: GENESIS_PREV_HASH,
      merkleRoot: merkle,
      timestamp: GENESIS_TIMESTAMP,
      nonce: 0,
    }),
  );
  return {
    height: 0,
    hash,
    prevHash: GENESIS_PREV_HASH,
    merkleRoot: merkle,
    timestamp: GENESIS_TIMESTAMP,
    nonce: 0,
    target: INITIAL_TARGET_HEX,
    miner: ZERO_ADDR,
    message: null,
    txs: [cb],
  };
}

function fakeChain(tip: number): WireBlock[] {
  const blocks: WireBlock[] = [realGenesis()];
  for (let h = 1; h <= tip; h++) {
    const cb = coinbaseTx(h, 5_000_000_000);
    const merkle = merkleRootHex([cb.txid]);
    const header = {
      height: h,
      prevHash: blocks[h - 1].hash,
      merkleRoot: merkle,
      timestamp: GENESIS_TIMESTAMP + h * 60,
      nonce: 0,
    };
    blocks.push({
      ...header,
      hash: dsha256Hex(serializeHeader(header)),
      target: EASY_TARGET,
      miner: ZERO_ADDR,
      message: null,
      txs: [cb],
    });
  }
  return blocks;
}

function exportOf(blocks: WireBlock[], chainId: string = CHAIN_ID) {
  return {
    format: "bitweb-chain-1",
    chainId,
    height: blocks[blocks.length - 1].height,
    exportedAt: Date.now(),
    blocks,
  };
}

describe("deriveCheckpoints - pin selection", () => {
  it("pins multiples of the interval that sit below the safety margin", () => {
    const out = deriveCheckpoints(exportOf(fakeChain(2_100)));
    expect(out.tip).toBe(2_100);
    expect(out.blocksChecked).toBe(2_101);
    // margin: pins <= 2100 - 64 = 2036 -> 1000 and 2000
    expect(out.pins.map(([h]) => h)).toEqual([1_000, 2_000]);
    for (const [h, hash] of out.pins) {
      expect(h % CHECKPOINT_INTERVAL).toBe(0);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("boundary: tip at exactly a multiple + margin pins that multiple", () => {
    const out = deriveCheckpoints(exportOf(fakeChain(1_000 + PIN_SAFETY_MARGIN)));
    expect(out.pins.map(([h]) => h)).toEqual([1_000]);
  });

  it("one block short of the margin pins nothing yet", () => {
    const out = deriveCheckpoints(exportOf(fakeChain(1_000 + PIN_SAFETY_MARGIN - 1)));
    expect(out.pins).toEqual([]);
  });

  it("a young chain yields no pins", () => {
    const out = deriveCheckpoints(exportOf(fakeChain(500)));
    expect(out.pins).toEqual([]);
  });
});

describe("deriveCheckpoints - refuses anything untrustworthy", () => {
  it("rejects a tampered stored hash (hash is recomputed, never trusted)", () => {
    const blocks = fakeChain(100);
    blocks[7] = { ...blocks[7], hash: "0".repeat(64) };
    expect(() => deriveCheckpoints(exportOf(blocks))).toThrow(/does not match recomputed/);
  });

  it("rejects a broken prevHash linkage", () => {
    const blocks = fakeChain(100);
    const b = blocks[50];
    const header = {
      height: b.height,
      prevHash: "1".repeat(64), // wrong parent
      merkleRoot: b.merkleRoot,
      timestamp: b.timestamp,
      nonce: b.nonce,
    };
    // recompute so the stored hash matches the (tampered) header fields -
    // the linkage check must still catch it
    blocks[50] = { ...b, ...header, hash: dsha256Hex(serializeHeader(header)) };
    expect(() => deriveCheckpoints(exportOf(blocks))).toThrow(/does not chain/);
  });

  it("rejects a different chain id", () => {
    expect(() => deriveCheckpoints(exportOf(fakeChain(10), "bitweb-lookalike"))).toThrow(
      /chain id mismatch/,
    );
  });

  it("rejects when genesis is not the pinned one", () => {
    // Single-block export: no linkage to break, so the genesis-pin check
    // itself is what must fire.
    const g = realGenesis();
    const header = {
      height: 0,
      prevHash: g.prevHash,
      merkleRoot: g.merkleRoot,
      timestamp: g.timestamp,
      nonce: 1, // not the canonical genesis
    };
    const fakeGenesis = { ...g, ...header, hash: dsha256Hex(serializeHeader(header)) };
    expect(() => deriveCheckpoints(exportOf([fakeGenesis]))).toThrow(/genesis/);
  });

  it("rejects malformed exports at the sanitizer", () => {
    expect(() => deriveCheckpoints({ format: "bitweb-chain-1" })).toThrow();
    expect(() => deriveCheckpoints("junk")).toThrow();
  });
});

describe("CHECKPOINTS structure (the consensus map itself)", () => {
  it("pins are 64-hex at exact multiples of the interval, genesis always present", () => {
    expect(CHECKPOINTS[0]).toMatch(/^[0-9a-f]{64}$/);
    const heights = Object.keys(CHECKPOINTS).map(Number);
    for (const h of heights) {
      expect(h % CHECKPOINT_INTERVAL).toBe(0);
      expect(CHECKPOINTS[h]).toMatch(/^[0-9a-f]{64}$/);
    }
    expect([...heights].sort((a, b) => a - b)).toEqual(heights); // declared in order
  });
});
