/**
 * Screen wake lock for chain updates (the iPhone auto-lock-mid-sync fix).
 * The DOM/Wake Lock APIs are stubbed at the global level (node env): what
 * matters is the module's own contract - acquire when wanted, release when
 * not, track the OS taking the lock back (sentinel "release" event),
 * re-acquire on visibility restore, and NEVER crash a browser that lacks
 * or denies the API.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetWakeLockForTests,
  chainWakeLockHeld,
  setChainWakeLock,
} from "./wake-lock";

const tick = () => new Promise((r) => setTimeout(r, 0));

class FakeSentinel {
  releasedByUs = false;
  private releaseCbs = new Set<() => void>();
  release(): Promise<void> {
    this.releasedByUs = true;
    this.fireOsRelease();
    return Promise.resolve();
  }
  addEventListener(type: string, cb: () => void): void {
    if (type === "release") this.releaseCbs.add(cb);
  }
  /** The OS auto-releasing the lock (tab hidden, battery saver). */
  fireOsRelease(): void {
    for (const cb of this.releaseCbs) cb();
  }
}

function stubEnv(opts: { withApi?: boolean; hidden?: boolean; deny?: boolean } = {}) {
  const listeners = new Map<string, Set<() => void>>();
  const doc = {
    visibilityState: opts.hidden ? "hidden" : "visible",
    addEventListener(type: string, cb: () => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(cb);
    },
    fire(type: string) {
      for (const cb of listeners.get(type) ?? []) cb();
    },
  };
  const granted: FakeSentinel[] = [];
  const nav: { wakeLock?: { request: (t: "screen") => Promise<FakeSentinel> } } = {};
  if (opts.withApi !== false) {
    nav.wakeLock = {
      request: () => {
        if (opts.deny) return Promise.reject(new Error("NotAllowedError"));
        const s = new FakeSentinel();
        granted.push(s);
        return Promise.resolve(s);
      },
    };
  }
  (globalThis as { document?: unknown }).document = doc;
  (globalThis as { navigator?: unknown }).navigator = nav;
  return { doc, granted };
}

beforeEach(() => __resetWakeLockForTests());
afterEach(() => {
  __resetWakeLockForTests();
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { navigator?: unknown }).navigator;
});

describe("chain wake lock", () => {
  it("holds the screen awake while the gate is active, releases when it closes", async () => {
    const env = stubEnv();
    setChainWakeLock(true);
    await tick();
    expect(chainWakeLockHeld()).toBe(true);
    expect(env.granted.length).toBe(1);
    setChainWakeLock(false);
    await tick();
    expect(chainWakeLockHeld()).toBe(false);
    expect(env.granted[0].releasedByUs).toBe(true);
  });

  it("tracks an OS-side release and re-acquires when the tab shows again", async () => {
    const env = stubEnv();
    setChainWakeLock(true);
    await tick();
    expect(env.granted.length).toBe(1);

    // tab hidden: Safari kills the lock behind our back (release event)
    env.granted[0].fireOsRelease();
    env.doc.visibilityState = "hidden";
    env.doc.fire("visibilitychange");
    await tick();
    expect(chainWakeLockHeld()).toBe(false);
    expect(env.granted.length).toBe(1); // never request while hidden

    // tab visible again, gate still active: re-acquire
    env.doc.visibilityState = "visible";
    env.doc.fire("visibilitychange");
    await tick();
    expect(env.granted.length).toBe(2);
    expect(chainWakeLockHeld()).toBe(true);
  });

  it("is a no-op on browsers without the Wake Lock API", async () => {
    stubEnv({ withApi: false });
    expect(() => setChainWakeLock(true)).not.toThrow();
    await tick();
    expect(chainWakeLockHeld()).toBe(false);
    expect(() => setChainWakeLock(false)).not.toThrow();
    await tick();
  });

  it("swallows a denied request (battery saver) without touching the node", async () => {
    stubEnv({ deny: true });
    setChainWakeLock(true);
    await tick();
    expect(chainWakeLockHeld()).toBe(false);
    setChainWakeLock(false);
    await tick();
  });

  it("does not request while the document is hidden", async () => {
    const env = stubEnv({ hidden: true });
    setChainWakeLock(true);
    await tick();
    expect(env.granted.length).toBe(0);
    expect(chainWakeLockHeld()).toBe(false);
  });

  it("a gate closing mid-request drops the late sentinel instead of leaking it", async () => {
    const listeners = new Map<string, Set<() => void>>();
    (globalThis as { document?: unknown }).document = {
      visibilityState: "visible",
      addEventListener: (t: string, cb: () => void) => {
        if (!listeners.has(t)) listeners.set(t, new Set());
        listeners.get(t)!.add(cb);
      },
    };
    let resolveRequest: ((s: FakeSentinel) => void) | null = null;
    const granted: FakeSentinel[] = [];
    (globalThis as { navigator?: unknown }).navigator = {
      wakeLock: {
        request: () =>
          new Promise<FakeSentinel>((r) => {
            resolveRequest = (s: FakeSentinel) => {
              granted.push(s);
              r(s);
            };
          }),
      },
    };
    setChainWakeLock(true);
    await tick();
    setChainWakeLock(false); // gate closes BEFORE the request settles
    expect(resolveRequest).not.toBeNull();
    const late = new FakeSentinel();
    resolveRequest!(late);
    await tick();
    expect(chainWakeLockHeld()).toBe(false);
    expect(late.releasedByUs).toBe(true); // immediately released, never held
  });
});
