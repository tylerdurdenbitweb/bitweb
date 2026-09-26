/**
 * The wake watchdog - the event-INDEPENDENT revival net. iOS Safari (and
 * every iOS browser, they are all WebKit shells) kills WebSockets silently
 * on screen lock, app-switcher swipes, bfcache restores and WiFi->cellular
 * handoff - and several of those fire NO pageshow/visibilitychange/online
 * event at all. These tests prove with a stub transport:
 *  - a frozen page is revived by its wall-clock jump alone,
 *  - healthy ticking never revives (no bounce storms on healthy desktops),
 *  - a node that HAD links and lost every one revives on its own,
 *  - a node that NEVER connected revives too (one bad boot window must not
 *    be permanent - the "no peer connected forever" outage) but on a
 *    bounded backoff, so a genuinely offline node cannot hammer brokers,
 *  - a transport whose boot dial FAILED is re-dialed by the same revive,
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

  it("peerless with link memory revives on its own; a never-connected node revives on a backoff", async () => {
    // Policy, changed deliberately: the old rule left never-connected nodes
    // alone ("they may simply be solo"), which turned ONE bad boot window
    // into a permanent zero-peer node in production. Now: had-links nodes
    // revive on the flat cadence; never-connected nodes revive on
    // reviveMinMs -> x2 -> x4 (cap), so a truly offline node pays at most
    // one re-dial per 4x window instead of hammering the brokers.
    const t = new FakeTransport();
    const e = engineWith(t, { tickMs: 25, freezeGapMs: 60_000, peerlessMs: 200, reviveMinMs: 300 });
    await e.start();

    // never had links: first revive at ~peerlessMs, then gaps 300 -> 600
    await until(() => t.reviveCount >= 1, 2_000);
    const t1 = t.reviveCount;
    await sleep(200); // inside the x2 (600 ms) gap: no second revive yet
    expect(t.reviveCount).toBe(t1);
    await until(() => t.reviveCount >= 2, 2_000); // the x2 window elapses
    await sleep(200); // inside the x4 (1200 ms) gap: no third yet
    expect(t.reviveCount).toBe(2);
  });

  it("had-links peerless revives stay on the flat cadence (no backoff)", async () => {
    const t = new FakeTransport();
    const e = engineWith(t, { tickMs: 25, freezeGapMs: 60_000, peerlessMs: 250, reviveMinMs: 0 });
    await e.start();

    await sleep(300); // never had links: the backoff regime would fire here
    const baseline = t.reviveCount;

    t.emitOpen("peer-1");
    await sleep(120); // ticks observe peerCount 1 -> hadLinks, fresh lastLinkAt
    const afterLink = t.reviveCount;

    t.emitClose("peer-1"); // silent death: every link gone, no freeze
    await until(() => t.reviveCount > afterLink, 3_000);
    expect(afterLink).toBe(baseline + 0); // the link itself caused no revive
  });

  it("a transport whose boot dial FAILED is re-dialed by the watchdog revive", async () => {
    // The pre-fix hole: revive() only re-proved ACTIVE transports, so a
    // boot-time dial failure (saturated thread, broker hiccup) was never
    // retried - the node sat at zero peers until the next page load.
    class FlakyTransport extends FakeTransport {
      startCalls = 0;
      async start(events: TransportEvents): Promise<void> {
        this.startCalls += 1;
        if (this.startCalls === 1) throw new Error("boot dial failed (transient)");
        await super.start(events);
      }
    }
    const t = new FlakyTransport();
    const e = engineWith(t, { tickMs: 25, freezeGapMs: 60_000, peerlessMs: 150, reviveMinMs: 100 });
    await e.start();
    expect(t.startCalls).toBe(1); // the boot attempt failed...
    expect(e.hasActiveTransports()).toBe(false);

    await until(() => t.startCalls >= 2 && e.hasActiveTransports(), 3_000);
    // ...and the revived transport carries links exactly like a boot one
    t.emitOpen("peer-1");
    await until(() => e.peerCount() === 1, 2_000);
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

  it("a busy sync burst is not a freeze - the watchdog holds fire while syncing", async () => {
    const t = new FakeTransport();
    const e = engineWith(t, { tickMs: 25, freezeGapMs: 150, peerlessMs: 60_000, reviveMinMs: 0 });
    await e.start();
    await sleep(200); // healthy ticking baseline
    expect(t.reviveCount).toBe(0);

    // Main thread saturated applying blocks: wall clock jumps 10 s between
    // ticks, but a sync burst is in flight - BUSY, not frozen. Pre-fix this
    // tore down the very links feeding the sync, mid-burst.
    (e as unknown as { syncing: boolean }).syncing = true;
    clockOffset += 10_000;
    await sleep(400); // several ticks observe the gap
    expect(t.reviveCount).toBe(0);

    // A TRULY dead event loop mid-sync (>=20 s) still revives.
    clockOffset += 25_000;
    await until(() => t.reviveCount >= 1, 3_000);

    // Burst over: normal sensitivity returns on the next jump.
    (e as unknown as { syncing: boolean }).syncing = false;
    clockOffset += 10_000;
    await until(() => t.reviveCount >= 2, 3_000);
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
