/**
 * Catch-up sync resilience: a peer that goes QUIET mid-sync (mobile network
 * blip, broker reconnect, request timeout) used to end the gate burst on
 * the spot - the overlay vanished at 60% and the next attempt waited for a
 * full heartbeat, which on a phone reads exactly as "the update froze".
 * The burst now retries inside the SAME gate until real blocks flow.
 *
 * Setup: a donor graph mines two real blocks; the node under test runs in a
 * fresh module graph behind a scripted FakeTransport. The peer answers the
 * FIRST getBlocks round with silence (request timeout), the SECOND round
 * with the real wire blocks.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { SYBIL_CHALLENGE_PREFIX } from "@contracts/wire";
import { hashMeetsTarget } from "@contracts/protocol";
import { walletFromPrivHex } from "@/lib/bitweb";
import type { Transport, TransportEvents } from "./transport";

vi.setConfig({ testTimeout: 60_000 });

type Frame = Record<string, unknown> & { type?: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(fn: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fn()) return;
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await sleep(25);
  }
}

async function untilAsync(fn: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error("async condition not met in time");
    await sleep(25);
  }
}

class FakeTransport implements Transport {
  readonly kind = "fake";
  readonly selfId = "self-fake";
  private events: TransportEvents | null = null;
  sent: Array<{ to: string; msg: Frame }> = [];
  closed: string[] = [];

  start(events: TransportEvents): Promise<void> {
    this.events = events;
    return Promise.resolve();
  }
  stop(): void {}
  dial(): void {}
  send(peerId: string, data: string): void {
    this.sent.push({ to: peerId, msg: JSON.parse(data) });
  }
  close(peerId: string): void {
    this.closed.push(peerId);
  }
  links(): string[] {
    return [];
  }

  // -- test drivers -----------------------------------------------------------
  open(id: string): void {
    this.events?.onOpen(id);
  }
  rx(id: string, msg: unknown): void {
    this.events?.onMessage(id, JSON.stringify(msg));
  }
  framesTo(id: string, type: string) {
    return this.sent.filter((f) => f.to === id && f.msg.type === type);
  }
}

// -- deterministic PoW (same baked blocks as p2p.test.ts: w1 solo #1-#2) ----
const BAKED: Record<string, { nonce: number; hash: string }> = {
  // block #1 paying w1 - identical preimage to chain.test.ts (same miner, same parent)
  "BTWB1|1|c56c7b1e6bd77fb1cce41b3cb76d05a54c3bfd719db2942066daddf3a52352c3|d62b9190107cb799394ff51e25c12ff58a23fa360f6b632805bd0f4268d6ecc8|1787443201|": { nonce: 175577, hash: "000000f11f737b8028d03070c7decc69e1cf199d3c532ea6cf27895396333a9c" },
  // block #2 paying w1, coinbase only (the longest-chain regression in p2p.test.ts)
  "BTWB1|2|000000f11f737b8028d03070c7decc69e1cf199d3c532ea6cf27895396333a9c|e77599e7f9dbb191ff935eaa383ebb388616bf785ce87173a73ed59bcf41ba27|1787443202|": { nonce: 8699338, hash: "0000018c8f7cb7fd26d55c2201def5173ef6bbc90a1518e090d25a126609de77" },
};

function powSearch(prefixAscii: string, target: string): { nonce: number; hash: string } {
  const baked = BAKED[prefixAscii];
  if (baked) return baked;
  const bytes = new TextEncoder().encode(prefixAscii);
  for (let nonce = 0; nonce < 20_000_000; nonce++) {
    const nonceBytes = new TextEncoder().encode(String(nonce));
    const msg = new Uint8Array(bytes.length + nonceBytes.length);
    msg.set(bytes);
    msg.set(nonceBytes, bytes.length);
    const hash = bytesToHex(sha256(sha256(msg)));
    if (hashMeetsTarget(hash, target)) return { nonce, hash };
  }
  throw new Error("nonce space exhausted");
}

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
});

describe("catch-up sync resilience - quiet peers retried inside one gate", () => {
  it("silence on round one, real blocks on round two: one burst, closed at the peer tip", async () => {
    const w1 = walletFromPrivHex("01".repeat(32))!;

    // -- graph 1: the donor, two blocks ahead ------------------------------
    // No transports: the donor never talks - it only mints the chain we
    // later serve over the fake link (and skips the 6s boot sync window).
    vi.resetModules();
    const clientA = await import("./client");
    const chainA = await import("./chain");
    const { MemoryStorage: MemA } = await import("./storage");
    const donor = await clientA.bootNode({
      storage: new MemA(),
      transports: [],
    });
    for (let i = 0; i < 2; i++) {
      const tpl = await donor.template(w1.address);
      const { nonce } = powSearch(
        `BTWB1|${tpl.height}|${tpl.prevHash}|${tpl.merkleRoot}|${tpl.minTimestamp}|`,
        tpl.target,
      );
      await donor.submitBlock(tpl.templateId, tpl.minTimestamp, nonce);
    }
    const donorTip = (await donor.info()).tipHash;
    const wb1 = await chainA.getWireBlock(1);
    const wb2 = await chainA.getWireBlock(2);
    expect(wb1 && wb2).toBeTruthy();
    donor.stop();

    // -- graph 2: the node under test --------------------------------------
    vi.resetModules();
    const gate = await import("./chain-gate");
    const states: import("./chain-gate").ChainGateState[] = [];
    const unsub = gate.subscribeChainGate((s) => states.push(s));
    cleanup.push(unsub);

    const chainB = await import("./chain");
    const { MemoryStorage: MemB } = await import("./storage");
    await chainB.initChain(new MemB());
    const { P2pEngine } = await import("./p2p");
    const { solveSybilChallenge } = await import("./blockchain");

    const fake = new FakeTransport();
    const engine = new P2pEngine([fake], {
      challengeTimeoutMs: 60_000,
      syncRetryDelayMs: 10,
      requestTimeoutMs: 250, // the "silence" window
    });
    cleanup.push(() => engine.stop());
    await engine.start();

    // honest handshake, but the peer advertises the donor's tip
    fake.open("peer-a");
    await until(() => fake.framesTo("peer-a", "hello").length > 0);
    const ourHello = (fake.framesTo("peer-a", "hello").at(-1)!.msg as { hello: Record<string, unknown> }).hello;
    fake.rx("peer-a", {
      type: "hello",
      hello: { ...ourHello, height: 2, tipHash: donorTip },
    });
    await until(() => fake.framesTo("peer-a", "challenge").length > 0);
    const ch = fake.framesTo("peer-a", "challenge").at(-1)!.msg as unknown as { nonce: string };
    const solution = solveSybilChallenge(ch.nonce, SYBIL_CHALLENGE_PREFIX);
    expect(solution).not.toBeNull();
    fake.rx("peer-a", { type: "challengeResponse", nonce: ch.nonce, solution });

    // round one: the peer goes QUIET - the request times out (250 ms here)
    await until(() => fake.framesTo("peer-a", "getBlocks").length >= 1);
    // ...and the SAME gate burst asks again instead of dissolving
    await until(() => fake.framesTo("peer-a", "getBlocks").length >= 2);

    // round two: real blocks flow
    fake.rx("peer-a", { type: "blocks", blocks: [wb1, wb2] });
    await untilAsync(async () => (await chainB.getTipSummary()).hash === donorTip);

    // the whole recovery was ONE gate burst that closed exactly at the tip:
    // no close-at-60%-and-reopen flicker
    const firstActive = states.findIndex((s) => s.active);
    const lastActive = states.map((s) => s.active).lastIndexOf(true);
    expect(firstActive).toBeGreaterThanOrEqual(0);
    expect(states.slice(firstActive, lastActive + 1).every((s) => s.active)).toBe(true);
    expect(states.some((s) => s.active && s.detail?.startsWith("retrying"))).toBe(true);
    expect(gate.isChainUpdating()).toBe(false);
    expect((await chainB.getTipSummary()).hash).toBe(donorTip);
  });
});
