/**
 * Chain update gate - the passive-mode switch. Proves:
 *
 *   - ref-counted nesting: the gate releases only when the OUTERMOST
 *     operation finishes, and the first reason wins for the whole burst
 *   - releases are idempotent (double-call never over-decrements)
 *   - detail lines live only inside a burst and never leak past it
 *   - EVERY chain-mutating path holds the gate: file import (with live
 *     block progress), mined-block commit, fork rollback, history prune
 *   - failure paths release the gate (a rejected import leaves no residue)
 *   - balances are fully recomputed BEFORE the gate releases on import -
 *     "the coins arrive" before the system goes active again
 */
import { describe, expect, it, vi } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { COIN, hashMeetsTarget, splitBlockReward } from "@contracts/protocol";
import { walletFromPrivHex } from "@/lib/bitweb";
import { MemoryStorage } from "./storage";

const w1 = walletFromPrivHex("01".repeat(32))!;

// Deterministic PoW for a coinbase-only chain paying w1 (same preimages as
// import-safety.test.ts - searched once, baked forever).
const BAKED: Record<string, { nonce: number; hash: string }> = {
  "BTWB1|1|c56c7b1e6bd77fb1cce41b3cb76d05a54c3bfd719db2942066daddf3a52352c3|d62b9190107cb799394ff51e25c12ff58a23fa360f6b632805bd0f4268d6ecc8|1787443201|": { nonce: 175577, hash: "000000f11f737b8028d03070c7decc69e1cf199d3c532ea6cf27895396333a9c" },
  "BTWB1|2|000000f11f737b8028d03070c7decc69e1cf199d3c532ea6cf27895396333a9c|e77599e7f9dbb191ff935eaa383ebb388616bf785ce87173a73ed59bcf41ba27|1787443202|": { nonce: 8699338, hash: "0000018c8f7cb7fd26d55c2201def5173ef6bbc90a1518e090d25a126609de77" },
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

type GateModule = typeof import("./chain-gate");
type ChainModule = typeof import("./chain");

async function freshAll(): Promise<{ gate: GateModule; chain: ChainModule }> {
  vi.resetModules();
  const gate = await import("./chain-gate");
  const chain = await import("./chain");
  await chain.initChain(new MemoryStorage());
  return { gate, chain };
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

/** Records every gate emission for later assertions. */
function recorder(gate: GateModule) {
  const states: import("./chain-gate").ChainGateState[] = [];
  const unsub = gate.subscribeChainGate((s) => states.push(s));
  return { states, unsub };
}

describe("chain gate - the passive-mode switch", () => {
  it("begins inactive; a begin/end pair toggles it with a reason", async () => {
    const { gate } = await freshAll();
    expect(gate.isChainUpdating()).toBe(false);
    expect(gate.getChainGateState().reason).toBeNull();

    const done = gate.beginChainUpdate("testing");
    expect(gate.isChainUpdating()).toBe(true);
    const s = gate.getChainGateState();
    expect(s.reason).toBe("testing");
    expect(s.depth).toBe(1);
    expect(typeof s.startedAt).toBe("number");

    done();
    expect(gate.isChainUpdating()).toBe(false);
    expect(gate.getChainGateState().reason).toBeNull();
    expect(gate.getChainGateState().startedAt).toBeNull();
  });

  it("nested operations: first reason wins, releases only at depth zero", async () => {
    const { gate } = await freshAll();
    const outer = gate.beginChainUpdate("outer op");
    const inner = gate.beginChainUpdate("inner op");
    expect(gate.getChainGateState().depth).toBe(2);
    expect(gate.getChainGateState().reason).toBe("outer op");

    inner();
    expect(gate.isChainUpdating()).toBe(true); // outer still holds it
    expect(gate.getChainGateState().reason).toBe("outer op");
    outer();
    expect(gate.isChainUpdating()).toBe(false);
  });

  it("a release is idempotent - double-calling never over-decrements", async () => {
    const { gate } = await freshAll();
    const a = gate.beginChainUpdate("a");
    const b = gate.beginChainUpdate("b");
    a();
    a(); // must NOT release b's hold
    expect(gate.isChainUpdating()).toBe(true);
    expect(gate.getChainGateState().depth).toBe(1);
    b();
    expect(gate.isChainUpdating()).toBe(false);
  });

  it("detail lines live inside a burst and are ignored outside it", async () => {
    const { gate } = await freshAll();
    gate.setChainGateDetail("noise"); // no burst - dropped
    expect(gate.getChainGateState().detail).toBeNull();

    const done = gate.beginChainUpdate("op");
    gate.setChainGateDetail("applying block 3/3");
    expect(gate.getChainGateState().detail).toBe("applying block 3/3");
    done();
    expect(gate.getChainGateState().detail).toBeNull(); // no leak
  });

  it("structured progress: lives inside a burst, clamps, clears on release", async () => {
    const { gate } = await freshAll();
    gate.setChainGateProgress(3, 10); // no burst - dropped
    expect(gate.getChainGateState().progress).toBeNull();

    const done = gate.beginChainUpdate("op");
    gate.setChainGateProgress(3, 10);
    expect(gate.getChainGateState().progress).toEqual({ current: 3, total: 10 });
    // out-of-range values clamp into the bar, garbage becomes indeterminate
    gate.setChainGateProgress(99, 10);
    expect(gate.getChainGateState().progress).toEqual({ current: 10, total: 10 });
    gate.setChainGateProgress(Number.NaN, 10);
    expect(gate.getChainGateState().progress).toBeNull();
    gate.setChainGateProgress(5, 10);
    gate.clearChainGateProgress();
    expect(gate.getChainGateState().progress).toBeNull();
    gate.setChainGateProgress(7, 10);
    done();
    expect(gate.getChainGateState().progress).toBeNull(); // no leak past the burst
  });

  it("a nested burst starts clean: progress from a finished burst never bleeds in", async () => {
    const { gate } = await freshAll();
    const done1 = gate.beginChainUpdate("first");
    gate.setChainGateProgress(8, 10);
    done1();
    const done2 = gate.beginChainUpdate("second");
    expect(gate.getChainGateState().progress).toBeNull();
    expect(gate.getChainGateState().detail).toBeNull();
    done2();
  });

  it("subscribers see every emission as a fresh snapshot; unsubscribe silences", async () => {
    const { gate } = await freshAll();
    const { states, unsub } = recorder(gate);
    const done = gate.beginChainUpdate("op");
    gate.setChainGateDetail("half");
    done();
    unsub();
    gate.beginChainUpdate("later")();

    // begin + detail + end = 3 emissions, none from after unsub
    expect(states.length).toBe(3);
    expect(states[0]).toMatchObject({ active: true, depth: 1, reason: "op" });
    expect(states[1]).toMatchObject({ active: true, detail: "half" });
    expect(states[2]).toMatchObject({ active: false, depth: 0, reason: null });
    expect(new Set(states).size).toBe(3); // each emission its own object
  });

  it("resetChainGate drops a stuck burst and announces it", async () => {
    const { gate } = await freshAll();
    const { states } = recorder(gate);
    gate.beginChainUpdate("stuck");
    gate.resetChainGate();
    expect(gate.isChainUpdating()).toBe(false);
    expect(states.at(-1)).toMatchObject({ active: false, depth: 0 });
  });
});

describe("chain gate - every mutation path holds it", () => {
  it("IMPORT: gate active with live progress, releases only after balances settle", async () => {
    const src = (await freshAll()).chain;
    for (let h = 1; h <= 3; h++) await mineOne(src);
    const file = JSON.parse(JSON.stringify(await src.exportChain())) as unknown;

    const { gate, chain: dst } = await freshAll();
    const { states } = recorder(gate);
    expect(gate.isChainUpdating()).toBe(false);

    const res = await dst.importChain(file);
    expect(res).toEqual({ height: 3, applied: true });

    // gate fully released after the import resolves - no residue
    expect(gate.isChainUpdating()).toBe(false);
    expect(gate.getChainGateState().depth).toBe(0);

    // the burst carried the import reason and live block progress
    const active = states.filter((s) => s.active);
    expect(active.length).toBeGreaterThan(0);
    expect(active.every((s) => s.reason === "importing a chain file")).toBe(true);
    expect(active.some((s) => s.detail === "validating file")).toBe(true);
    expect(active.some((s) => s.detail === "applying block 3/3")).toBe(true);

    // the coins arrived BEFORE the gate released: full balance is visible now
    const expected = 3 * splitBlockReward(1, 0).miner; // 3 x 350 BTWB
    expect(expected).toBe(1050 * COIN);
    const view = await dst.getAddressOverview(w1.address);
    expect(view.balance).toBe(expected);
    expect((await dst.getInfo()).totalSupply).toBe(expected);
  }, 300_000);

  it("IMPORT FAILURE: a rejected file releases the gate completely", async () => {
    const { gate, chain } = await freshAll();
    const { states } = recorder(gate);
    await expect(chain.importChain({ chainId: "definitely-not-bitweb" })).rejects.toThrow();
    expect(gate.isChainUpdating()).toBe(false);
    expect(gate.getChainGateState().depth).toBe(0);
    expect(states.at(-1)).toMatchObject({ active: false });
  });

  it("MINED-BLOCK COMMIT: submitBlock brackets its apply with the gate", async () => {
    const { gate, chain } = await freshAll();
    const { states } = recorder(gate);
    await mineOne(chain);
    const commits = states.filter((s) => s.reason === "committing your mined block");
    expect(commits.some((s) => s.active)).toBe(true);
    expect(gate.isChainUpdating()).toBe(false); // released after the apply
  }, 300_000);

  it("ROLLBACK: rolling back to the fork point is gated", async () => {
    const { gate, chain } = await freshAll();
    await mineOne(chain);
    await mineOne(chain);
    const { states } = recorder(gate);
    await chain.rollbackToHeight(1);
    expect(states.some((s) => s.active && s.reason === "rolling back to the fork point")).toBe(true);
    expect(gate.isChainUpdating()).toBe(false);
    expect((await chain.getTipSummary()).height).toBe(1);
  }, 300_000);

  it("PRUNE: history pruning is gated", async () => {
    const { gate, chain } = await freshAll();
    await mineOne(chain); // height 1 - too young to prune; still gated
    const { states } = recorder(gate);
    await chain.pruneConfirmedTxsBelow(0).catch(() => -1);
    expect(states.some((s) => s.active && s.reason === "pruning old history")).toBe(true);
    expect(gate.isChainUpdating()).toBe(false);
  }, 300_000);

  it("NESTED REAL PATH: an outer burst around importChain keeps one reason", async () => {
    const src = (await freshAll()).chain;
    await mineOne(src);
    const file = JSON.parse(JSON.stringify(await src.exportChain())) as unknown;

    const { gate, chain: dst } = await freshAll();
    const { states } = recorder(gate);
    // mirrors Terminal.doImport: the UI holds the gate around the whole flow
    const outer = gate.beginChainUpdate("importing a chain file");
    await dst.importChain(file);
    // importChain released its OWN hold, but the outer one still pins the gate
    expect(gate.isChainUpdating()).toBe(true);
    const statesBeforeRelease = states.slice(); // the release itself comes next
    outer();
    expect(gate.isChainUpdating()).toBe(false);
    // one continuous burst: no flicker to inactive BEFORE the final release
    expect(statesBeforeRelease.some((s) => !s.active)).toBe(false);
    expect(states.at(-1)).toMatchObject({ active: false });
    expect(statesBeforeRelease.every((s) => s.reason === "importing a chain file")).toBe(true);
  }, 300_000);
});
