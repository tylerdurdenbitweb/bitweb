/**
 * Pruning under a hostile lens: the opt-in history prune must delete ONLY
 * confirmed tx rows below the horizon, refuse anything inside the reorg
 * window, keep headers/balances/supply/tip perfectly intact, and the node
 * must keep mining and validating afterwards. A pruned node must also
 * REFUSE a full-chain export loudly (its history has holes).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { GENESIS_TIMESTAMP, TARGET_BLOCK_TIME, hashMeetsTarget } from "@contracts/protocol";
import { walletFromPrivHex } from "@/lib/bitweb";
import {
  ChainValidationError,
  buildTemplate,
  exportChain,
  getAddressOverview,
  getInfo,
  getWireBlock,
  initChain,
  pruneConfirmedTxsBelow,
  submitBlock,
} from "./chain";
import { MemoryStorage } from "./storage";

const w1 = walletFromPrivHex("01".repeat(32))!;
const PRUNE_NARRATIVE_BLOCKS = 35;

// Coinbase-only chain to w1: every preimage is deterministic, so nonces are
// baked after the first live grind (see chain.test.ts for the pattern).
const BAKED: Record<string, { nonce: number; hash: string }> = {
  "BTWB1|1|c56c7b1e6bd77fb1cce41b3cb76d05a54c3bfd719db2942066daddf3a52352c3|d62b9190107cb799394ff51e25c12ff58a23fa360f6b632805bd0f4268d6ecc8|1787443260|": { nonce: 5039673, hash: "0000014cb6ad9ddee9ea9b46b7d0bdd15017b5670403280141c6df661d3a54cb" },
  "BTWB1|2|0000014cb6ad9ddee9ea9b46b7d0bdd15017b5670403280141c6df661d3a54cb|e77599e7f9dbb191ff935eaa383ebb388616bf785ce87173a73ed59bcf41ba27|1787443320|": { nonce: 341842, hash: "0000038db4700c3d087013882c27f0afbcc467f67aabf648289716e11439fb7c" },
  "BTWB1|3|0000038db4700c3d087013882c27f0afbcc467f67aabf648289716e11439fb7c|310b1cbfa1b4759aa9d83cdae0aebfc002c52a1893cbbf7fd58ccb5184ca7d52|1787443380|": { nonce: 101278, hash: "000001bce77f5c5a0d0f2588e9949f778a4f1a5f5bb47c569a1856036db58a6d" },
  "BTWB1|4|000001bce77f5c5a0d0f2588e9949f778a4f1a5f5bb47c569a1856036db58a6d|762ff701143fc93acd1a0ccbb1043b43fde5191f659d4a69132e7281608a33e0|1787443440|": { nonce: 30549, hash: "0000003d40e8eb7b4b215e07b5d3c7b5ad7490a3bfca3fd59ee14988be2f2ec6" },
  "BTWB1|5|0000003d40e8eb7b4b215e07b5d3c7b5ad7490a3bfca3fd59ee14988be2f2ec6|599518f179ae3842a04ad01261b65e7987cfbb650ede9324ff465be3b6a2fb34|1787443500|": { nonce: 1650110, hash: "00000342632e7fb204a2dc803a451d6793b888e93befcdc4bbbf90a2675aa437" },
  "BTWB1|6|00000342632e7fb204a2dc803a451d6793b888e93befcdc4bbbf90a2675aa437|0fdd0afd0e9f61c13930ef4c4e1b7b65ff2797b3fab747576de2e23bf1267f2e|1787443560|": { nonce: 5354501, hash: "00000048541d6f9e4d22ad3f72f4decf1b6fdc0da544a17a6bd92196b17d2d2c" },
  "BTWB1|7|00000048541d6f9e4d22ad3f72f4decf1b6fdc0da544a17a6bd92196b17d2d2c|ae8e6dff88a16fcacfabf92ff10b3b5d66ed0644897dd09933cbba266ae385ac|1787443620|": { nonce: 3785625, hash: "000001933f95ce06645e73c5d936c542b851a1c5be7b15368a3db54c43ae6b3f" },
  "BTWB1|8|000001933f95ce06645e73c5d936c542b851a1c5be7b15368a3db54c43ae6b3f|e5c982d6c314124e02f2829760bd1e16ea559671006d4fc71618b4e1e734d972|1787443680|": { nonce: 1930711, hash: "000001ba46d522b8e4813ae15dbfe6a962389200f06566a587320410ffdccb22" },
  "BTWB1|9|000001ba46d522b8e4813ae15dbfe6a962389200f06566a587320410ffdccb22|02c01e26149ce8166885ec2813326532204d803cb1067c77f46a6ec305e8dd89|1787443740|": { nonce: 396790, hash: "000000e7296269900786b687bfebbf2da6bda5bdeae313ddf0b3958eae373faf" },
  "BTWB1|10|000000e7296269900786b687bfebbf2da6bda5bdeae313ddf0b3958eae373faf|12e2e5343274afaef4751c1a386d858680b8d1e2cbc96bbbf02c62b2bf885e3f|1787443800|": { nonce: 3713135, hash: "000000e384f64b51890905ceb92fa9620ee5cf874ebff22b3e19b60b067e7e7c" },
  "BTWB1|11|000000e384f64b51890905ceb92fa9620ee5cf874ebff22b3e19b60b067e7e7c|4b50cb158100e09155a010c35b3bc17e6884ec9da407ec4c7c0d4fb4a807cce9|1787443860|": { nonce: 2755746, hash: "000002472e5f70c13c8383b580db606750541e81c2a144cb76ab1fad0398dc15" },
  "BTWB1|12|000002472e5f70c13c8383b580db606750541e81c2a144cb76ab1fad0398dc15|4afcdff419e71aafa4504e1235e0816bf31155a73067a27656d858c3af96382e|1787443920|": { nonce: 6449241, hash: "000001962f2232102c229187904a0910fd2e678210a35bc17b61a44a962d3491" },
  "BTWB1|13|000001962f2232102c229187904a0910fd2e678210a35bc17b61a44a962d3491|ba24d91d719f9efa32c17325dd45f787d5a251ae67a9a1e7236bed3996c01d02|1787443980|": { nonce: 5741141, hash: "000002a5a963820afab7d127624e3e9670ce8877c8415fc331a2aeb31fb86e27" },
  "BTWB1|14|000002a5a963820afab7d127624e3e9670ce8877c8415fc331a2aeb31fb86e27|eeee17cc913915b886dfe1dbee80352581c16270fc3ac6e6b9d7147c721e860a|1787444040|": { nonce: 9400995, hash: "0000033cfb2a8a89e6a1b286e205cfec509f6bab5e4de13e15d2320c8688ad6a" },
  "BTWB1|15|0000033cfb2a8a89e6a1b286e205cfec509f6bab5e4de13e15d2320c8688ad6a|90fed1648cfea4782ae556f54d6a2f54e14164002e4b21de410b825fd4818053|1787444100|": { nonce: 3340619, hash: "00000183ba85007ca7d5292c56914563d47c92f40ee6e0d891d6f4fb09881e85" },
  "BTWB1|16|00000183ba85007ca7d5292c56914563d47c92f40ee6e0d891d6f4fb09881e85|ed65193f06d98f211670fe865f453aa63e75a13227d209c75166d6aee3d090a0|1787444160|": { nonce: 725101, hash: "00000179000159ed1fa51046f6795bef3bd71ad69790c3f8094a687a56737353" },
  "BTWB1|17|00000179000159ed1fa51046f6795bef3bd71ad69790c3f8094a687a56737353|a6967fc6226acbd8e947418482724af56f7781dee143b8af5945ba7d4be6e687|1787444220|": { nonce: 2445015, hash: "000002722deddcef3f31cba28546e1f7e74513e4f52265c83ed4184decf5bfa0" },
  "BTWB1|18|000002722deddcef3f31cba28546e1f7e74513e4f52265c83ed4184decf5bfa0|85c7825a2e28cc2796e4566489c726a406669a031efefbee3c47f972f75a95d1|1787444280|": { nonce: 1093456, hash: "000001684c2dd127c0bddb5ea5ee721358a9d5e3ae50fcbe748d8c7e18a95d9b" },
  "BTWB1|19|000001684c2dd127c0bddb5ea5ee721358a9d5e3ae50fcbe748d8c7e18a95d9b|eab315cfadc4f878cc8967d14edb3a29dc01af4bfc8965d5861a804c16b0b8e3|1787444340|": { nonce: 8485628, hash: "0000022306db383296ae08099a93116d5c3b274c48bb6cf7702b7e3956795d4d" },
  "BTWB1|20|0000022306db383296ae08099a93116d5c3b274c48bb6cf7702b7e3956795d4d|e1ae61d781d011fb3ce68b6fdde584fd3fc12349c89ea5cf93a176125c8aeeb0|1787444400|": { nonce: 2117511, hash: "000001d0b206b70668931651721fbf315854ef3200f4be41f175dd25af2601ae" },
  "BTWB1|21|000001d0b206b70668931651721fbf315854ef3200f4be41f175dd25af2601ae|de3c887b50aa0f1101efae8f05074b4ba5607948cb86d7c4fa164c3906b1aa79|1787444460|": { nonce: 1951922, hash: "0000029de25b83a3b1949b5a1de1c5386cb0541cd03012b92fa7b71e732c5b76" },
  "BTWB1|22|0000029de25b83a3b1949b5a1de1c5386cb0541cd03012b92fa7b71e732c5b76|e3b1fd6f20cad33fa2104532892a2338e044f0a867e04552037c454654dd68c8|1787444520|": { nonce: 4788883, hash: "0000004025748b3a53db80d2d0d3cee8485efefacfab781cac7b06a0d3e0bc01" },
  "BTWB1|23|0000004025748b3a53db80d2d0d3cee8485efefacfab781cac7b06a0d3e0bc01|dda50ac006364395962a7d76617ffa7d478df7b8b50e70ce1490eeb17ce72831|1787444580|": { nonce: 934370, hash: "0000012a7b3fce265a14c3f938082dc78d74dc2e4ae8874f0bb51ea05b00b318" },
  "BTWB1|24|0000012a7b3fce265a14c3f938082dc78d74dc2e4ae8874f0bb51ea05b00b318|83c8a7e5a3539cc7d652763fe78d8764f3e757bc0b62b0a2d3880267c6b9d0c2|1787444640|": { nonce: 1410500, hash: "00000271e82b61dba49a618edac4e35f2c60bb9315c73c73c8de0aab88acfc5a" },
  "BTWB1|25|00000271e82b61dba49a618edac4e35f2c60bb9315c73c73c8de0aab88acfc5a|4aa50d6079e999da8d47f2b7e65e1b9bb056ac2a7d70b0802b9c9f33c9e94ef3|1787444700|": { nonce: 8330904, hash: "00000130907288253bfab7aa1face5fad5f3cbbfa1a111360881a2b37f71b754" },
  "BTWB1|26|00000130907288253bfab7aa1face5fad5f3cbbfa1a111360881a2b37f71b754|9a29549a263a368828b41bd40cf5ee41648ad70fd1ef015845ffd43d6f113e60|1787444760|": { nonce: 897054, hash: "000001886779d22f675f2b0fdbfe2d1e6e7ddc4b5b16b235f496af5bd8fb55ce" },
  "BTWB1|27|000001886779d22f675f2b0fdbfe2d1e6e7ddc4b5b16b235f496af5bd8fb55ce|c8c9819d8b9c4eb5d8100420cda40ff63cace0cc2eacd63f462ea08c1b6d7a93|1787444820|": { nonce: 9639722, hash: "000000eb2076353c985aa6873100a8011b726b2a124857dd1f9ce57b124a191e" },
  "BTWB1|28|000000eb2076353c985aa6873100a8011b726b2a124857dd1f9ce57b124a191e|aaf8b1ce74273006de1ad3605f814513653b1aafdb8a42ae7085b440f3848033|1787444880|": { nonce: 399705, hash: "000000f2c5da2b04313dcbbb7f3d1e68c788fa4a74862e455dd046ea06602f3e" },
  "BTWB1|29|000000f2c5da2b04313dcbbb7f3d1e68c788fa4a74862e455dd046ea06602f3e|35ca4497bb712d4e83d59a3d596c4f248fd64decc965dd42f03e646215311434|1787444940|": { nonce: 3902535, hash: "000000dfe1fc16a30f9b7649be8e5b747d69d72b81ec7054010d538fb797cc5f" },
  "BTWB1|30|000000dfe1fc16a30f9b7649be8e5b747d69d72b81ec7054010d538fb797cc5f|e1ba58d654ffb2532c83285571738976d03fbb6498740bc751a99944a2095199|1787445000|": { nonce: 1770044, hash: "0000010ef952fceace375f11bbe93d9010e39567138f4d356007fbe76654e912" },
  "BTWB1|31|0000010ef952fceace375f11bbe93d9010e39567138f4d356007fbe76654e912|fccfb3ad96ec950a1e8ed7fbdb97b2ba974fc7c25842b6f0e1d038480e77ed1a|1787445060|": { nonce: 7932059, hash: "0000001f22eaf57380b0222245deb83cd1414eefc0d4ab84768dfcc8098cb5a3" },
  "BTWB1|32|0000001f22eaf57380b0222245deb83cd1414eefc0d4ab84768dfcc8098cb5a3|d3d55c06592614cc73f81e975e1c94e9674bdecce14757002f3ca6be4d5362db|1787445120|": { nonce: 3527686, hash: "000000804b9f28d969cdd0a2637a889e844b76833d24bb932ed0e4654d350c6d" },
  "BTWB1|33|000000804b9f28d969cdd0a2637a889e844b76833d24bb932ed0e4654d350c6d|5458b4b899a9646c0686f826390b27afbe85245360890094d04c9bcb903a266c|1787445180|": { nonce: 1682486, hash: "00000043089651d74d4467d464e941c512797b0ad13ce35e0e4b0ee7ede935e2" },
  "BTWB1|34|00000043089651d74d4467d464e941c512797b0ad13ce35e0e4b0ee7ede935e2|1b900670d589a19c6b415b069b5df9c5bffae56a3187088b42a8a0e7ba1acf2f|1787445240|": { nonce: 7312809, hash: "0000021d97a6b260c83543f26d3fa0d8d64ad53339442529d427ef01b18a5947" },
  "BTWB1|35|0000021d97a6b260c83543f26d3fa0d8d64ad53339442529d427ef01b18a5947|a7268ed1f21efa631637e9b08413ea948d1b44656a8d1e0cc637d3a4fd088869|1787445300|": { nonce: 21402299, hash: "000000a29155fbf8ccc9ac4305ce78512b7753a267ed7e72ba06c378d180b7ad" },
  "BTWB1|36|000000a29155fbf8ccc9ac4305ce78512b7753a267ed7e72ba06c378d180b7ad|e814e28251abd65354dd1a703c626110521afbe1ac4fdf9768e239733257526c|1787445360|": { nonce: 1469054, hash: "00000016e55520de49eddcc5bf9d815643e2e7e066f7a918a39cb0d73267bc73" },

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

async function mineOne(): Promise<{ height: number; hash: string }> {
  const tpl = await buildTemplate(w1.address);
  // 60s block spacing: the 8-block retarget sees ideal pace and difficulty
  // stays at 1 forever - minTimestamp spacing would clamp 4x harder every
  // 8 blocks and make the long narrative ungrindable.
  const ts = Math.max(tpl.minTimestamp, GENESIS_TIMESTAMP + tpl.height * TARGET_BLOCK_TIME);
  const { nonce } = powSearch(
    `BTWB1|${tpl.height}|${tpl.prevHash}|${tpl.merkleRoot}|${ts}|`,
    tpl.target,
  );
  const r = await submitBlock(tpl.templateId, ts, nonce);
  return { height: r.height, hash: r.hash };
}

let storage: MemoryStorage;
let tipHash35 = "";
let supply35 = 0;
let balance35 = 0;

beforeAll(async () => {
  storage = new MemoryStorage();
  await initChain(storage);
  for (let h = 1; h <= PRUNE_NARRATIVE_BLOCKS; h++) {
    const r = await mineOne();
    if (h === PRUNE_NARRATIVE_BLOCKS) tipHash35 = r.hash;
  }
  const i = await getInfo();
  supply35 = i.totalSupply;
  balance35 = (await getAddressOverview(w1.address)).balance;
}, 900_000);

describe("pruneConfirmedTxsBelow", () => {
  it("refuses a horizon inside the reorg window", async () => {
    // tip 35 - MAX_REORG_DEPTH 32 => deepest legal horizon is 3
    await expect(pruneConfirmedTxsBelow(4)).rejects.toThrow(ChainValidationError);
    await expect(pruneConfirmedTxsBelow(35)).rejects.toThrow(ChainValidationError);
  });

  it("prunes below the legal horizon: txs gone, headers stay, state exact", async () => {
    const removed = await pruneConfirmedTxsBelow(3);
    expect(removed).toBeGreaterThan(0);

    // historical txs are gone - those heights can no longer be SERVED
    expect(await getWireBlock(1)).toBeNull();
    expect(await getWireBlock(2)).toBeNull();
    // ...but their HEADERS remain (the chain of proof is unbroken)
    expect((await storage.blockAt(2))?.height).toBe(2);
    // heights at/above the horizon still serve in full
    expect((await getWireBlock(3))?.height).toBe(3);
    expect((await getWireBlock(PRUNE_NARRATIVE_BLOCKS))?.hash).toBe(tipHash35);

    // tip, supply and balances are untouched by the prune
    const i = await getInfo();
    expect(i.height).toBe(PRUNE_NARRATIVE_BLOCKS);
    expect(i.tipHash).toBe(tipHash35);
    expect(i.totalSupply).toBe(supply35);
    expect((await getAddressOverview(w1.address)).balance).toBe(balance35);
  });

  it("a pruned node cannot export a full chain - it says so loudly", async () => {
    await expect(exportChain()).rejects.toThrow(/pruned/);
  });

  it("the pruned node keeps mining and validating", async () => {
    const r = await mineOne(); // block 36 on pruned storage
    expect(r.height).toBe(PRUNE_NARRATIVE_BLOCKS + 1);
    const i = await getInfo();
    expect(i.height).toBe(PRUNE_NARRATIVE_BLOCKS + 1);
  }, 120_000);
});
