/**
 * Boot decoupling: transports start CONCURRENTLY behind a hard cap. One
 * slow rendezvous (a PeerJS claim probing a blackholed host burns its whole
 * per-host deadline) used to serialize with every other transport and hold
 * the boot screen for tens of seconds. Stragglers must still join when they
 * finish - and a transport that finishes after stop() must be stopped, not
 * leaked.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { initChain } from "./chain";
import { MemoryStorage } from "./storage";
import { P2pEngine } from "./p2p";
import type { Transport } from "./transport";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class FakeTransport implements Transport {
  readonly selfId = "fake-self";
  started = false;
  stopCount = 0;
  private release: (() => void) | null = null;
  constructor(
    readonly kind: string,
    private readonly mode: "instant" | "hang" | "manual",
  ) {
    void this.release;
  }
  start(): Promise<void> {
    if (this.mode === "hang") return new Promise(() => {}); // never
    if (this.mode === "manual") {
      return new Promise((resolve) => {
        this.release = () => {
          this.started = true;
          resolve();
        };
      });
    }
    this.started = true;
    return Promise.resolve();
  }
  finishStart(): void {
    this.release?.();
  }
  stop(): void {
    this.stopCount++;
  }
  dial(): void {}
  send(): void {}
  close(): void {}
  links(): string[] {
    return [];
  }
}

let engines: P2pEngine[] = [];

beforeAll(async () => {
  await initChain(new MemoryStorage());
});

afterEach(() => {
  for (const e of engines) e.stop();
  engines = [];
});

describe("engine.start: concurrent transports behind a hard cap", () => {
  it("a hanging transport never holds the boot hostage; the fast one is active immediately", async () => {
    const hang = new FakeTransport("hang", "hang");
    const fast = new FakeTransport("fast", "instant");
    const e = new P2pEngine([hang, fast], { startCapMs: 200 });
    engines.push(e);

    const t0 = Date.now();
    await e.start(); // must NOT wait for the hanger
    const waited = Date.now() - t0;
    expect(waited).toBeLessThan(2_000);
    expect(fast.started).toBe(true);
    expect(e.hasActiveTransports()).toBe(true);
  });

  it("a straggler that finishes after the cap still joins the active set", async () => {
    const hang = new FakeTransport("hang", "hang");
    const slow = new FakeTransport("slow", "manual");
    const e = new P2pEngine([hang, slow], { startCapMs: 150 });
    engines.push(e);

    await e.start(); // cap fires with nothing ready
    expect(e.hasActiveTransports()).toBe(false);

    slow.finishStart(); // rendezvous answers 300 ms late
    await sleep(400);
    await new Promise((r) => setTimeout(r, 0));
    expect(slow.started).toBe(true);
    expect(e.hasActiveTransports()).toBe(true);
  });

  it("a transport that finishes after stop() is stopped, never leaked", async () => {
    const slow = new FakeTransport("slow", "manual");
    const e = new P2pEngine([slow], { startCapMs: 150 });
    engines.push(e); // stop() is idempotent - afterEach calling it again is fine

    const started = e.start();
    await new Promise((r) => setTimeout(r, 0)); // let the engine actually invoke t.start()
    e.stop(); // engine dies while the rendezvous is still probing
    slow.finishStart();
    await started;
    await new Promise((r) => setTimeout(r, 0));
    expect(slow.started).toBe(true); // it DID finish starting...
    expect(slow.stopCount).toBe(1); // ...and was immediately torn down
    expect(e.hasActiveTransports()).toBe(false);
  });
});
