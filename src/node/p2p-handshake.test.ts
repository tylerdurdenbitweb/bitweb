/**
 * Handshake race regression tests - the duplicate-dial and early-data races
 * that used to earn HONEST peers spurious strikes at boot.
 *
 * A scripted FakeTransport gives exact control over link events and wire
 * frames: onOpen can be fired twice (the mutual-dial conn swap), data can
 * be pushed before the sybil gate opens, and frames can be re-delivered
 * the way racing parallel conns deliver them. The engine runs on a real
 * chain (MemoryStorage, genesis sealed) via the standard private boot.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { SYBIL_CHALLENGE_PREFIX } from "@contracts/wire";
import type { Transport, TransportEvents } from "./transport";

// Every boot here runs on an active (fake) transport with no peers, so the
// real boot sync-decision window (6s) elapses before each test body starts.
vi.setConfig({ testTimeout: 30_000 });

type Frame = Record<string, unknown> & { type?: string };

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

async function until(fn: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fn()) return;
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function bootWithFake() {
  vi.resetModules();
  const client = await import("./client");
  const { MemoryStorage } = await import("./storage");
  const fake = new FakeTransport();
  const node = await client.bootNode({
    storage: new MemoryStorage(),
    transports: [fake as Transport],
  });
  return { node, fake };
}

/** Mirror the engine's own hello back at it (valid by construction). */
function mirrorHello(fake: FakeTransport, peerId: string): Record<string, unknown> {
  const helloFrame = fake.framesTo(peerId, "hello").at(-1);
  if (!helloFrame) throw new Error("engine sent no hello to mirror");
  return (helloFrame.msg as unknown as { hello: Record<string, unknown> }).hello;
}

/** Drive a full honest handshake from the peer side. */
async function completeHandshake(fake: FakeTransport, peerId: string): Promise<void> {
  const { solveSybilChallenge } = await import("./blockchain");
  fake.rx(peerId, { type: "hello", hello: mirrorHello(fake, peerId) });
  await until(() => fake.framesTo(peerId, "challenge").length > 0);
  const challenge = fake.framesTo(peerId, "challenge").at(-1)!.msg as unknown as { nonce: string };
  const solution = solveSybilChallenge(challenge.nonce, SYBIL_CHALLENGE_PREFIX);
  if (solution === null) throw new Error("solver found nothing");
  fake.rx(peerId, { type: "challengeResponse", nonce: challenge.nonce, solution });
}

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
});

describe("duplicate-dial race (mutual dial swaps the conn mid-handshake)", () => {
  it("duplicate onOpen resets nothing - and re-offers the hello on the survivor conn", async () => {
    const { node, fake } = await bootWithFake();
    cleanup.push(() => node.stop());

    fake.open("peer-a");
    fake.open("peer-a"); // the conn swap: transport fires onOpen again
    fake.open("peer-a");
    // The loser conn may have eaten our first hello, so each duplicate open
    // re-offers it on the survivor (the receiver's helloSent guard dedupes).
    // Never more than one per open - and never a fresh challenge.
    await until(() => fake.framesTo("peer-a", "hello").length === 3);

    // and the full handshake still completes with ZERO strikes
    await completeHandshake(fake, "peer-a");
    await until(() => node.peers().length === 1);
    await until(() => fake.framesTo("peer-a", "challenge").length === 1);
    expect(node.peers()[0].strikes).toBe(0);
  });
});

describe("early-data race (peer talks right after verifying us)", () => {
  it("pre-verification data is buffered, not struck, and processed once the gate opens", async () => {
    const { node, fake } = await bootWithFake();
    cleanup.push(() => node.stop());

    fake.open("peer-b");
    await until(() => fake.framesTo("peer-b", "hello").length === 1);
    fake.rx("peer-b", { type: "hello", hello: mirrorHello(fake, "peer-b") });
    await until(() => fake.framesTo("peer-b", "challenge").length === 1);

    // The peer fires data at us BEFORE answering our challenge (they already
    // verified us on their side). A ping is the perfect probe: if it is
    // processed, we answer with a pong.
    fake.rx("peer-b", { type: "ping", t: 12345 });
    await new Promise((r) => setTimeout(r, 300));
    expect(fake.framesTo("peer-b", "pong")).toHaveLength(0); // gate still shut
    expect(node.peers()[0]?.strikes ?? 0).toBe(0); // and no strike earned

    // Answer the challenge -> the buffered ping must flush and get its pong.
    const { solveSybilChallenge } = await import("./blockchain");
    const challenge = fake.framesTo("peer-b", "challenge").at(-1)!.msg as unknown as { nonce: string };
    const solution = solveSybilChallenge(challenge.nonce, SYBIL_CHALLENGE_PREFIX)!;
    fake.rx("peer-b", { type: "challengeResponse", nonce: challenge.nonce, solution });
    await until(() => fake.framesTo("peer-b", "pong").length === 1);
    expect(node.peers()[0].strikes).toBe(0);
  });

  it("a pre-verification flood beyond the buffer cap is dropped silently - no ban, no work", async () => {
    const { node, fake } = await bootWithFake();
    cleanup.push(() => node.stop());

    fake.open("peer-c");
    await until(() => fake.framesTo("peer-c", "hello").length === 1);
    fake.rx("peer-c", { type: "hello", hello: mirrorHello(fake, "peer-c") });
    await until(() => fake.framesTo("peer-c", "challenge").length === 1);

    for (let i = 0; i < 100; i++) fake.rx("peer-c", { type: "ping", t: i });
    await new Promise((r) => setTimeout(r, 500));
    // no strikes, no drop, no pongs - the gate held without punishment
    expect(node.peers()[0]?.strikes ?? 0).toBe(0);
    expect(fake.closed).not.toContain("peer-c");
    expect(fake.framesTo("peer-c", "pong")).toHaveLength(0);

    // after verification only the buffered cap (16) flushes, never the flood
    const { solveSybilChallenge } = await import("./blockchain");
    const challenge = fake.framesTo("peer-c", "challenge").at(-1)!.msg as unknown as { nonce: string };
    const solution = solveSybilChallenge(challenge.nonce, SYBIL_CHALLENGE_PREFIX)!;
    fake.rx("peer-c", { type: "challengeResponse", nonce: challenge.nonce, solution });
    await until(() => fake.framesTo("peer-c", "pong").length === 16);
    await new Promise((r) => setTimeout(r, 300));
    expect(fake.framesTo("peer-c", "pong")).toHaveLength(16);
    expect(node.peers()[0].strikes).toBe(0);
  });
});

describe("the gate still has teeth", () => {
  it("unparseable garbage still earns a strike, even mid-handshake", async () => {
    const { node, fake } = await bootWithFake();
    cleanup.push(() => node.stop());

    fake.open("peer-d");
    await until(() => fake.framesTo("peer-d", "hello").length === 1);
    fake.rx("peer-d", "this is not a bitweb frame");
    await until(() => node.peers()[0]?.strikes === 1);
  });
});

describe("post-swap handshake integrity", () => {
  it("a duplicate open while our challenge is pending re-sends the SAME nonce, never a fresh one", async () => {
    const { node, fake } = await bootWithFake();
    cleanup.push(() => node.stop());

    fake.open("peer-e");
    await until(() => fake.framesTo("peer-e", "hello").length >= 1);
    fake.rx("peer-e", { type: "hello", hello: mirrorHello(fake, "peer-e") });
    await until(() => fake.framesTo("peer-e", "challenge").length === 1);
    const first = fake.framesTo("peer-e", "challenge")[0].msg as unknown as { nonce: string };

    fake.open("peer-e"); // survivor conn arrives while our challenge is pending
    await until(() => fake.framesTo("peer-e", "challenge").length === 2);
    const second = fake.framesTo("peer-e", "challenge")[1].msg as unknown as { nonce: string };
    expect(second.nonce).toBe(first.nonce); // the single-use nonce, re-offered

    // the peer's answer still verifies cleanly - no strike on either copy
    const { solveSybilChallenge } = await import("./blockchain");
    const solution = solveSybilChallenge(first.nonce, SYBIL_CHALLENGE_PREFIX)!;
    fake.rx("peer-e", { type: "challengeResponse", nonce: first.nonce, solution });
    await until(() => node.peers().length === 1);
    expect(node.peers()[0].strikes).toBe(0);
  });

  it("the same challenge nonce is answered at most once - wire duplicates are ignored", async () => {
    const { node, fake } = await bootWithFake();
    cleanup.push(() => node.stop());

    fake.open("peer-f");
    await until(() => fake.framesTo("peer-f", "hello").length >= 1);
    const challengeFrame = { type: "challenge", nonce: "abcdef0123456789" };
    fake.rx("peer-f", challengeFrame);
    fake.rx("peer-f", challengeFrame); // parallel-conn duplicate delivery
    fake.rx("peer-f", { type: "challenge", nonce: "0123456789abcdef" }); // a NEW nonce
    await until(() => fake.framesTo("peer-f", "challengeResponse").length === 2);
    const nonces = fake
      .framesTo("peer-f", "challengeResponse")
      .map((f) => (f.msg as unknown as { nonce: string }).nonce);
    expect(nonces.sort()).toEqual(["0123456789abcdef", "abcdef0123456789"]);
    expect(node.peers()[0]?.strikes ?? 0).toBe(0);
  });

  it("a challengeResponse arriving after verification is ignored, never struck", async () => {
    const { node, fake } = await bootWithFake();
    cleanup.push(() => node.stop());

    fake.open("peer-g");
    await until(() => fake.framesTo("peer-g", "hello").length >= 1);
    await completeHandshake(fake, "peer-g");
    await until(() => node.peers().length === 1);

    // the racing parallel conn flushes the same answer a second time...
    const { solveSybilChallenge } = await import("./blockchain");
    const challenge = fake.framesTo("peer-g", "challenge").at(-1)!.msg as unknown as { nonce: string };
    const solution = solveSybilChallenge(challenge.nonce, SYBIL_CHALLENGE_PREFIX)!;
    fake.rx("peer-g", { type: "challengeResponse", nonce: challenge.nonce, solution });
    // ...or a foreign one we never issued - both are meaningless post-gate
    fake.rx("peer-g", { type: "challengeResponse", nonce: "ffffffffffffffff", solution: "1" });
    await new Promise((r) => setTimeout(r, 400));
    expect(node.peers()[0].strikes).toBe(0);
    expect(fake.closed).not.toContain("peer-g");
  });

  it("an unsolicited challengeResponse before any challenge was issued still strikes", async () => {
    const { node, fake } = await bootWithFake();
    cleanup.push(() => node.stop());

    fake.open("peer-h");
    await until(() => fake.framesTo("peer-h", "hello").length >= 1);
    fake.rx("peer-h", { type: "challengeResponse", nonce: "00".repeat(8), solution: "1" });
    await until(() => node.peers()[0]?.strikes === 1);
  });
});
