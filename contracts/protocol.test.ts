/**
 * Protocol unit tests - pins the consensus-critical pure functions so a
 * careless edit can never silently fork the chain.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  BOOTSTRAP_BLOCKS,
  BOOTSTRAP_MULTIPLIER,
  CHAIN_ID,
  LEGAL_DISCLAIMER,
  GENESIS_MESSAGE,
  GENESIS_TIMESTAMP,
  COIN,
  EMISSION_DECAY_RATE,
  GENESIS_PREV_HASH,
  HASH_BATCH_INTERVAL,
  HASH_BATCH_SIZE,
  INITIAL_SUBSIDY,
  INITIAL_TARGET_HEX,
  MAX_MONEY,
  MAX_POP_RECIPIENTS,
  MINER_COOLDOWN_ACTIVATION_HEIGHT,
  MINER_COOLDOWN_BLOCKS,
  MINING_HASHRATE_CAP,
  POP_ATTEST_MAX_AGE_S,
  POP_ATTEST_RESEND_MS,
  RETARGET_CLAMP,
  RETARGET_INTERVAL,
  SNAPSHOT_INTERVAL,
  SOFT_CAP_SUPPLY,
  TARGET_BLOCK_TIME,
  buildAddress,
  difficultyOf,
  getBlockReward,
  hashMeetsTarget,
  isValidAddress,
  parseCoins,
  retargetTargetHex,
  serializeCoinbase,
  serializeHeader,
  serializePopAttestation,
  serializePopTransfer,
  serializeTxForSig,
  serializeTxForSigV2,
  splitBlockReward,
  unitsToCoins,
} from "@contracts/protocol";
import {
  dsha256Hex,
  merkleRootHex,
  signatureVersionOf,
  txidOfTransfer,
  verifyPopAttestationSignature,
  verifyTransferSignature,
} from "@/node/blockchain";
import { signPopAttestation, walletFromPrivHex } from "@/lib/bitweb";

describe("hash parity (node crypto vs noble - browser validation is noble)", () => {
  it("double-SHA-256 matches on canonical strings", () => {
    for (const s of [
      serializeHeader({
        height: 1,
        prevHash: "ab".repeat(32),
        merkleRoot: "cd".repeat(32),
        timestamp: 1_785_800_000,
        nonce: 42,
      }),
      "BTWBTX1|btw1x|btw1y|100|1000|0",
      "",
      "satoshi",
    ]) {
      const noble = bytesToHex(sha256(sha256(utf8ToBytes(s))));
      const node = createHash("sha256")
        .update(createHash("sha256").update(s, "utf8").digest())
        .digest("hex");
      expect(noble).toBe(node);
    }
  });
});

describe("serializations are exact and stable", () => {
  it("header preimage format", () => {
    expect(
      serializeHeader({
        height: 7,
        prevHash: "p",
        merkleRoot: "m",
        timestamp: 99,
        nonce: 5,
      }),
    ).toBe("BTWB1|7|p|m|99|5");
  });
  it("tx signing preimage format", () => {
    expect(serializeTxForSig({ from: "a", to: "b", amount: 1, fee: 2, nonce: 3 })).toBe(
      "BTWBTX1|a|b|1|2|3",
    );
  });
  it("v2 tx signing preimage is chain-bound (replay protection)", () => {
    expect(serializeTxForSigV2({ from: "a", to: "b", amount: 1, fee: 2, nonce: 3 })).toBe(
      `BTWBTX2|${CHAIN_ID}|a|b|1|2|3`,
    );
    expect(CHAIN_ID).toBe("bitweb-mainnet-1");
  });
  it("dual-accept: v2 is canonical, v1 stays valid, forgeries fail", () => {
    const signWith = (sk: Uint8Array, msg: string) =>
      bytesToHex(secp256k1.sign(sha256(utf8ToBytes(msg)), sk));
    const priv = secp256k1.utils.randomSecretKey();
    const pubHex = bytesToHex(secp256k1.getPublicKey(priv, true));
    const base = { from: "btw1a", to: "btw1b", amount: 5, fee: 1_000, nonce: 0 };

    const v2Tx = { ...base, pubkey: pubHex, signature: signWith(priv, serializeTxForSigV2(base)) };
    expect(signatureVersionOf(v2Tx)).toBe(2);
    expect(verifyTransferSignature(v2Tx)).toBe(true);

    const v1Tx = { ...base, pubkey: pubHex, signature: signWith(priv, serializeTxForSig(base)) };
    expect(signatureVersionOf(v1Tx)).toBe(1);
    expect(verifyTransferSignature(v1Tx)).toBe(true);

    // the two versions must produce different txids, each stable
    expect(txidOfTransfer(v2Tx)).not.toBe(txidOfTransfer(v1Tx));
    expect(txidOfTransfer(v2Tx)).toMatch(/^[0-9a-f]{64}$/);

    // wrong key / wrong message must never verify under either version
    const evil = secp256k1.utils.randomSecretKey();
    const forged = { ...base, pubkey: pubHex, signature: signWith(evil, serializeTxForSigV2(base)) };
    expect(signatureVersionOf(forged)).toBe(0);
    expect(verifyTransferSignature(forged)).toBe(false);
  });
  it("genesis prev hash is 64 zeros", () => {
    expect(GENESIS_PREV_HASH).toBe("0".repeat(64));
  });
});

describe("addresses", () => {
  it("build -> validate roundtrip; tampering fails", () => {
    const h160 = "0123456789abcdef0123456789abcdef01234567";
    const addr = buildAddress(h160, dsha256Hex);
    expect(addr).toMatch(/^btw1[0-9a-f]{48}$/);
    expect(isValidAddress(addr, dsha256Hex)).toBe(true);
    const tampered = addr.slice(0, 10) + "f" + addr.slice(11);
    expect(isValidAddress(tampered, dsha256Hex)).toBe(false);
  });
  it("zero-hash genesis address is well-formed", () => {
    const zero = buildAddress("0".repeat(40), dsha256Hex);
    expect(isValidAddress(zero, dsha256Hex)).toBe(true);
    expect(serializeCoinbase({ height: 0, to: zero, amount: 0 })).toContain("BTWBCB1|0|");
  });
});

describe("merkle tree", () => {
  const a = "aa".repeat(32);
  const b = "bb".repeat(32);
  const c = "cc".repeat(32);
  it("single leaf is its own root", () => {
    expect(merkleRootHex([a])).toBe(a);
  });
  it("pair hashes once", () => {
    expect(merkleRootHex([a, b])).toBe(dsha256Hex(a + b));
  });
  it("odd leaf duplicates (bitcoin rule)", () => {
    const l = dsha256Hex(a + b);
    const r = dsha256Hex(c + c);
    expect(merkleRootHex([a, b, c])).toBe(dsha256Hex(l + r));
  });
  it("empty set is zero root", () => {
    expect(merkleRootHex([])).toBe("0".repeat(64));
  });
});

describe("emission schedule", () => {
  it("bootstrap era pays the multiplied subsidy", () => {
    expect(getBlockReward(0)).toBe(0); // genesis itself mints nothing
    expect(getBlockReward(1)).toBe(INITIAL_SUBSIDY * BOOTSTRAP_MULTIPLIER);
    expect(getBlockReward(BOOTSTRAP_BLOCKS - 1)).toBe(INITIAL_SUBSIDY * BOOTSTRAP_MULTIPLIER);
  });
  it("post-bootstrap decays exponentially - smooth, no cliffs", () => {
    // first post-bootstrap block sits exactly at the base of the curve
    expect(getBlockReward(BOOTSTRAP_BLOCKS)).toBe(
      Math.floor(INITIAL_SUBSIDY * Math.exp(0)),
    );
    const h = 50_000;
    expect(getBlockReward(h)).toBe(
      Math.floor(INITIAL_SUBSIDY * Math.exp(-EMISSION_DECAY_RATE * (h - BOOTSTRAP_BLOCKS))),
    );
    // monotone non-increasing forever, never negative
    let prev = Number.MAX_SAFE_INTEGER;
    for (const hh of [BOOTSTRAP_BLOCKS, 2_000, 10_000, 100_000, 1_000_000, 100_000_000]) {
      const r = getBlockReward(hh);
      expect(r).toBeLessThanOrEqual(prev);
      expect(r).toBeGreaterThanOrEqual(0);
      prev = r;
    }
  });
  it("exact emission vectors - pinned integers, hostile to constant drift", () => {
    // Reference values computed from the spec formula
    //   floor(50e8 * e^(-5e-6 * (h - 1000)))
    // Any accidental change to a monetary constant breaks this table.
    const vectors: Array<[number, number]> = [
      [0, 0], // genesis mints nothing
      [999, 50_000_000_000], // last bootstrap block: 500 BTWB
      [1_000, 5_000_000_000], // first decay block: exactly 50 BTWB
      [10_000, 4_779_987_409], // ~47.80 BTWB
      [50_000, 3_913_522_691], // ~39.14 BTWB
      [100_000, 3_047_854_536], // ~30.48 BTWB
      [500_000, 412_482_256], // ~4.12 BTWB
      [1_000_000, 33_858_605], // ~0.34 BTWB
      [5_000_000, 0], // integer base units underflow: emission ENDS here
    ];
    for (const [height, reward] of vectors) expect(getBlockReward(height)).toBe(reward);
  });
  it("once emission underflows to zero it never comes back", () => {
    for (const h of [5_000_000, 10_000_000, 100_000_000, Number.MAX_SAFE_INTEGER]) {
      expect(getBlockReward(h)).toBe(0);
    }
  });
  it("asymptotic issuance stays far below the soft-cap reference", () => {
    let total = INITIAL_SUBSIDY * BOOTSTRAP_MULTIPLIER * (BOOTSTRAP_BLOCKS - 1);
    // integral upper bound of the exponential tail (the tail sum is bounded by its integral, decay is negative)
    total += Math.ceil(INITIAL_SUBSIDY / EMISSION_DECAY_RATE);
    expect(total).toBeLessThan(SOFT_CAP_SUPPLY);
  });
  it("reward split conserves every unit - 70% miner, 20% peers, rest burned", () => {
    for (const [height, peers] of [
      [1, 0],
      [1, 3],
      [500, 7],
      [2_000, 1],
      [2_000, MAX_POP_RECIPIENTS + 40], // beyond the cap
      [500_000, 5],
    ] as const) {
      const R = getBlockReward(height);
      const split = splitBlockReward(height, peers);
      const n = Math.min(peers, MAX_POP_RECIPIENTS);
      expect(split.miner).toBe(Math.floor(R * 0.7));
      expect(split.popTotal).toBe(Math.floor(R * 0.2));
      expect(split.perPeer).toBe(n > 0 ? Math.floor(split.popTotal / n) : 0);
      // exact conservation: miner + paid-out pool + burn === the whole reward
      expect(split.miner + split.perPeer * n + split.burn).toBe(R);
      // burn is at least 10% - rounding dust and an unclaimed pool burn too
      expect(split.burn).toBeGreaterThanOrEqual(R - split.miner - split.popTotal);
    }
  });
  it("the legal disclaimer is present and honest", () => {
    expect(LEGAL_DISCLAIMER).toContain("Not financial advice");
    expect(LEGAL_DISCLAIMER).toContain("no promised value");
    expect(LEGAL_DISCLAIMER.length).toBeGreaterThan(80);
  });
  it("fair-mining cap constants are coherent", () => {
    expect(HASH_BATCH_INTERVAL).toBe(
      Math.ceil((HASH_BATCH_SIZE / MINING_HASHRATE_CAP) * 1000),
    );
    // one second of batches at the interval never exceeds the global cap
    expect(Math.floor(1000 / HASH_BATCH_INTERVAL) * HASH_BATCH_SIZE).toBeLessThanOrEqual(
      MINING_HASHRATE_CAP,
    );
  });
  it("PoP transfer serialization is canonical and stable", () => {
    expect(serializePopTransfer({ height: 5, index: 2, to: "btw1abc", amount: 123 })).toBe(
      "BTWBPOP1|5|2|btw1abc|123",
    );
  });
  it("PoP attestation constants and serialization are canonical and stable", () => {
    expect(POP_ATTEST_MAX_AGE_S).toBe(300);
    expect(POP_ATTEST_RESEND_MS).toBe(60_000);
    expect(
      serializePopAttestation({ minerPeerId: "node-x", address: "btw1abc", timestamp: 42 }),
    ).toBe("BTWBPOP_ATTEST|node-x|btw1abc|42");
  });
  it("PoP attestation sign/verify roundtrip - bound to ONE miner id", () => {
    const w = walletFromPrivHex("ab".repeat(32))!;
    const a = { minerPeerId: "miner-node-1", address: w.address, timestamp: 1_800_000_000 };
    const signature = signPopAttestation(w.privHex, a);
    expect(signature).toMatch(/^[0-9a-f]{128}$/);
    expect(
      verifyPopAttestationSignature({ ...a, pubkey: w.pubHex, signature }),
    ).toBe(true);
    // another miner's id, another address, another moment - all must fail
    expect(
      verifyPopAttestationSignature({ ...a, minerPeerId: "miner-node-2", pubkey: w.pubHex, signature }),
    ).toBe(false);
    const other = walletFromPrivHex("cd".repeat(32))!;
    expect(
      verifyPopAttestationSignature({ ...a, address: other.address, pubkey: w.pubHex, signature }),
    ).toBe(false);
    expect(
      verifyPopAttestationSignature({ ...a, timestamp: a.timestamp + 1, pubkey: w.pubHex, signature }),
    ).toBe(false);
    // a pubkey that does not derive the claimed address never verifies
    expect(
      verifyPopAttestationSignature({ ...a, pubkey: other.pubHex, signature }),
    ).toBe(false);
  });
});

describe("difficulty", () => {
  it("initial target encodes difficulty exactly 1", () => {
    expect(INITIAL_TARGET_HEX).toMatch(/^[0-9a-f]{64}$/);
    expect(difficultyOf(INITIAL_TARGET_HEX)).toBe(1);
  });
  it("hashMeetsTarget is strict-below", () => {
    const t = INITIAL_TARGET_HEX;
    expect(hashMeetsTarget("000000" + "0".repeat(58), t)).toBe(true);
    expect(hashMeetsTarget("f".repeat(64), t)).toBe(false);
    expect(hashMeetsTarget(t, t)).toBe(false); // equal is not below
  });
  it("retarget respects expected timespan", () => {
    const expected = RETARGET_INTERVAL * TARGET_BLOCK_TIME;
    // exactly on time -> target unchanged
    expect(retargetTargetHex(INITIAL_TARGET_HEX, expected)).toBe(INITIAL_TARGET_HEX);
    // 2x too fast -> target halves (difficulty doubles)
    const faster = retargetTargetHex(INITIAL_TARGET_HEX, expected / 2);
    expect(difficultyOf(faster)).toBeGreaterThan(1.9);
    expect(difficultyOf(faster)).toBeLessThan(2.1);
  });
  it("retarget clamps extreme swings", () => {
    const expected = RETARGET_INTERVAL * TARGET_BLOCK_TIME;
    const wild = retargetTargetHex(INITIAL_TARGET_HEX, expected / 1000);
    expect(difficultyOf(wild)).toBeLessThanOrEqual(RETARGET_CLAMP + 0.01);
    // never easier than difficulty 1
    const slow = retargetTargetHex(INITIAL_TARGET_HEX, expected * 1000);
    expect(slow).toBe(INITIAL_TARGET_HEX);
  });
});

describe("units", () => {
  it("parseCoins / unitsToCoins roundtrip", () => {
    expect(parseCoins("1")).toBe(COIN);
    expect(parseCoins("0.00001")).toBe(1_000);
    expect(parseCoins("42000000")).toBe(MAX_MONEY);
    expect(parseCoins("42000000")).toBe(SOFT_CAP_SUPPLY);
    expect(parseCoins("0.00000001")).toBe(1);
    expect(parseCoins("42000001")).toBeNull();
    expect(parseCoins("abc")).toBeNull();
    expect(parseCoins("1.123456789")).toBeNull(); // >8 decimals
    expect(unitsToCoins(COIN)).toBe("1");
    expect(unitsToCoins(1_000)).toBe("0.00001");
    expect(unitsToCoins(12.5 * COIN)).toBe("12.5");
    expect(unitsToCoins(0)).toBe("0");
    expect(parseCoins(unitsToCoins(123_456_789))).toBe(123_456_789);
  });
});

describe("genesis is deterministic across all nodes", () => {
  it("block #0 is byte-identical everywhere, forever", () => {
    // Every node must compute this exact hash independently - a node with a
    // different genesis can never join this network (checked in P2P hello).
    const zero = buildAddress("0".repeat(40), dsha256Hex);
    const cbTxid = dsha256Hex(serializeCoinbase({ height: 0, to: zero, amount: 0 }));
    const merkle = merkleRootHex([cbTxid]);
    const hash = dsha256Hex(
      serializeHeader({
        height: 0,
        prevHash: GENESIS_PREV_HASH,
        merkleRoot: merkle,
        timestamp: GENESIS_TIMESTAMP,
        nonce: 0,
      }),
    );
    expect(hash).toBe("c56c7b1e6bd77fb1cce41b3cb76d05a54c3bfd719db2942066daddf3a52352c3");
    expect(cbTxid).toBe("634502e170d08790b161832df5784e995cb28c7098a6dec9b3da50d616f60a2b");
    expect(GENESIS_TIMESTAMP).toBe(1_787_443_200); // 2026-08-23T00:00:00Z - mainnet birthday
  });
  it("carries the message, hidden in the coinbase like Satoshi's headline", () => {
    expect(GENESIS_MESSAGE).toContain("middle children of history");
    expect(GENESIS_MESSAGE).toContain("spiritual war");
    expect(GENESIS_MESSAGE.length).toBeLessThanOrEqual(255);
  });
});

describe("miner cooldown + snapshots", () => {
  it("constants are pinned", () => {
    expect(MINER_COOLDOWN_BLOCKS).toBe(1);
    expect(MINER_COOLDOWN_ACTIVATION_HEIGHT).toBe(2_000);
    expect(SNAPSHOT_INTERVAL).toBe(1_000);
  });
});
