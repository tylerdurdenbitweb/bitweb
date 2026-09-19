/**
 * Total-burned counter - the number behind the Terminal page's
 * "BURNED FOREVER: %x" line. totalBurned is derived, never stored:
 *
 *     totalBurned = (sum of every block reward ever emitted) - totalSupply
 *
 * Rewards are a pure function of height, so the emission sum is exact on
 * every chain path - and the gap between emission and live supply is by
 * construction the split burn + rounding dust + unclaimed PoP + fees.
 * These tests pin that identity with real blocks, real fees, a rollback,
 * and a file import.
 */
import { describe, expect, it, vi } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { COIN, hashMeetsTarget } from "@contracts/protocol";
import { signTransfer, walletFromPrivHex } from "@/lib/bitweb";
import { MemoryStorage } from "./storage";

const w1 = walletFromPrivHex("01".repeat(32))!;
const w2 = walletFromPrivHex("02".repeat(32))!;

// Deterministic PoW, coinbase-only chain paying w1 (same preimages as
// chain-gate.test.ts / import-safety.test.ts - searched once, baked).
const BAKED: Record<string, { nonce: number; hash: string }> = {
  "BTWB1|1|c56c7b1e6bd77fb1cce41b3cb76d05a54c3bfd719db2942066daddf3a52352c3|d62b9190107cb799394ff51e25c12ff58a23fa360f6b632805bd0f4268d6ecc8|1787443201|": { nonce: 175577, hash: "000000f11f737b8028d03070c7decc69e1cf199d3c532ea6cf27895396333a9c" },
  "BTWB1|2|000000f11f737b8028d03070c7decc69e1cf199d3c532ea6cf27895396333a9c|e77599e7f9dbb191ff935eaa383ebb388616bf785ce87173a73ed59bcf41ba27|1787443202|": { nonce: 8699338, hash: "0000018c8f7cb7fd26d55c2201def5173ef6bbc90a1518e090d25a126609de77" },
  "BTWB1|2|000000f11f737b8028d03070c7decc69e1cf199d3c532ea6cf27895396333a9c|effcd74ffd22e3e368fe9b92eefecaa2475238a678c4033dff3111f0cc0bd7c8|1787443202|": { nonce: 5788538, hash: "000001b8f99391e55857d8e90ea1746134c30b689c4fed6d369a2cafe667b1ff" },
  "BTWB1|3|0000018c8f7cb7fd26d55c2201def5173ef6bbc90a1518e090d25a126609de77|310b1cbfa1b4759aa9d83cdae0aebfc002c52a1893cbbf7fd58ccb5184ca7d52|1787443203|": { nonce: 4550900, hash: "0000019c681bbcc35fa1ae47a1915afa8cbe42604cc0d35bdbecbb5d5003d4a6" },
};

function powSearch(prefixAscii: string, target: string): { nonce: number; hash: string } {
  const baked = BAKED[prefixAscii];
  if (baked) return baked;
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

type ChainModule = typeof import("./chain");

async function freshChain(): Promise<ChainModule> {
  vi.resetModules();
  const chain = await import("./chain");
  await chain.initChain(new MemoryStorage());
  return chain;
}

async function mineOne(chain: ChainModule): Promise<{ height: number; hash: string }> {
  const tpl = await chain.buildTemplate(w1.address);
  const ts = tpl.minTimestamp;
  const { nonce } = powSearch(
    `BTWB1|${tpl.height}|${tpl.prevHash}|${tpl.merkleRoot}|${ts}|`,
    tpl.target,
  );
  const r = await chain.submitBlock(tpl.templateId, ts, nonce);
  return { height: r.height, hash: r.hash };
}

// Bootstrap era: 500 BTWB per block; solo miner (zero attesting peers)
// mints only the 70% share = 350; the other 150 (10% burn + unclaimed 20%
// pool) is gone forever.
const BLOCK_EMISSION = 500 * COIN;
const SOLO_MINTED = 350 * COIN;
const SOLO_BURNED = BLOCK_EMISSION - SOLO_MINTED; // 150 BTWB

describe("totalBurned - the BURNED FOREVER counter", () => {
  it("genesis: nothing emitted, nothing burned", async () => {
    const chain = await freshChain();
    const info = await chain.getInfo();
    expect(info.totalSupply).toBe(0);
    expect(info.totalBurned).toBe(0);
  });

  it("one solo block: 500 emitted, 350 minted, exactly 150 burned", async () => {
    const chain = await freshChain();
    await mineOne(chain);
    const info = await chain.getInfo();
    expect(info.totalSupply).toBe(SOLO_MINTED);
    expect(info.totalBurned).toBe(SOLO_BURNED);
    // conservation: emission = supply + burned, to the last base unit
    expect(info.totalSupply + info.totalBurned).toBe(BLOCK_EMISSION);
  }, 300_000);

  it("fees join the burn: a mined transfer burns its fee on top of the split", async () => {
    const chain = await freshChain();
    await mineOne(chain); // fund w1 (baked)

    const unsigned = { from: w1.address, to: w2.address, amount: 10 * COIN, fee: 1_000, nonce: 0 };
    const signature = signTransfer(w1.privHex, unsigned);
    await chain.admitTransfer({ ...unsigned, pubkey: w1.pubHex, signature });

    await mineOne(chain); // includes the transfer - live PoW (new merkle)
    const info = await chain.getInfo();
    expect(info.totalSupply).toBe(2 * SOLO_MINTED - 1_000); // fee left existence
    expect(info.totalBurned).toBe(2 * SOLO_BURNED + 1_000); // and joined the counter
    expect(info.totalSupply + info.totalBurned).toBe(2 * BLOCK_EMISSION);
    expect((await chain.getAddressOverview(w2.address)).balance).toBe(10 * COIN);
  }, 300_000);

  it("rollback un-burns exactly what the undone blocks had burned", async () => {
    const chain = await freshChain();
    await mineOne(chain);
    await mineOne(chain);
    expect((await chain.getInfo()).totalBurned).toBe(2 * SOLO_BURNED);

    await chain.rollbackToHeight(1);
    const info = await chain.getInfo();
    expect(info.height).toBe(1);
    expect(info.totalBurned).toBe(SOLO_BURNED); // emission cache rebuilt, not stale
    expect(info.totalSupply + info.totalBurned).toBe(BLOCK_EMISSION);
  }, 300_000);

  it("import: a fresh node derives the full burned figure from the file", async () => {
    const src = await freshChain();
    for (let h = 1; h <= 3; h++) await mineOne(src);
    const file = JSON.parse(JSON.stringify(await src.exportChain())) as unknown;
    expect((await src.getInfo()).totalBurned).toBe(3 * SOLO_BURNED);

    const dst = await freshChain();
    await dst.importChain(file);
    const info = await dst.getInfo();
    expect(info.height).toBe(3);
    expect(info.totalBurned).toBe(3 * SOLO_BURNED);
    expect(info.totalSupply + info.totalBurned).toBe(3 * BLOCK_EMISSION);
  }, 300_000);
});
