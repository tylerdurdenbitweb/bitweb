/**
 * Chain state machine integration - memory adapter, REAL proof-of-work.
 * Genesis seal -> local mining -> transfer confirmation -> reorg rollback ->
 * a competing branch applied from "the wire" -> the chain heals forward.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import {
  GENESIS_TIMESTAMP,
  COIN,
  hashMeetsTarget,
  nowSeconds,
  serializeCoinbase,
  serializePopTransfer,
  splitBlockReward,
  type PopAttestation,
} from "@contracts/protocol";
import type { WireBlock } from "@contracts/wire";
import { signPopAttestation, signTransfer, walletFromPrivHex, type WalletKeys } from "@/lib/bitweb";
import { dsha256Hex, merkleRootHex } from "./blockchain";
import {
  ChainValidationError,
  admitTransfer,
  applyWireBlock,
  buildTemplate,
  getAddressOverview,
  getInfo,
  getRecentBlocks,
  getMempool,
  getTipSummary,
  initChain,
  rollbackToHeight,
  setPopAttestationsProvider,
  setPopMinerNodeIdProvider,
  submitBlock,
  violatesMinerCooldown,
  type TemplateView,
} from "./chain";
import { MemoryStorage } from "./storage";

// -- PoW: baked solutions + live search fallback ----------------------------
// The narrative below is fully deterministic (fixed keys, fixed timestamps),
// so every block's winning nonce is constant. They were found once with the
// live search and are baked here - test runs verify them with ONE hash each
// instead of grinding ~2^22 hashes per block. Any narrative change simply
// falls back to the live search (slow but correct) and prints new solutions.
const BAKED: Record<string, { nonce: number; hash: string }> = {
  "BTWB1|1|c56c7b1e6bd77fb1cce41b3cb76d05a54c3bfd719db2942066daddf3a52352c3|d62b9190107cb799394ff51e25c12ff58a23fa360f6b632805bd0f4268d6ecc8|1787443201|": { nonce: 175577, hash: "000000f11f737b8028d03070c7decc69e1cf199d3c532ea6cf27895396333a9c" },
  "BTWB1|2|000000f11f737b8028d03070c7decc69e1cf199d3c532ea6cf27895396333a9c|e77599e7f9dbb191ff935eaa383ebb388616bf785ce87173a73ed59bcf41ba27|1787443202|": { nonce: 8699338, hash: "0000018c8f7cb7fd26d55c2201def5173ef6bbc90a1518e090d25a126609de77" },
  "BTWB1|3|0000018c8f7cb7fd26d55c2201def5173ef6bbc90a1518e090d25a126609de77|78836ca5bcb6238b49471a653635f91555a56cfcf1e0ee5bcc42f33d5652955b|1787443203|": { nonce: 9120488, hash: "000002b1d5a41f93b1ae77cceae19c604414ad41120d1b39928aad7c57b1d2c2" },
  "BTWB1|3|0000018c8f7cb7fd26d55c2201def5173ef6bbc90a1518e090d25a126609de77|970f09826329a839ee515b54ee7c31e8351675bfb6793bd3e6aaccd4ca0febe7|1787443203|": { nonce: 1445584, hash: "00000353c8181d31c7f5c9ee8a12e881860aa664ec05bc59dd57100d87b73235" },
  "BTWB1|4|00000353c8181d31c7f5c9ee8a12e881860aa664ec05bc59dd57100d87b73235|2c241baa0430c37bc492514afd978144868bfdf62496e21612a5eadb3c6b8fd8|1787443204|": { nonce: 832245, hash: "000000eeda9d97aa355cc6d494aec3909a9900bd6b1875928fd58bf2ccc55bdb" },
  "BTWB1|5|000000eeda9d97aa355cc6d494aec3909a9900bd6b1875928fd58bf2ccc55bdb|5d0869d19f8b2804a2b8b6a8334a547b5dc554eee604ecbbf2c0260d7e780a47|1787443205|": { nonce: 5348210, hash: "0000019645e08e9df21c8d712677480b5a98fae22e09a127daf95aaf3b2c13a6" },
  "BTWB1|6|0000019645e08e9df21c8d712677480b5a98fae22e09a127daf95aaf3b2c13a6|83897c0105b3ebe4d04c5d135f84a37c638ef910230186622a974e0498a9342c|1787443206|": { nonce: 3392381, hash: "0000012208d1ea2d320e03918728d481fa69bdf574127c5d6bc3e12c4b50de93" },
  "BTWB1|7|0000012208d1ea2d320e03918728d481fa69bdf574127c5d6bc3e12c4b50de93|274a12f5a0436624c607be2d95284688d0a4226ac109da7f9afaabc9f61cccad|1787443207|": { nonce: 5953635, hash: "000002c56370121ffc7ba6997249eeb74434b44231e520dd726ebfa3910a0115" },
  "BTWB1|7|0000012208d1ea2d320e03918728d481fa69bdf574127c5d6bc3e12c4b50de93|29016466ab5fb0185558d0c896a3c99788254f6a45ec3049edea8a372b2ebc6d|1787443207|": { nonce: 1287669, hash: "0000003a97d5d243b8be6a0a839c89c705627f520d99cad72183886060c62aff" },
  "BTWB1|7|0000012208d1ea2d320e03918728d481fa69bdf574127c5d6bc3e12c4b50de93|6af2386c0f4e44b72101c1459d1f6c799648f45204ef27329db819ced6e6eec5|1787443207|": { nonce: 7883442, hash: "00000035a7605cadffd8e9bb0426289d3987f4ac1f09f4ae5dac1d607cd35fa3" },
  "BTWB1|7|0000012208d1ea2d320e03918728d481fa69bdf574127c5d6bc3e12c4b50de93|a3417c1dab19ad6ff3d0f288f9d3b65bd912022ece83769b5e0b27962d1cb721|1787443207|": { nonce: 3709925, hash: "0000000eaef89bb372ec112b32d44756d1fd99cd33e75248928583c912e3527c" },
};

function powSearch(prefixAscii: string, target: string): { nonce: number; hash: string } {
  const baked = BAKED[prefixAscii];
  if (baked) {
    const prefix = utf8ToBytes(prefixAscii);
    const d1 = sha256.create().update(prefix).update(utf8ToBytes(String(baked.nonce))).digest();
    const hash = bytesToHex(sha256(d1));
    if (hash !== baked.hash || !hashMeetsTarget(hash, target)) {
      throw new Error(`baked solution invalid for ${prefixAscii}`);
    }
    return baked;
  }
  const prefix = utf8ToBytes(prefixAscii);
  for (let nonce = 0; nonce < 2 ** 31; nonce++) {
    const d1 = sha256.create().update(prefix).update(utf8ToBytes(String(nonce))).digest();
    const hash = bytesToHex(sha256(d1));
    if (hashMeetsTarget(hash, target)) {
      console.log(`BAKE: "${prefixAscii}": { nonce: ${nonce}, hash: "${hash}" },`);
      return { nonce, hash };
    }
  }
  throw new Error("nonce space exhausted");
}

async function mineNextBlock(miner: string): Promise<{ height: number; hash: string }> {
  const tpl: TemplateView = await buildTemplate(miner);
  const ts = tpl.minTimestamp; // deterministic - the whole narrative is
  const { nonce } = powSearch(
    `BTWB1|${tpl.height}|${tpl.prevHash}|${tpl.merkleRoot}|${ts}|`,
    tpl.target,
  );
  return submitBlock(tpl.templateId, ts, nonce);
}

/**
 * Attestation-acceptance blocks MUST carry a wall-clock timestamp: the 300 s
 * freshness window is measured against the block's timestamp, so a block
 * carrying real attestations has to live in real time too. Non-deterministic
 * (live PoW every run) - only ever used for the LAST block of a narrative.
 */
async function mineNextBlockRealtime(miner: string): Promise<{ height: number; hash: string }> {
  const tpl: TemplateView = await buildTemplate(miner);
  const ts = Math.max(tpl.minTimestamp, nowSeconds());
  const { nonce } = powSearch(
    `BTWB1|${tpl.height}|${tpl.prevHash}|${tpl.merkleRoot}|${ts}|`,
    tpl.target,
  );
  return submitBlock(tpl.templateId, ts, nonce);
}

/** A REAL peer-signed attestation - the exact bytes a wallet would produce. */
function attest(w: WalletKeys, minerPeerId: string, timestamp: number): PopAttestation {
  return {
    address: w.address,
    pubkey: w.pubHex,
    signature: signPopAttestation(w.privHex, { minerPeerId, address: w.address, timestamp }),
    timestamp,
  };
}
const TEST_NODE_ID = "btwb-test-miner-node";

/** Craft a valid coinbase-only block extending `storage`'s block at height-1. */
async function craftSideBlock(
  storage: MemoryStorage,
  height: number,
  miner: string,
): Promise<WireBlock> {
  const prev = await storage.blockAt(height - 1);
  if (!prev) throw new Error("side-block parent missing");
  const amount = splitBlockReward(height, 0).miner;
  const cbTxid = dsha256Hex(serializeCoinbase({ height, to: miner, amount }));
  const merkleRoot = merkleRootHex([cbTxid]);
  const ts = prev.timestamp + 1;
  const { nonce, hash } = powSearch(
    `BTWB1|${height}|${prev.hash}|${merkleRoot}|${ts}|`,
    prev.target,
  );
  return {
    height,
    hash,
    prevHash: prev.hash,
    merkleRoot,
    timestamp: ts,
    nonce,
    target: prev.target,
    miner,
    message: null,
    txs: [
      {
        txid: cbTxid,
        type: "coinbase",
        fromAddress: null,
        toAddress: miner,
        amount,
        fee: 0,
        nonce: null,
        pubkey: null,
        signature: null,
        timestamp: ts,
      },
    ],
  };
}

// -- the narrative -----------------------------------------------------------
// Every block in this file is a bootstrap-era block with an empty PoP pool
// (unless a test announces peers): miner gets exactly the 70% share.
const MINER_SHARE = splitBlockReward(1, 0).miner;
const storage = new MemoryStorage();
let w1: WalletKeys; // mines the first blocks, sends the transfer
let w2: WalletKeys; // recipient
let w3: WalletKeys; // mines the competing branch

describe("browser chain node - full lifecycle", () => {
  beforeAll(async () => {
    await initChain(storage);
    // fixed keys -> a byte-deterministic narrative (baked PoW stays valid)
    w1 = walletFromPrivHex("01".repeat(32))!;
    w2 = walletFromPrivHex("02".repeat(32))!;
    w3 = walletFromPrivHex("03".repeat(32))!;
  }, 10_000);

  it("seals the deterministic genesis (hash pinned across every node)", async () => {
    const g = await storage.blockAt(0);
    expect(g?.hash).toBe(
      "c56c7b1e6bd77fb1cce41b3cb76d05a54c3bfd719db2942066daddf3a52352c3",
    );
    expect(g?.timestamp).toBe(GENESIS_TIMESTAMP);
    const info = await getInfo();
    expect(info.height).toBe(0);
    expect(info.chainId).toBe("bitweb-mainnet-1");
    expect(info.totalSupply).toBe(0);
  });

  it("mines two real blocks locally - subsidy lands", async () => {
    const b1 = await mineNextBlock(w1.address);
    expect(b1.height).toBe(1);
    const b2 = await mineNextBlock(w1.address);
    expect(b2.height).toBe(2);
    const acct = await getAddressOverview(w1.address);
    expect(acct.balance).toBe(2 * MINER_SHARE);
    expect(acct.blocksMined).toBe(2);
  }, 120_000);

  it("rejects garbage transfers before they touch the mempool", async () => {
    const unsigned = {
      from: w1.address,
      to: w2.address,
      amount: 10 * COIN,
      fee: 1_000,
      nonce: 0,
    };
    const goodSig = signTransfer(w1.privHex, unsigned);
    await expect(
      admitTransfer({ ...unsigned, pubkey: w1.pubHex, signature: goodSig, nonce: 7 }),
    ).rejects.toThrow(ChainValidationError);
    const forged = signTransfer(w3.privHex, unsigned); // wrong key for w1's address
    await expect(
      admitTransfer({ ...unsigned, pubkey: w1.pubHex, signature: forged }),
    ).rejects.toThrow(ChainValidationError);
  });

  it("confirms a signed transfer in the next block", async () => {
    const unsigned = {
      from: w1.address,
      to: w2.address,
      amount: 10 * COIN,
      fee: 1_000,
      nonce: 0,
    };
    const signature = signTransfer(w1.privHex, unsigned);
    const { txid } = await admitTransfer({ ...unsigned, pubkey: w1.pubHex, signature });
    expect(txid).toMatch(/^[0-9a-f]{64}$/);
    // re-admitting the same tx trips the state guard first (same as the
    // server reference: nonce rule precedes the duplicate check)
    await expect(
      admitTransfer({ ...unsigned, pubkey: w1.pubHex, signature }),
    ).rejects.toThrow(/bad nonce/);
    expect((await getMempool(10)).length).toBe(1);

    const b3 = await mineNextBlock(w1.address);
    expect(b3.height).toBe(3);
    expect((await getMempool(10)).length).toBe(0);
    const r = await getAddressOverview(w2.address);
    expect(r.balance).toBe(10 * COIN);
    const s = await getAddressOverview(w1.address);
    expect(s.nonce).toBe(1);
    // w1 mined block #3 itself, but the 1000-unit fee is BURNED in full -
    // it never comes back to anyone: 3 miner shares - 10 BTWB sent - fee.
    expect(s.balance).toBe(3 * MINER_SHARE - 10 * COIN - 1_000);
  }, 120_000);

  it("rolls back one block exactly - mempool, balances, supply restored", async () => {
    await rollbackToHeight(2);
    const tip = await getTipSummary();
    expect(tip.height).toBe(2);
    expect((await getMempool(10)).length).toBe(1); // transfer is pending again
    const r = await getAddressOverview(w2.address);
    expect(r.balance).toBe(0);
    const s = await getAddressOverview(w1.address);
    expect(s.balance).toBe(2 * MINER_SHARE);
    expect(s.nonce).toBe(0);
    const info = await getInfo();
    expect(info.totalSupply).toBe(2 * MINER_SHARE);
  });

  it("applies a competing branch from the wire and keeps the pending tx", async () => {
    const side3 = await craftSideBlock(storage, 3, w3.address);
    await applyWireBlock(side3);
    const side4 = await craftSideBlock(storage, 4, w3.address);
    await applyWireBlock(side4);
    const tip = await getTipSummary();
    expect(tip.height).toBe(4);
    expect(tip.hash).toBe(side4.hash);

    const s = await getAddressOverview(w1.address);
    expect(s.balance).toBe(2 * MINER_SHARE); // block #3 reward stayed rolled back
    const m = await getAddressOverview(w3.address);
    expect(m.balance).toBe(2 * MINER_SHARE); // side branch paid w3
    expect((await getMempool(10)).length).toBe(1); // still pending
  }, 120_000);

  it("mines on the winning branch and confirms the long-pending transfer", async () => {
    const b5 = await mineNextBlock(w3.address);
    expect(b5.height).toBe(5);
    expect((await getMempool(10)).length).toBe(0);
    const r = await getAddressOverview(w2.address);
    expect(r.balance).toBe(10 * COIN);
    const s = await getAddressOverview(w1.address);
    expect(s.nonce).toBe(1);
    const info = await getInfo();
    expect(info.height).toBe(5);
  }, 120_000);

  it("rejects forged wire blocks with ChainValidationError", async () => {
    const tip = await getTipSummary();
    const fake = await craftSideBlock(storage, tip.height + 1, w3.address);
    fake.hash = "0".repeat(64); // lie about the header hash
    await expect(applyWireBlock(fake)).rejects.toThrow(ChainValidationError);
  }, 120_000);

  it("no attestations -> the whole 20% peer pool burns", async () => {
    setPopMinerNodeIdProvider(() => TEST_NODE_ID);
    setPopAttestationsProvider(() => []);
    const before = await getInfo();
    let mined: { height: number; hash: string };
    try {
      mined = await mineNextBlock(w3.address);
    } finally {
      setPopMinerNodeIdProvider(() => null);
    }
    expect(mined.height).toBe(6);
    const after = await getInfo();
    // only the miner's 70% was minted - the unattested pool never existed
    expect(after.totalSupply - before.totalSupply).toBe(splitBlockReward(6, 0).miner);
  }, 120_000);

  it("rejects blocks whose PoP attestations fail in any way", async () => {
    const tip = await getTipSummary();
    const height = tip.height + 1; // 7
    const ts = (await storage.blockAt(height - 1))!.timestamp + 1; // deterministic
    const good1 = splitBlockReward(height, 1);
    const good2 = splitBlockReward(height, 2);

    // (a) INVALID SIGNATURE - garbage bytes where a signature should be
    const badSig = await craftSideBlockFull(
      storage, height, w3.address,
      [{ address: w1.address, amount: good1.perPeer, index: 0 }],
      [{ ...attest(w1, TEST_NODE_ID, ts), signature: "cd".repeat(64) }],
    );
    await expect(applyWireBlock(badSig)).rejects.toThrow(/PoP/);

    // (b) WRONG ADDRESS - the attestation pays w2, the block pays w1
    const wrongAddr = await craftSideBlockFull(
      storage, height, w3.address,
      [{ address: w1.address, amount: good1.perPeer, index: 0 }],
      [attest(w2, TEST_NODE_ID, ts)],
    );
    await expect(applyWireBlock(wrongAddr)).rejects.toThrow(/PoP/);

    // (c) EXPIRED - signed 301 s before the block's timestamp
    const expired = await craftSideBlockFull(
      storage, height, w3.address,
      [{ address: w1.address, amount: good1.perPeer, index: 0 }],
      [attest(w1, TEST_NODE_ID, ts - 301)],
    );
    await expect(applyWireBlock(expired)).rejects.toThrow(/PoP/);

    // (d) UNATTESTED PEER - the miner pays w1 AND w2, but only w1 attested
    const unattested = await craftSideBlockFull(
      storage, height, w3.address,
      [
        { address: w1.address, amount: good2.perPeer, index: 0 },
        { address: w2.address, amount: good2.perPeer, index: 1 },
      ],
      [attest(w1, TEST_NODE_ID, ts)],
    );
    await expect(applyWireBlock(unattested)).rejects.toThrow(/PoP/);

    // (e) NOT THE EQUAL SPLIT - greedy share, attestation itself valid
    const greedy = await craftSideBlockFull(
      storage, height, w3.address,
      [{ address: w1.address, amount: good1.perPeer + 1, index: 0 }],
      [attest(w1, TEST_NODE_ID, ts)],
    );
    await expect(applyWireBlock(greedy)).rejects.toThrow(/PoP/);

    // (f) SELF-PAYMENT - the miner "attests" itself with its own key
    const selfPay = await craftSideBlockFull(
      storage, height, w3.address,
      [{ address: w3.address, amount: good1.perPeer, index: 0 }],
      [attest(w3, TEST_NODE_ID, ts)],
    );
    await expect(applyWireBlock(selfPay)).rejects.toThrow(/PoP/);
  }, 300_000);

  it("valid attestations -> block accepted, pool split equally, burn never mints", async () => {
    const before = await getInfo();
    const [a1, a2, a3] = await Promise.all([
      getAddressOverview(w1.address),
      getAddressOverview(w2.address),
      getAddressOverview(w3.address),
    ]);
    // real signatures, real time - the last block of the narrative (its hash
    // is wall-clock-dependent, so nothing deterministic follows it)
    setPopMinerNodeIdProvider(() => TEST_NODE_ID);
    setPopAttestationsProvider(() => [
      attest(w1, TEST_NODE_ID, nowSeconds()),
      attest(w2, TEST_NODE_ID, nowSeconds()),
      attest(w1, TEST_NODE_ID, nowSeconds()), // duplicate - freshest wins
    ]);
    let mined: { height: number; hash: string };
    try {
      mined = await mineNextBlockRealtime(w3.address);
    } finally {
      setPopAttestationsProvider(() => []);
      setPopMinerNodeIdProvider(() => null);
    }
    expect(mined.height).toBe(7);

    const split = splitBlockReward(7, 2);
    const [b1, b2, b3] = await Promise.all([
      getAddressOverview(w1.address),
      getAddressOverview(w2.address),
      getAddressOverview(w3.address),
    ]);
    expect(b3.balance - a3.balance).toBe(split.miner);
    expect(b1.balance - a1.balance).toBe(split.perPeer);
    expect(b2.balance - a2.balance).toBe(split.perPeer);
    const after = await getInfo();
    expect(after.totalSupply - before.totalSupply).toBe(split.miner + 2 * split.perPeer);

    // the stored block carries the full attestation evidence for sync peers
    const stored = await storage.blockAt(7);
    expect(stored?.minerPeerId).toBe(TEST_NODE_ID);
    expect(stored?.popAttestations.length).toBe(2);
  }, 300_000);
});

/** Like craftSideBlock, but commits to explicit PoP payouts + attestations. */
async function craftSideBlockFull(
  storage: MemoryStorage,
  height: number,
  miner: string,
  pops: Array<{ address: string; amount: number; index: number }>,
  atts: PopAttestation[],
): Promise<WireBlock> {
  const prev = await storage.blockAt(height - 1);
  if (!prev) throw new Error("side-block parent missing");
  const amount = splitBlockReward(height, pops.length).miner;
  const cbTxid = dsha256Hex(serializeCoinbase({ height, to: miner, amount }));
  const popIds = pops.map((pop) =>
    dsha256Hex(
      serializePopTransfer({ height, index: pop.index, to: pop.address, amount: pop.amount }),
    ),
  );
  const merkleRoot = merkleRootHex([cbTxid, ...popIds]);
  const ts = prev.timestamp + 1;
  const { nonce, hash } = powSearch(
    `BTWB1|${height}|${prev.hash}|${merkleRoot}|${ts}|`,
    prev.target,
  );
  return {
    height,
    hash,
    prevHash: prev.hash,
    merkleRoot,
    timestamp: ts,
    nonce,
    target: prev.target,
    miner,
    message: null,
    popTransfers: pops,
    minerPeerId: TEST_NODE_ID,
    popAttestations: atts,
    txs: [
      {
        txid: cbTxid,
        type: "coinbase",
        fromAddress: null,
        toAddress: miner,
        amount,
        fee: 0,
        nonce: null,
        pubkey: null,
        signature: null,
        timestamp: ts,
      },
    ],
  };
}

describe("miner cooldown (consensus from block 2,000)", () => {
  it("no address may mine two consecutive blocks once active", () => {
    const a = "btw1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const b = "btw1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    expect(violatesMinerCooldown(1, a, a)).toBe(false); // bootstrap era
    expect(violatesMinerCooldown(1_999, a, a)).toBe(false); // below activation
    expect(violatesMinerCooldown(2_000, a, b)).toBe(false); // rotation is fine
    expect(violatesMinerCooldown(2_000, a, null)).toBe(false); // unknown parent
    expect(violatesMinerCooldown(2_000, a, a)).toBe(true); // consecutive self
    expect(violatesMinerCooldown(9_999, a, a)).toBe(true); // stays enforced
  });

  it("below activation a repeat miner still gets a template (the gate opens only at 2,000)", async () => {
    const tip = await getTipSummary();
    expect(tip.height).toBeLessThan(2_000);
    const tipBlock = (await getRecentBlocks(1))[0];
    const tpl = await buildTemplate(tipBlock.miner); // same miner again - allowed here
    expect(tpl.height).toBe(tip.height + 1);
    // ...but that exact pairing becomes a violation the moment the gate opens:
    expect(violatesMinerCooldown(2_000, tipBlock.miner, tipBlock.miner)).toBe(true);
  });
});
