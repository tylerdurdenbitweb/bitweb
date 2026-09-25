/**
 * The wake watchdog - the event-INDEPENDENT revival net. iOS Safari (and
 * every iOS browser, they are all WebKit shells) kills WebSockets silently
 * on screen lock, app-switcher swipes, bfcache restores and WiFi->cellular
 * handoff - and several of those fire NO pageshow/visibilitychange/online
 * event at all. These tests prove with a stub transport:
 *  - a frozen page is revived by its wall-clock jump alone,
 *  - healthy ticking never revives (no bounce storms on healthy desktops),
 *  - a node that HAD links and lost every one revives on its own,
 *  - a node that never saw a link is left to the normal reconnect ladders
 *    (it may simply be alone - reviving forever would hammer the brokers),
 *  - revives are throttled while the outage persists,
 *  - stop() disarms the watchdog completely.
 * The freeze is simulated by jumping a mocked wall clock while the real
 * 1 s-class interval keeps firing - exactly what a resumed page observes.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { initChain } from "./chain";
import { MemoryStorage } from "./storage";
import { P2pEngine } from "./p2p";
import type { Transport, TransportEvents } from "./transport";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(fn: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fn()) return;
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await sleep(20);
  }
}

class FakeTransport implements Transport {
  readonly selfId = "fake-self";
  readonly kind = "fake";
  reviveCount = 0;
  private events: TransportEvents | null = null;
  async start(events: TransportEvents): Promise<void> {
    this.events = events;
  }
  stop(): void {
    this.events = null;
  }
  dial(): void {}
  send(): void {}
  close(): void {}
  links(): string[] {
    return [];
  }
  revive(): void {
    this.reviveCount++;
  }
  /** test-only: a link appears / dies at the transport level */
  emitOpen(id = "peer-1"): void {
    this.events?.onOpen(id);
  }
  emitClose(id = "peer-1"): void {
    this.events?.onClose(id);
  }
}

let clockOffset = 0;
const realNow = Date.now;
let engines: P2pEngine[] = [];

function engineWith(
  t: FakeTransport,
  watchdog: { tickMs: number; freezeGapMs: number; peerlessMs: number; reviveMinMs: number },
): P2pEngine {
  // a generous challenge deadline: the fake peer never answers, and an
  // unanswered challenge must not ban it mid-test (peerCount ignores banned)
  const e = new P2pEngine([t], { challengeTimeoutMs: 60_000, watchdog });
  engines.push(e);
  return e;
}

beforeAll(async () => {
  await initChain(new MemoryStorage());
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + clockOffset);
});

afterEach(() => {
  for (const e of engines) e.stop();
  engines = [];
  clockOffset = 0;
});

describe("wake watchdog (iOS Safari / all iOS browsers)", () => {
  it("healthy ticking never revives; a wall-clock jump (frozen page) revives immediately", async () => {
    const t = new FakeTransport();
    const e = engineWith(t, { tickMs: 25, freezeGapMs: 150, peerlessMs: 60_000, reviveMinMs: 0 });
    await e.start();

    await sleep(200); // ~8 healthy ticks
    expect(t.reviveCount).toBe(0);

    clockOffset += 10_000; // the page slept: the next tick measures a 10 s gap
    await until(() => t.reviveCount >= 1, 2_000);
    const after = t.reviveCount;
    await sleep(200); // the jump is absorbed once - no revive storm after it
    expect(t.reviveCount).toBe(after);
  });

  it("peerless with link memory revives on its own; a never-connected node stays on the ladders", async () => {
    const t = new FakeTransport();
    const e = engineWith(t, { tickMs: 25, freezeGapMs: 60_000, peerlessMs: 250, reviveMinMs: 0 });
    await e.start();

    await sleep(500); // never had links: peerless must NOT fire
    expect(t.reviveCount).toBe(0);

    t.emitOpen("peer-1");
    await sleep(120); // ticks observe peerCount 1 -> hadLinks, fresh lastLinkAt
    expect(t.reviveCount).toBe(0);

    t.emitClose("peer-1"); // silent death: every link gone, no freeze
    await until(() => t.reviveCount >= 1, 3_000);
  });

  it("watchdog revives are throttled while the outage persists", async () => {
    const t = new FakeTransport();
    const e = engineWith(t, { tickMs: 25, freezeGapMs: 60_000, peerlessMs: 150, reviveMinMs: 400 });
    await e.start();

    t.emitOpen("peer-1");
    await sleep(120);
    t.emitClose("peer-1");

    // outage persists ~1.2 s: first revive at ~150 ms, then one per 400 ms
    // window -> 3, maybe 4. Unthrottled ticks would have produced ~40.
    await until(() => t.reviveCount >= 2, 3_000);
    await sleep(600);
    expect(t.reviveCount).toBeGreaterThanOrEqual(2);
    expect(t.reviveCount).toBeLessThanOrEqual(5);
  });

  it("stop() disarms the watchdog: no revive from a post-stop clock jump", async () => {
    const t = new FakeTransport();
    const e = engineWith(t, { tickMs: 25, freezeGapMs: 150, peerlessMs: 150, reviveMinMs: 0 });
    await e.start();
    e.stop();

    clockOffset += 10_000;
    await sleep(250);
    expect(t.reviveCount).toBe(0);
  });
});
