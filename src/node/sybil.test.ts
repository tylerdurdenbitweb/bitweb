/**
 * Sybil-gate integration: a scripted fake peer over a stub transport proves
 * the handshake challenge actually gates data flow - silent peers are
 * dropped at the deadline (no strike: slow is not evil), data-before-
 * verification is buffered until the gate opens (timing is not malice),
 * and a wrong solution earns a strike.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHAIN_ID, NODE_AGENT, P2P_VERSION, encodeMessage } from "@contracts/wire";

interface StubLink {
  id: string;
  sent: string[];
}

/** A Transport whose links the test scripts by hand. */
class StubTransport {
  readonly kind = "stub";
  readonly selfId = "stub-self";
  links_: StubLink[] = [];
  closed: string[] = [];
  private events!: import("./transport").TransportEvents;

  start(events: import("./transport").TransportEvents): Promise<void> {
    this.events = events;
    return Promise.resolve();
  }
  stop(): void {}
  dial(): void {}
  send(peerId: string, data: string): void {
    this.links_.find((l) => l.id === peerId)?.sent.push(data);
  }
  close(peerId: string): void {
    this.closed.push(peerId);
    this.links_ = this.links_.filter((l) => l.id !== peerId);
  }
  links(): string[] {
    return this.links_.map((l) => l.id);
  }

  // -- test-side scripting --
  connect(id: string): StubLink {
    const link: StubLink = { id, sent: [] };
    this.links_.push(link);
    this.events.onOpen(id);
    return link;
  }
  inbound(id: string, msg: unknown): void {
    this.events.onMessage(id, encodeMessage(msg as never));
  }
  lastSent<T = unknown>(id: string, type: string): T | null {
    const link = this.links_.find((l) => l.id === id);
    if (!link) return null;
    for (let i = link.sent.length - 1; i >= 0; i--) {
      const m = JSON.parse(link.sent[i]) as { type?: string };
      if (m.type === type) return m as T;
    }
    return null;
  }
}

type EngineModule = typeof import("./p2p");
type ChainModule = typeof import("./chain");

async function boot(challengeTimeoutMs: number): Promise<{
  engine: InstanceType<EngineModule["P2pEngine"]>;
  transport: StubTransport;
  chain: ChainModule;
}> {
  vi.resetModules();
  const chain = (await import("./chain")) as ChainModule;
  const { MemoryStorage } = await import("./storage");
  await chain.initChain(new MemoryStorage());
  const p2p = (await import("./p2p")) as EngineModule;
  const transport = new StubTransport();
  const engine = new p2p.P2pEngine([transport], { challengeTimeoutMs });
  await engine.start();
  return { engine, transport, chain };
}

async function sayHello(
  transport: StubTransport,
  chain: ChainModule,
  id: string,
): Promise<void> {
  const genesisHash = await chain.getGenesisHash();
  transport.inbound(id, {
    type: "hello",
    hello: {
      chainId: CHAIN_ID,
      p2pVersion: P2P_VERSION,
      agent: NODE_AGENT,
      genesisHash,
      height: 0,
      tipHash: genesisHash,
      serverTime: Math.floor(Date.now() / 1000),
      nodeId: id,
    },
  });
  // let the engine's per-peer queue run
  await new Promise((r) => setTimeout(r, 50));
}

describe("sybil handshake gate", () => {
  let cleanup: Array<() => void> = [];
  afterEach(() => {
    for (const fn of cleanup) fn();
    cleanup = [];
  });

  it("issues a challenge on hello; a silent peer is dropped at the deadline", async () => {
    const { engine, transport, chain } = await boot(400);
    cleanup.push(() => engine.stop());

    transport.connect("ghost-1");
    await sayHello(transport, chain, "ghost-1");

    const challenge = transport.lastSent<{ nonce: string }>("ghost-1", "challenge");
    expect(challenge?.nonce).toMatch(/^[0-9a-f]{16}$/);
    expect(engine.peerCount()).toBe(1); // still connected - the clock is ticking

    await new Promise((r) => setTimeout(r, 700)); // past the 400ms deadline
    expect(engine.peerCount()).toBe(0); // dropped, no strike - just gone
    expect(transport.closed).toContain("ghost-1");
  }, 20_000);

  it("data before verification is buffered, not struck - then flushed", async () => {
    // Timing races are not malice: a fast honest peer's first request can
    // arrive before our gate opens (e.g. right after a mutual-dial swap).
    // The gate must hold the frame - no strike, no service - and flush it
    // once the handshake completes.
    const { engine, transport, chain } = await boot(60_000);
    cleanup.push(() => engine.stop());
    const { solveSybilChallenge } = await import("./blockchain");

    transport.connect("rusher-1");
    await sayHello(transport, chain, "rusher-1");
    expect(transport.lastSent("rusher-1", "challenge")).toBeTruthy();

    transport.inbound("rusher-1", { type: "getBlocks", from: 0, count: 16 });
    await new Promise((r) => setTimeout(r, 100));
    expect(engine.peerList()[0]?.strikes).toBe(0); // held, not punished...
    expect(transport.lastSent("rusher-1", "blocks")).toBeNull(); // ...not served yet

    const challenge = transport.lastSent<{ nonce: string }>("rusher-1", "challenge")!;
    const solution = solveSybilChallenge(challenge.nonce, "0000")!;
    transport.inbound("rusher-1", { type: "challengeResponse", nonce: challenge.nonce, solution });
    await new Promise((r) => setTimeout(r, 150));

    expect(engine.peerList()[0]?.strikes).toBe(0);
    expect(transport.lastSent("rusher-1", "blocks")).toBeTruthy(); // flushed + answered
  }, 20_000);

  it("a wrong solution earns a strike; the peer stays unverified", async () => {
    const { engine, transport, chain } = await boot(60_000);
    cleanup.push(() => engine.stop());

    transport.connect("cheat-1");
    await sayHello(transport, chain, "cheat-1");
    const challenge = transport.lastSent<{ nonce: string }>("cheat-1", "challenge")!;
    // deterministically wrong: the first candidate that fails verification
    const { checkSybilSolution } = await import("./blockchain");
    let wrong = "0";
    while (checkSybilSolution(challenge.nonce, wrong, "0000")) {
      wrong = (parseInt(wrong, 16) + 1).toString(16);
    }
    transport.inbound("cheat-1", {
      type: "challengeResponse",
      nonce: challenge.nonce,
      solution: wrong,
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(engine.peerList()[0]?.strikes).toBe(1);
    // still gated: a follow-up request is buffered, never served
    transport.inbound("cheat-1", { type: "getBlocks", from: 0, count: 16 });
    await new Promise((r) => setTimeout(r, 100));
    expect(transport.lastSent("cheat-1", "blocks")).toBeNull();
  }, 20_000);

  it("drops a peer speaking a different wire version - no strike, no sync", async () => {
    // Version skew after a consensus-relevant update must not fork the mesh:
    // a mismatched p2pVersion hello is refused BEFORE the challenge is even
    // issued. Politely: closed, not banned - running old code is not evil.
    const { engine, transport, chain } = await boot(60_000);
    cleanup.push(() => engine.stop());
    const genesisHash = await chain.getGenesisHash();

    transport.connect("old-1");
    transport.inbound("old-1", {
      type: "hello",
      hello: {
        chainId: CHAIN_ID,
        p2pVersion: P2P_VERSION + 1, // a node from another software generation
        agent: "bitweb-web-mainnet/99.0",
        genesisHash,
        height: 0,
        tipHash: genesisHash,
        serverTime: Math.floor(Date.now() / 1000),
        nodeId: "old-1",
      },
    });
    await new Promise((r) => setTimeout(r, 150));

    expect(engine.peerCount()).toBe(0); // gone...
    expect(transport.closed).toContain("old-1"); // ...politely closed...
    expect(transport.lastSent("old-1", "challenge")).toBeNull(); // ...and never gated in
  }, 20_000);

  it("the full handshake unlocks data flow (hello -> challenge -> solve)", async () => {
    const { engine, transport, chain } = await boot(60_000);
    cleanup.push(() => engine.stop());
    const { solveSybilChallenge } = await import("./blockchain");

    transport.connect("honest-1");
    await sayHello(transport, chain, "honest-1");
    const challenge = transport.lastSent<{ nonce: string }>("honest-1", "challenge")!;
    const solution = solveSybilChallenge(challenge.nonce, "0000")!;
    transport.inbound("honest-1", { type: "challengeResponse", nonce: challenge.nonce, solution });
    await new Promise((r) => setTimeout(r, 150));

    // verified: no strikes, and a getBlocks now gets SERVED (blocks message)
    transport.inbound("honest-1", { type: "getBlocks", from: 0, count: 1 });
    await new Promise((r) => setTimeout(r, 150));
    expect(engine.peerList()[0]?.strikes).toBe(0);
    expect(transport.lastSent("honest-1", "blocks")).toBeTruthy();
  }, 20_000);
});
