/**
 * Boot gate tests - the "site opens but the chain is still loading" bug.
 *
 * The complaint: on first load the UI became interactive right away, no
 * UPDATING overlay appeared, and mining could start before the node knew
 * whether the network had a longer chain. The fix holds a chain gate from
 * the first hydration step until the first sync decision (client.ts), so
 * the overlay is up and mining is refused during that whole window.
 *
 * These tests pin three things:
 *  1. a solo boot still passes through an observable "starting up" hold and
 *     releases it when boot resolves;
 *  2. with a live but quiet transport, the gate stays up for the whole
 *     sync-decision window ("checking for a longer chain") and then clears;
 *  3. when a fresh tab boots next to an ahead peer, the gate never blinks
 *     from boot start until the local tip has caught up - the handoff from
 *     the boot hold to the sync hold is seamless.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { hashMeetsTarget } from "@contracts/protocol";
import { walletFromPrivHex } from "@/lib/bitweb";
import { MemoryStorage } from "./storage";

const w1 = walletFromPrivHex("01".repeat(32))!;

interface GateEvent {
  active: boolean;
  reason: string | null;
  detail: string | null;
  at: number;
}

async function until(fn: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 100));
  }
}

const BAKED: Record<string, { nonce: number; hash: string }> = {
  // coinbase-only blocks #1 and #2 paying w1 - identical preimages to
  // p2p.test.ts (same miner, same parents, same minTimestamp spacing)
  "BTWB1|1|c56c7b1e6bd77fb1cce41b3cb76d05a54c3bfd719db2942066daddf3a52352c3|d62b9190107cb799394ff51e25c12ff58a23fa360f6b632805bd0f4268d6ecc8|1787443201|": { nonce: 175577, hash: "000000f11f737b8028d03070c7decc69e1cf199d3c532ea6cf27895396333a9c" },
  "BTWB1|2|000000f11f737b8028d03070c7decc69e1cf199d3c532ea6cf27895396333a9c|e77599e7f9dbb191ff935eaa383ebb388616bf785ce87173a73ed59bcf41ba27|1787443202|": { nonce: 8699338, hash: "0000018c8f7cb7fd26d55c2201def5173ef6bbc90a1518e090d25a126609de77" },
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

type Booted = Awaited<ReturnType<(typeof import("./client"))["bootNode"]>>;
const stoppers: Array<() => void> = [];
afterEach(() => {
  while (stoppers.length) stoppers.pop()!();
});

describe("boot gate", () => {
  it("a solo boot is gated as 'starting up' and releases cleanly", async () => {
    vi.resetModules();
    const gate = await import("./chain-gate");
    const events: GateEvent[] = [];
    gate.subscribeChainGate((s) => events.push({ active: s.active, reason: s.reason, detail: s.detail, at: Date.now() }));

    const client = await import("./client");
    const node = await client.bootNode({ storage: new MemoryStorage(), transports: [], webRtc: false });
    stoppers.push(node.stop);

    // the hold was observable from the outside, with the boot reason
    const first = events.find((e) => e.active);
    expect(first).toBeDefined();
    expect(first!.reason).toBe("starting up");

    // boot resolves only after the hold is gone: no update in flight now
    expect(gate.isChainUpdating()).toBe(false);
    const last = events[events.length - 1];
    expect(last.active).toBe(false);

    // exactly one burst: no flicker, no wedge
    const bursts = events.filter((e, i) => e.active && !events[i - 1]?.active);
    expect(bursts.length).toBe(1);

    const info = await node.info();
    expect(info.height).toBe(0);
  });

  it("a quiet network holds the gate for the decision window, then releases", async () => {
    vi.resetModules();
    const gate = await import("./chain-gate");
    const events: GateEvent[] = [];
    gate.subscribeChainGate((s) => events.push({ active: s.active, reason: s.reason, detail: s.detail, at: Date.now() }));

    const client = await import("./client");
    const { BroadcastTransport } = await import("./transport");
    // a live transport with nobody on the channel: the engine is up, so the
    // boot must wait out the decision window instead of skipping it
    const node = await client.bootNode({
      storage: new MemoryStorage(),
      transports: [new BroadcastTransport("tab-lonely", "btwb-test-lonely")],
      webRtc: false,
    });
    stoppers.push(node.stop);

    expect(node.engine.hasActiveTransports()).toBe(true);
    // the window really ran: the bridge detail was shown while waiting
    expect(events.some((e) => e.active && e.detail === "checking for a longer chain")).toBe(true);
    // ...and it took real time (the window is 6s; allow generous slack for CI)
    const first = events.find((e) => e.active)!;
    const last = events[events.length - 1];
    expect(last.active).toBe(false);
    expect(last.at - first.at).toBeGreaterThanOrEqual(5_000);
    expect(gate.isChainUpdating()).toBe(false);
  }, 30_000);

  it("a fresh tab catching up to an ahead peer never sees the gate blink", async () => {
    // tab A boots alone on the shared channel and mines two blocks
    vi.resetModules();
    const clientA = await import("./client");
    const { BroadcastTransport: BTA } = await import("./transport");
    const nodeA: Booted = await clientA.bootNode({
      storage: new MemoryStorage(),
      transports: [new BTA("tab-a", "btwb-test-gate")],
      webRtc: false,
    });
    stoppers.push(nodeA.stop);
    for (let i = 0; i < 2; i++) {
      const tpl = await nodeA.template(w1.address);
      const { nonce } = powSearch(
        `BTWB1|${tpl.height}|${tpl.prevHash}|${tpl.merkleRoot}|${tpl.minTimestamp}|`,
        tpl.target,
      );
      await nodeA.submitBlock(tpl.templateId, tpl.minTimestamp, nonce);
    }
    expect((await nodeA.info()).height).toBe(2);

    // tab B boots next to it - watch B's own gate from before bootNode runs
    vi.resetModules();
    const gateB = await import("./chain-gate");
    const events: GateEvent[] = [];
    gateB.subscribeChainGate((s) => events.push({ active: s.active, reason: s.reason, detail: s.detail, at: Date.now() }));
    const clientB = await import("./client");
    const { BroadcastTransport: BTB } = await import("./transport");
    const nodeB: Booted = await clientB.bootNode({
      storage: new MemoryStorage(),
      transports: [new BTB("tab-b", "btwb-test-gate")],
      webRtc: false,
    });
    stoppers.push(nodeB.stop);

    await until(async () => (await nodeB.info()).height === 2, 15_000);
    const caughtUpAt = Date.now();

    // the gate went up exactly once - boot hold -> sync hold with no gap
    const bursts = events.filter((e, i) => e.active && !events[i - 1]?.active);
    expect(bursts.length).toBe(1);
    expect(bursts[0].reason).toBe("starting up");

    // it only came down once B actually held the full chain (generous slack
    // for the 100ms poll above; the release itself is synchronous with the
    // last applied block)
    const downs = events.filter((e) => !e.active && e.at > bursts[0].at);
    expect(downs.length).toBe(1);
    expect(downs[0].at).toBeGreaterThan(caughtUpAt - 1_000);
    expect(gateB.isChainUpdating()).toBe(false);

    // identical tips on both tabs
    const [ia, ib] = await Promise.all([nodeA.info(), nodeB.info()]);
    expect(ib.tipHash).toBe(ia.tipHash);
  }, 60_000);
});
