/**
 * Import safety - the chain can never be downgraded by a file, and the
 * balance math has a numeric proof.
 *
 *   - SHORTER file: rejected by default (ChainDowngradeError), local chain
 *     and balances intact - even { replace: true } alone is not enough.
 *     Only { replace, allowDowngrade } (the UI's dangerous override, which
 *     shows both heights and both tip hashes) applies it - and logs it.
 *   - EQUAL height, same tip: "already up to date" no-op.
 *   - EQUAL height, different tip: fork conflict, default = keep local.
 *   - LONGER valid file: applied directly (the normal case).
 *   - LONGER invalid file: rejected before a single write.
 *   - NUMERIC PROOF: the known 14-block reference chain (heights 0-13, 13
 *     coinbases of 350 BTWB to one address) imported on an EMPTY node gives
 *     balance === spendable === 4550 BTWB, topbar compact "4.55k".
 */
import { describe, expect, it, vi } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { COIN, hashMeetsTarget, splitBlockReward } from "@contracts/protocol";
import { walletFromPrivHex } from "@/lib/bitweb";
import { fmtCompact } from "@/lib/format";
import { MemoryStorage } from "./storage";

const w1 = walletFromPrivHex("01".repeat(32))!;
const w2 = walletFromPrivHex("02".repeat(32))!;

const BAKED: Record<string, { nonce: number; hash: string }> = {
  "BTWB1|1|c56c7b1e6bd77fb1cce41b3cb76d05a54c3bfd719db2942066daddf3a52352c3|61e058dc8dec4aa8f0b684827bd45414b1748b3e8f3a0f358ba8ac9016d201fb|1787443201|": { nonce: 4284016, hash: "00000045d6b8b5ed60f212cc69dbc19e50f74f13c619b69e1e97d005c94e195a" },
  "BTWB1|1|c56c7b1e6bd77fb1cce41b3cb76d05a54c3bfd719db2942066daddf3a52352c3|d62b9190107cb799394ff51e25c12ff58a23fa360f6b632805bd0f4268d6ecc8|1787443201|": { nonce: 175577, hash: "000000f11f737b8028d03070c7decc69e1cf199d3c532ea6cf27895396333a9c" },
  "BTWB1|2|000000f11f737b8028d03070c7decc69e1cf199d3c532ea6cf27895396333a9c|e77599e7f9dbb191ff935eaa383ebb388616bf785ce87173a73ed59bcf41ba27|1787443202|": { nonce: 8699338, hash: "0000018c8f7cb7fd26d55c2201def5173ef6bbc90a1518e090d25a126609de77" },
  "BTWB1|3|0000018c8f7cb7fd26d55c2201def5173ef6bbc90a1518e090d25a126609de77|310b1cbfa1b4759aa9d83cdae0aebfc002c52a1893cbbf7fd58ccb5184ca7d52|1787443203|": { nonce: 4550900, hash: "0000019c681bbcc35fa1ae47a1915afa8cbe42604cc0d35bdbecbb5d5003d4a6" },
  "BTWB1|4|0000019c681bbcc35fa1ae47a1915afa8cbe42604cc0d35bdbecbb5d5003d4a6|762ff701143fc93acd1a0ccbb1043b43fde5191f659d4a69132e7281608a33e0|1787443204|": { nonce: 4021346, hash: "000001d55827e27b8df5e9938bb0667c4d298d07083ee7c18f139579c8898652" },
  "BTWB1|5|000001d55827e27b8df5e9938bb0667c4d298d07083ee7c18f139579c8898652|599518f179ae3842a04ad01261b65e7987cfbb650ede9324ff465be3b6a2fb34|1787443205|": { nonce: 1133285, hash: "00000213ebb19d311cf90c0b211b3fb7762a8b1490c8f8af4a974529209f2dfb" },
  "BTWB1|6|00000213ebb19d311cf90c0b211b3fb7762a8b1490c8f8af4a974529209f2dfb|0fdd0afd0e9f61c13930ef4c4e1b7b65ff2797b3fab747576de2e23bf1267f2e|1787443206|": { nonce: 10689933, hash: "0000029bb29b2c2ff89375d9dc1711caf87386d1abe67c18768f636f3533a40f" },
  "BTWB1|7|0000029bb29b2c2ff89375d9dc1711caf87386d1abe67c18768f636f3533a40f|ae8e6dff88a16fcacfabf92ff10b3b5d66ed0644897dd09933cbba266ae385ac|1787443207|": { nonce: 2410914, hash: "0000012e24ad2df36cb450af2388031ee29f518f27d2127dbea85a901befd5da" },
  "BTWB1|8|0000012e24ad2df36cb450af2388031ee29f518f27d2127dbea85a901befd5da|e5c982d6c314124e02f2829760bd1e16ea559671006d4fc71618b4e1e734d972|1787443208|": { nonce: 25883692, hash: "000000d79d0595504d3f0208c9a85cef6e7da05e57e12f898584f2ea0aca2d10" },
  "BTWB1|9|000000d79d0595504d3f0208c9a85cef6e7da05e57e12f898584f2ea0aca2d10|02c01e26149ce8166885ec2813326532204d803cb1067c77f46a6ec305e8dd89|1787443209|": { nonce: 2391910, hash: "0000004bc18fd0cc1c5b9c61b1e5ae0306c9daff52f7cd4cd90e4cab038fd544" },
  "BTWB1|10|0000004bc18fd0cc1c5b9c61b1e5ae0306c9daff52f7cd4cd90e4cab038fd544|12e2e5343274afaef4751c1a386d858680b8d1e2cbc96bbbf02c62b2bf885e3f|1787443210|": { nonce: 20450123, hash: "0000002a8307ad7f9ebf5fd0877242140002dd0e33bccd685866d73f92b214d5" },
  "BTWB1|11|0000002a8307ad7f9ebf5fd0877242140002dd0e33bccd685866d73f92b214d5|4b50cb158100e09155a010c35b3bc17e6884ec9da407ec4c7c0d4fb4a807cce9|1787443211|": { nonce: 9499841, hash: "0000005af7476bd6ac7c57d6c13a4e5af7f21f67786db1f277051b9161f6164a" },
  "BTWB1|12|0000005af7476bd6ac7c57d6c13a4e5af7f21f67786db1f277051b9161f6164a|4afcdff419e71aafa4504e1235e0816bf31155a73067a27656d858c3af96382e|1787443212|": { nonce: 3628068, hash: "00000051b3e93073343956da33302039e0bfcf88090c4cc34b69dac5f9246875" },
  "BTWB1|13|00000051b3e93073343956da33302039e0bfcf88090c4cc34b69dac5f9246875|ba24d91d719f9efa32c17325dd45f787d5a251ae67a9a1e7236bed3996c01d02|1787443213|": { nonce: 24129900, hash: "00000046824fab052eab3171c83b2f1cea9d61028602aa577a559fdbfaf4743b" },
  // blocks 1-13 paying w1, one continuous coinbase-only chain (the known
  // 14-block reference chain) - deterministic preimages, baked once
  // block #1 paying w2 (the fork / longer-chain tests below)
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

async function mineOne(chain: ChainModule, miner: string): Promise<{ height: number; hash: string }> {
  const tpl = await chain.buildTemplate(miner);
  const ts = tpl.minTimestamp;
  const { nonce } = powSearch(
    `BTWB1|${tpl.height}|${tpl.prevHash}|${tpl.merkleRoot}|${ts}|`,
    tpl.target,
  );
  const r = await chain.submitBlock(tpl.templateId, ts, nonce);
  return { height: r.height, hash: r.hash };
}

function asFile(data: unknown): unknown {
  return JSON.parse(JSON.stringify(data));
}

describe("import safety - never downgrade the chain", () => {
  it("NUMERIC PROOF: 13 x 350 BTWB coinbases on an empty node -> 4550 / 4550 / compact", async () => {
    const src = await freshChain();
    for (let h = 1; h <= 13; h++) await mineOne(src, w1.address);
    const data = asFile(await src.exportChain());

    const dst = await freshChain(); // EMPTY node (genesis only)
    const res = await dst.importChain(data);
    expect(res).toEqual({ height: 13, applied: true });

    const perBlock = splitBlockReward(1, 0).miner; // 350 BTWB - the 70% share
    expect(perBlock).toBe(350 * COIN);
    const expected = 13 * perBlock; // 4,550 BTWB - no double counting of anything
    const view = await dst.getAddressOverview(w1.address);
    expect(view.balance).toBe(expected);
    expect(view.available).toBe(expected); // no pending outgoing
    expect(view.balance).toBe(4550 * COIN);
    expect(view.available).toBe(4550 * COIN);
    expect(fmtCompact(view.balance)).toBe("4.55k"); // the topbar figure in "BTWB: 4.55k"
    // the whole supply is exactly those 13 coinbases - nothing else exists
    expect((await dst.getInfo()).totalSupply).toBe(expected);
  }, 300_000);

  it("a SHORTER file is rejected by default - local chain and balance intact", async () => {
    const src = await freshChain();
    const b1 = await mineOne(src, w1.address);
    const shortFile = asFile(await src.exportChain()); // height 1

    const local = await freshChain();
    await local.importChain(shortFile);
    await mineOne(local, w1.address);
    const tip = await mineOne(local, w1.address); // local is now height 3
    const balBefore = (await local.getAddressOverview(w1.address)).balance;

    const err = await local.importChain(shortFile).catch((e) => e);
    expect(err).toBeInstanceOf(local.ChainDowngradeError);
    expect(err.kind).toBe("downgrade");
    expect(err.local).toEqual({ height: 3, hash: tip.hash });
    expect(err.incoming).toEqual({ height: 1, hash: b1.hash });
    expect(err.message).toMatch(/SHORTER \(H:1\) than your local chain \(H:3\)/);
    expect(err.message).toMatch(/lose 2 block\(s\)/);

    // untouched: tip, balance, and spendable are exactly what they were
    expect((await local.getInfo()).tipHash).toBe(tip.hash);
    const view = await local.getAddressOverview(w1.address);
    expect(view.balance).toBe(balBefore);
    expect(view.available).toBe(balBefore);
  }, 300_000);

  it("{ replace: true } alone is NOT enough for a downgrade", async () => {
    const src = await freshChain();
    await mineOne(src, w1.address);
    const shortFile = asFile(await src.exportChain());

    const local = await freshChain();
    await local.importChain(shortFile);
    await mineOne(local, w1.address);
    const tip = await local.getTipSummary();

    await expect(local.importChain(shortFile, { replace: true })).rejects.toBeInstanceOf(
      local.ChainDowngradeError,
    );
    expect((await local.getTipSummary()).hash).toBe(tip.hash);
  }, 300_000);

  it("dangerous override: shorter file applies ONLY with replace + allowDowngrade, and is logged", async () => {
    const src = await freshChain();
    const b1 = await mineOne(src, w1.address);
    const shortFile = asFile(await src.exportChain());

    const local = await freshChain();
    await local.importChain(shortFile);
    await mineOne(local, w1.address);
    await mineOne(local, w1.address); // local height 3

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const res = await local.importChain(shortFile, { replace: true, allowDowngrade: true });
    expect(res).toEqual({ height: 1, applied: true });
    expect((await local.getTipSummary()).hash).toBe(b1.hash);
    // the override is on record - both heights, both tip hashes
    const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toMatch(/DANGEROUS OVERRIDE/);
    expect(logged).toContain(b1.hash);
    warn.mockRestore();
  }, 300_000);

  it("equal height, same tip -> already up to date, zero change", async () => {
    const src = await freshChain();
    await mineOne(src, w1.address);
    const data = asFile(await src.exportChain());

    const dst = await freshChain();
    await dst.importChain(data);
    const res = await dst.importChain(data);
    expect(res).toEqual({ height: 1, applied: false });
  }, 300_000);

  it("equal height, different tip -> fork warning, default keeps local", async () => {
    const src = await freshChain();
    const fileTip = await mineOne(src, w1.address);
    const data = asFile(await src.exportChain());

    const local = await freshChain();
    const localTip = await mineOne(local, w2.address); // same height, other chain

    const err = await local.importChain(data).catch((e) => e);
    expect(err).toBeInstanceOf(local.ChainConflictError);
    expect(err.kind).toBe("fork");
    expect(err.local.hash).toBe(localTip.hash);
    expect(err.incoming.hash).toBe(fileTip.hash);
    // default = keep local
    expect((await local.getTipSummary()).hash).toBe(localTip.hash);
    // explicit opt-in replaces
    const res = await local.importChain(data, { replace: true });
    expect(res).toEqual({ height: 1, applied: true });
    expect((await local.getTipSummary()).hash).toBe(fileTip.hash);
  }, 300_000);

  it("a LONGER valid file applies directly - the normal case needs no confirmation", async () => {
    const src = await freshChain();
    await mineOne(src, w1.address);
    await mineOne(src, w1.address);
    const fileTip = await mineOne(src, w1.address); // height 3
    const data = asFile(await src.exportChain());

    const local = await freshChain();
    await mineOne(local, w2.address); // a DIFFERENT local chain, height 1

    const res = await local.importChain(data); // no replace flag at all
    expect(res).toEqual({ height: 3, applied: true });
    expect((await local.getTipSummary()).hash).toBe(fileTip.hash);
    // balances recomputed from the resulting chain: w2's local history is gone
    expect((await local.getAddressOverview(w2.address)).balance).toBe(0);
    expect((await local.getAddressOverview(w1.address)).balance).toBe(3 * 350 * COIN);
  }, 300_000);

  it("a LONGER invalid file is rejected - local chain fully intact", async () => {
    const src = await freshChain();
    await mineOne(src, w1.address);
    await mineOne(src, w1.address);
    const data = asFile(await src.exportChain()) as Awaited<ReturnType<typeof src.exportChain>>;
    data.blocks[2].txs[0].amount += 1; // forged coinbase on the longer chain

    const local = await freshChain();
    const localTip = await mineOne(local, w2.address);
    await expect(local.importChain(data)).rejects.toThrow(/coinbase|amount/i);
    expect((await local.getTipSummary()).hash).toBe(localTip.hash);
    expect((await local.getAddressOverview(w2.address)).balance).toBe(350 * COIN);
  }, 300_000);
});
