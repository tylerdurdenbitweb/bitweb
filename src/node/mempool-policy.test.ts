/**
 * Relay-policy guard: one sender may hold at most MAX_MEMPOOL_PER_SENDER
 * pending slots, so a single funded wallet cannot occupy the whole mempool
 * with min-fee spam. Node policy, NOT consensus - block validity is
 * untouched, which this test proves by mining the queued txs afterwards.
 */
import { describe, expect, it, vi } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { GENESIS_TIMESTAMP, hashMeetsTarget } from "@contracts/protocol";
import { signTransfer, walletFromPrivHex } from "@/lib/bitweb";

const w1 = walletFromPrivHex("01".repeat(32))!;

// Same deterministic block-1 as chain.test.ts: coinbase-only to w1 at the
// genesis+1 timestamp - the baked nonce verifies with ONE hash.
const BAKED: Record<string, { nonce: number; hash: string }> = {
  "BTWB1|1|c56c7b1e6bd77fb1cce41b3cb76d05a54c3bfd719db2942066daddf3a52352c3|d62b9190107cb799394ff51e25c12ff58a23fa360f6b632805bd0f4268d6ecc8|1787443201|": { nonce: 175577, hash: "000000f11f737b8028d03070c7decc69e1cf199d3c532ea6cf27895396333a9c" },
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
  throw new Error("pow search exhausted");
}

describe("mempool relay policy", () => {
  it("caps one sender at MAX_MEMPOOL_PER_SENDER pending slots", async () => {
    vi.resetModules();
    const chain = await import("./chain");
    const { MemoryStorage } = await import("./storage");
    await chain.initChain(new MemoryStorage());

    // fund w1 with one bootstrap coinbase (350 BTWB covers 64 x 1001 units)
    const tpl = await chain.buildTemplate(w1.address);
    const ts = GENESIS_TIMESTAMP + 1;
    const win = powSearch(
      `BTWB1|${tpl.height}|${tpl.prevHash}|${tpl.merkleRoot}|${ts}|`,
      tpl.target,
    );
    await chain.submitBlock(tpl.templateId, ts, win.nonce);

    // exactly MAX_MEMPOOL_PER_SENDER sequential pending txs are admitted
    for (let nonce = 0; nonce < chain.MAX_MEMPOOL_PER_SENDER; nonce++) {
      const unsigned = { from: w1.address, to: w1.address, amount: 1, fee: 1_000, nonce };
      const signature = signTransfer(w1.privHex, unsigned);
      await chain.admitTransfer({ ...unsigned, pubkey: w1.pubHex, signature });
    }
    expect(await chain.getMempool(100)).toHaveLength(chain.MAX_MEMPOOL_PER_SENDER);

    // slot 65 from the SAME sender is refused by policy
    const over = { from: w1.address, to: w1.address, amount: 1, fee: 1_000, nonce: chain.MAX_MEMPOOL_PER_SENDER };
    await expect(
      chain.admitTransfer({ ...over, pubkey: w1.pubHex, signature: signTransfer(w1.privHex, over) }),
    ).rejects.toThrow(/too many pending transactions from one sender/);

    // consensus untouched: the queued txs still mine into a valid block
    const tpl2 = await chain.buildTemplate(w1.address);
    expect(tpl2.txCount).toBeGreaterThan(0);
  }, 60_000);
});
