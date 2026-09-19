/**
 * Mining gate controller - the miner's pause/resume policy against chain
 * updates, tested pure (no React, no workers): the chain gate is real,
 * the miner is three spies. Covers the user's two hard rules:
 *
 *   1. mining can never be RUNNING through a chain update - the gate's
 *      first emission kills it in the same tick
 *   2. a miner that was parked by an update starts again when (and only
 *      when) the update fully releases
 */
import { describe, expect, it, vi } from "vitest";

type GateModule = typeof import("@/node/chain-gate");

interface Rig {
  gate: GateModule;
  pauses: number;
  resumes: number;
  mining: boolean;
  setMining: (v: boolean) => void;
  unsub: () => void;
}

async function rig(initiallyMining: boolean): Promise<Rig> {
  vi.resetModules();
  const gate = await import("@/node/chain-gate");
  const { wireMiningGate } = await import("./mining-gate");
  const box = { pauses: 0, resumes: 0, mining: initiallyMining };
  const unsub = wireMiningGate({
    isMining: () => box.mining,
    pause: () => {
      box.pauses += 1;
      box.mining = false; // a real pause kills the workers synchronously
    },
    resume: () => {
      box.resumes += 1;
      box.mining = true;
    },
  });
  return {
    gate,
    unsub,
    get pauses() {
      return box.pauses;
    },
    get resumes() {
      return box.resumes;
    },
    get mining() {
      return box.mining;
    },
    setMining: (v) => {
      box.mining = v;
    },
  };
}

describe("mining gate controller", () => {
  it("update begins while mining -> pause once; update ends -> resume once", async () => {
    const r = await rig(true);
    const done = r.gate.beginChainUpdate("importing a chain file");
    expect(r.pauses).toBe(1);
    expect(r.mining).toBe(false); // stopped the instant the update began
    done();
    expect(r.resumes).toBe(1);
    expect(r.mining).toBe(true); // and back on the fresh state
    r.unsub();
  });

  it("update while idle -> no pause, and crucially NO phantom resume after", async () => {
    const r = await rig(false);
    const done = r.gate.beginChainUpdate("syncing with a peer");
    expect(r.pauses).toBe(0);
    done();
    expect(r.resumes).toBe(0);
    expect(r.mining).toBe(false);
    r.unsub();
  });

  it("nested updates pause once and resume only at the outermost release", async () => {
    const r = await rig(true);
    const outer = r.gate.beginChainUpdate("importing a chain file");
    const inner = r.gate.beginChainUpdate("importing a chain file");
    expect(r.pauses).toBe(1);
    inner();
    expect(r.resumes).toBe(0); // still mid-burst
    outer();
    expect(r.resumes).toBe(1);
    r.unsub();
  });

  it("back-to-back updates each earn their own pause/resume pair", async () => {
    const r = await rig(true);
    r.gate.beginChainUpdate("new block from the network")();
    r.gate.beginChainUpdate("syncing with a peer")();
    expect(r.pauses).toBe(2);
    expect(r.resumes).toBe(2);
    expect(r.mining).toBe(true);
    r.unsub();
  });

  it("progress chatter mid-burst never retriggers pause/resume", async () => {
    const r = await rig(true);
    const done = r.gate.beginChainUpdate("importing a chain file");
    expect(r.pauses).toBe(1);
    for (let i = 1; i <= 5; i++) r.gate.setChainGateDetail(`applying block ${i}/5`);
    expect(r.pauses).toBe(1); // transitions only, not every emission
    expect(r.resumes).toBe(0);
    done();
    expect(r.resumes).toBe(1);
    r.unsub();
  });

  it("miner starting mid-update is not the gate's business - no pause, no resume", async () => {
    const r = await rig(false);
    const done = r.gate.beginChainUpdate("syncing with a peer");
    // the UI refuses start() during an update; if code ever flips the miner
    // on mid-burst anyway, the gate must not "adopt" it into owing a resume
    r.setMining(true);
    r.gate.setChainGateDetail("block #100");
    expect(r.pauses).toBe(0);
    done();
    expect(r.resumes).toBe(0);
    expect(r.mining).toBe(true); // untouched by the gate either way
    r.unsub();
  });

  it("unsubscribe detaches completely", async () => {
    const r = await rig(true);
    r.unsub();
    r.gate.beginChainUpdate("importing a chain file")();
    expect(r.pauses).toBe(0);
    expect(r.resumes).toBe(0);
  });
});
