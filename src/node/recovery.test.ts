/**
 * Boot recovery - the balances table is derived state. If it is ever lost
 * while the blocks survive (partial storage eviction, profile damage), the
 * node must rebuild it: replaying from genesis, or from the latest local
 * state snapshot when one exists. Real PoW, memory adapter, one continuous
 * narrative (the chain module binds one storage per process).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { hashMeetsTarget } from "@contracts/protocol";
import { walletFromPrivHex } from "@/lib/bitweb";
import {
  buildTemplate,
  getAddressOverview,
  getInfo,
  initChain,
  recoverChainState,
  submitBlock,
} from "./chain";
import { MemoryStorage } from "./storage";

// Baked PoW solutions (deterministic narrative: fixed keys, synthetic
// timestamps) - verified with ONE hash each; the live search only grinds
// when the narrative changes (and prints fresh solutions to bake).
const BAKED: Record<string, { nonce: number; hash: string }> = {
  "BTWB1|1|c56c7b1e6bd77fb1cce41b3cb76d05a54c3bfd719db2942066daddf3a52352c3|6c3bb1dcd239c6cd10733a1675648f6a08deabf5483facff6767c35afda186ff|1787443201|": { nonce: 226141, hash: "0000038e6eeeb8de1aa8bbe69b548c9d6bebc03cd51874b35b46fd08541cadba" },
  "BTWB1|2|0000038e6eeeb8de1aa8bbe69b548c9d6bebc03cd51874b35b46fd08541cadba|78f93090bafefdcd1e0cd2978d13e14772fd6166158f1bb03cedcca6a409635a|1787443202|": { nonce: 4441267, hash: "00000083b48737728aa42d7c64e002f4ce8d25a1122c368f7ba514472c3176e2" },
  "BTWB1|3|00000083b48737728aa42d7c64e002f4ce8d25a1122c368f7ba514472c3176e2|327723064c8befa1726e876e536d8bd2e49d91dd1507e000f17725b0e053b0fa|1787443203|": { nonce: 3122701, hash: "0000001399de01f52337efaccef52c9804679dc1e34faaabd3b4a4889b91fe0a" },
};

function pow(prefixAscii: string, target: string): { nonce: number; hash: string } {
  const baked = BAKED[prefixAscii];
  const prefix = utf8ToBytes(prefixAscii);
  if (baked) {
    const d1 = sha256.create().update(prefix).update(utf8ToBytes(String(baked.nonce))).digest();
    const hash = bytesToHex(sha256(d1));
    if (hash !== baked.hash || !hashMeetsTarget(hash, target)) {
      throw new Error(`baked solution invalid for ${prefixAscii}`);
    }
    return baked;
  }
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

async function mineNext(miner: string): Promise<void> {
  const tpl = await buildTemplate(miner);
  const ts = tpl.minTimestamp; // synthetic - deterministic narrative
  const { nonce } = pow(
    `BTWB1|${tpl.height}|${tpl.prevHash}|${tpl.merkleRoot}|${ts}|`,
    tpl.target,
  );
  await submitBlock(tpl.templateId, ts, nonce);
}

/** Simulate the disaster: every account zeroed (balances sum != supply). */
async function wipeBalances(storage: MemoryStorage): Promise<void> {
  await storage.transact(async (tx) => {
    for (const acc of await tx.allAccounts()) {
      await tx.putAccount({ ...acc, balance: 0 });
    }
  });
}

describe("boot state recovery", () => {
  const storage = new MemoryStorage();
  const minerA = walletFromPrivHex("aa".repeat(32))!;
  const minerB = walletFromPrivHex("bb".repeat(32))!;

  beforeAll(async () => {
    await initChain(storage);
    await mineNext(minerA.address); // block 1
    await mineNext(minerA.address); // block 2
  }, 120_000);

  it("rebuilds lost balances by replaying blocks from genesis", async () => {
    const before = await getAddressOverview(minerA.address);
    const supplyBefore = (await getInfo()).totalSupply;
    expect(before.balance).toBeGreaterThan(0);

    await wipeBalances(storage);
    await recoverChainState();

    const after = await getAddressOverview(minerA.address);
    expect(after.balance).toBe(before.balance);
    expect((await getInfo()).totalSupply).toBe(supplyBefore);
  });

  /** The supply the BLOCKS themselves imply: sum(reward + pop - fees). */
  async function blockImpliedSupply(): Promise<number> {
    const tip = (await storage.tip())!;
    let sum = 0;
    for (let h = 1; h <= tip.height; h++) {
      const b = (await storage.blockAt(h))!;
      sum += b.reward + b.popTransfers.reduce((x, p) => x + p.amount, 0) - b.feesBurned;
    }
    return sum;
  }

  it("a corrupted totalSupply meta heals back to the block-implied value", async () => {
    // Drift left behind by any historical version: the meta row no longer
    // matches the chain. Balances are INTACT - a rebuild must restore the
    // meta without touching (let alone double-crediting) a single balance.
    const expected = await blockImpliedSupply();
    expect((await getInfo()).totalSupply).toBe(expected);
    const balA = (await getAddressOverview(minerA.address)).balance;

    await storage.transact(async (tx) => {
      await tx.setMeta("totalSupply", String(expected + 12_345));
    });
    await recoverChainState();

    expect((await getInfo()).totalSupply).toBe(expected);
    expect((await getAddressOverview(minerA.address)).balance).toBe(balA);
  });

  it("a single corrupted balance heals, supply untouched", async () => {
    const expected = await blockImpliedSupply();
    const balA = (await getAddressOverview(minerA.address)).balance;

    await storage.transact(async (tx) => {
      const acc = (await tx.account(minerA.address))!;
      await tx.putAccount({ ...acc, balance: acc.balance + 1 });
    });
    await recoverChainState();

    expect((await getInfo()).totalSupply).toBe(expected);
    expect((await getAddressOverview(minerA.address)).balance).toBe(balA);
  });

  it("supply and balances drifted TOGETHER still heals (the old check missed this)", async () => {
    // The pre-fix invariant was only sum(balances) === totalSupply: drift
    // that moved BOTH caches by the same amount passed it and lived
    // forever - which is exactly how devices ended up showing different
    // supply for the same chain. The block-implied cross-check catches it.
    const expected = await blockImpliedSupply();
    const balA = (await getAddressOverview(minerA.address)).balance;

    await storage.transact(async (tx) => {
      const acc = (await tx.account(minerA.address))!;
      await tx.putAccount({ ...acc, balance: acc.balance + 777 });
      await tx.setMeta("totalSupply", String(expected + 777));
    });
    // sanity: the OLD invariant alone would call this state healthy
    const accounts = await storage.allAccounts();
    const held = accounts.reduce((s, a) => s + a.balance, 0);
    expect(held).toBe(expected + 777);

    await recoverChainState();

    expect((await getInfo()).totalSupply).toBe(expected);
    expect((await getAddressOverview(minerA.address)).balance).toBe(balA);
  });

  it("rebuilds from the latest snapshot even when early blocks are gone", async () => {
    // The exact row the SNAPSHOT_INTERVAL hook persists every 1,000 blocks.
    // NOTE: destructive (block 1 is deleted) - must run LAST in this file.
    const tip2 = (await storage.tip())!;
    expect(tip2.height).toBe(2);
    const accountsAt2 = await storage.allAccounts();
    const supplyAt2 = Number((await storage.getMeta("totalSupply")) ?? "0");
    await storage.transact(async (tx) => {
      await tx.putSnapshot({
        height: tip2.height,
        blockHash: tip2.hash,
        totalSupply: supplyAt2,
        accounts: accountsAt2,
      });
    });

    await mineNext(minerB.address); // block 3
    const before = await getAddressOverview(minerB.address);
    const supplyBefore = (await getInfo()).totalSupply;
    expect(before.balance).toBeGreaterThan(0);

    // Worse disaster: balances wiped AND block 1 pruned away - replaying
    // from genesis is impossible; only the snapshot path can heal this.
    await storage.transact(async (tx) => {
      for (const acc of await tx.allAccounts()) {
        await tx.putAccount({ ...acc, balance: 0 });
      }
      await tx.deleteTxsInBlock(1);
      await tx.deleteBlock(1);
    });
    await recoverChainState();

    const afterA = await getAddressOverview(minerA.address);
    const afterB = await getAddressOverview(minerB.address);
    expect(afterB.balance).toBe(before.balance);
    expect(afterA.balance).toBe(supplyAt2); // snapshot state survived intact
    expect((await getInfo()).totalSupply).toBe(supplyBefore);
  }, 120_000);
});
