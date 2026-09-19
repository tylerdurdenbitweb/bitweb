/**
 * Boot resilience tests - the dev-mode crash suite.
 *
 * React 18 StrictMode mounts effects twice and Vite HMR re-runs modules, so
 * bootNode can be entered twice in one page realm. It used to die on "chain
 * already bound to a storage"; now the default boot is shared via a
 * globalThis registry and refcounted stops. These tests replay the exact
 * StrictMode sequence that produced the crash.
 *
 * Node env note: there is no IndexedDB here, so the default boot always
 * exercises the memory-only fallback - which is itself under test.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// Default boots bring up the local-tab mesh transport, so the real boot
// sync-decision window (6s) elapses before a fresh handle resolves.
vi.setConfig({ testTimeout: 25_000 });

const BOOT_KEY = "__btwbSharedBoot";

async function freshClient() {
  // New module graph (fresh chain realm) + severed registry: mirrors an
  // HMR reload, the only way a same-page fresh boot legitimately happens.
  vi.resetModules();
  delete (globalThis as Record<string, unknown>)[BOOT_KEY];
  return await import("./client");
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[BOOT_KEY];
});

describe("memory-only fallback", () => {
  it("boots in memory mode when IndexedDB is unavailable, with a working chain", async () => {
    const { bootNode } = await freshClient();
    // default boot brings up the local-tab mesh transport, so the real boot
    // sync-decision window (6s) elapses before the handle resolves
    const h = await bootNode({ webRtc: false });
    expect(h.storageMode).toBe("memory");
    const info = await h.info();
    expect(info.height).toBe(0); // genesis sealed in memory
    expect(info.chainId).toContain("bitweb");
    h.stop();
  }, 20_000);
});

describe("idempotent shared boot (StrictMode replay)", () => {
  it("two concurrent boots share one engine - no 'already bound' crash", async () => {
    const { bootNode } = await freshClient();
    const [h1, h2] = await Promise.all([bootNode({ webRtc: false }), bootNode({ webRtc: false })]);
    expect(h1.engine).toBe(h2.engine);
    expect(h1.storage).toBe(h2.storage);
    h1.stop();
    h2.stop();
  });

  it("a cancelled first handle (StrictMode unmount) does not kill the shared node", async () => {
    const { bootNode } = await freshClient();
    // The exact crash sequence: effect1 boots, StrictMode unmounts it,
    // effect2 boots again, then boot1's late resolve stops its handle.
    const p1 = bootNode({ webRtc: false });
    const p2 = bootNode({ webRtc: false });
    const h1 = await p1;
    h1.stop(); // cancelled mount releases its ref...
    const h2 = await p2; // ...but the second effect's handle must live on
    const info = await h2.info();
    expect(info.height).toBe(0);
    // registry still holds the node: a third caller joins the same engine
    const h3 = await bootNode({ webRtc: false });
    expect(h3.engine).toBe(h2.engine);
    h2.stop();
    h3.stop();
  }, 20_000);

  it("stop is idempotent - double release decrements once", async () => {
    const { bootNode } = await freshClient();
    const h1 = await bootNode({ webRtc: false });
    const h2 = await bootNode({ webRtc: false });
    h1.stop();
    h1.stop(); // no-op
    h1.stop(); // no-op
    const h3 = await bootNode({ webRtc: false });
    expect(h3.engine).toBe(h2.engine); // h2's ref still owns the node
    h2.stop();
    h3.stop();
  });

  it("after the last stop, the next boot (post-HMR realm) starts fresh", async () => {
    let client = await freshClient();
    const h1 = await client.bootNode({ webRtc: false });
    const h2 = await client.bootNode({ webRtc: false });
    h1.stop();
    h2.stop(); // last ref - engine really stops, registry cleared
    client = await freshClient(); // HMR: new module graph
    const h3 = await client.bootNode({ webRtc: false });
    expect(h3.engine).not.toBe(h1.engine);
    expect(h3.storageMode).toBe("memory");
    h3.stop();
  });

  it("injected storage/transports always boot privately, never shared", async () => {
    // A chain binds one storage per realm, so each private boot gets its own
    // module graph - exactly how the dev harness isolates node instances.
    const clientA = await freshClient();
    const { MemoryStorage } = await import("./storage");
    const a = await clientA.bootNode({ storage: new MemoryStorage(), transports: [] });
    expect((globalThis as Record<string, unknown>)[BOOT_KEY]).toBeUndefined();
    const clientB = await freshClient();
    const b = await clientB.bootNode({ storage: new MemoryStorage(), transports: [] });
    expect(a.engine).not.toBe(b.engine);
    expect((globalThis as Record<string, unknown>)[BOOT_KEY]).toBeUndefined();
    a.stop();
    b.stop();
  });
});
