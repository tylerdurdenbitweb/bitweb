/**
 * Pre-flight mining hold ("UPDATING - preparing to mine") - the user's
 * second hard rule: mining never starts into a chain that might still be
 * moving. Tested pure against the real chain gate (no React, no workers):
 *
 *   1. refuses WITHOUT nesting when an update is already in flight
 *   2. holds the gate with the right reason/detail for the whole prep and
 *      releases exactly once on success
 *   3. aborts when a real update lands mid-settle (depth stacks) - and the
 *      foreign hold survives our release (no stolen unlock)
 *   4. a template failure reports "template" and still releases the gate
 */
import { describe, expect, it, vi } from "vitest";

type GateModule = typeof import("@/node/chain-gate");

async function rig() {
  vi.resetModules();
  const gate: GateModule = await import("@/node/chain-gate");
  const lib = await import("./mining-gate");
  return { gate, prep: lib.prepareMiningStart, SETTLE: lib.MINING_PREP_SETTLE_MS };
}

describe("prepareMiningStart", () => {
  it("refuses without nesting when an update is already in flight", async () => {
    const { gate, prep } = await rig();
    const foreign = gate.beginChainUpdate("syncing with a peer");
    const before = gate.getChainGateState().depth;
    const r = await prep(() => Promise.resolve());
    expect(r).toEqual({ ok: false, reason: "updating" });
    expect(gate.getChainGateState().depth).toBe(before); // we never nested
    foreign();
    expect(gate.isChainUpdating()).toBe(false);
  });

  it("holds 'preparing to mine' for the whole prep, releases once on success", async () => {
    const { gate, prep } = await rig();
    const seen: Array<{ active: boolean; reason: string | null; detail: string | null }> = [];
    const unsub = gate.subscribeChainGate((s) =>
      seen.push({ active: s.active, reason: s.reason, detail: s.detail }),
    );
    let templated = 0;
    const r = await prep(() => {
      templated += 1;
      return Promise.resolve({ height: 7 });
    });
    unsub();
    expect(r).toEqual({ ok: true });
    expect(templated).toBe(1);
    // every ACTIVE state during prep carries our reason, with both details
    const actives = seen.filter((s) => s.active);
    expect(actives.length).toBeGreaterThan(0);
    for (const a of actives) expect(a.reason).toBe("preparing to mine");
    expect(actives.some((a) => a.detail === "settling the latest blocks")).toBe(true);
    expect(actives.some((a) => a.detail === "building your mining template")).toBe(true);
    // and the world is quiet afterwards - exactly one final inactive
    expect(seen.filter((s) => !s.active).length).toBe(1);
    expect(gate.isChainUpdating()).toBe(false);
  });

  it("aborts when a real update lands mid-settle - foreign hold survives", async () => {
    const { gate, prep, SETTLE } = await rig();
    let foreign: (() => void) | null = null;
    const p = prep(() => Promise.resolve());
    // land a foreign hold halfway through the settle window
    setTimeout(() => {
      foreign = gate.beginChainUpdate("new block from the network");
    }, Math.floor(SETTLE / 2));
    const r = await p;
    expect(r).toEqual({ ok: false, reason: "updating" });
    // our release must not steal the foreign hold: still updating, its reason
    expect(gate.isChainUpdating()).toBe(true);
    expect(gate.getChainGateState().depth).toBe(1);
    foreign!();
    expect(gate.isChainUpdating()).toBe(false);
  });

  it("template failure reports 'template' and the gate still releases", async () => {
    const { gate, prep } = await rig();
    const r = await prep(() => Promise.reject(new Error("boom")));
    expect(r).toEqual({ ok: false, reason: "template" });
    expect(gate.isChainUpdating()).toBe(false);
    expect(gate.getChainGateState().depth).toBe(0);
  });
});
