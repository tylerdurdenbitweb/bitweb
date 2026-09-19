/**
 * Sound engine tests - the whole Web Audio / DOM surface is
 * faked so the engine runs under the node environment. Each test boots a
 * fresh module instance (vi.resetModules + dynamic import) because the
 * engine is a singleton with module-level state.
 *
 * Covers the spec's verification checklist:
 *   init without user gesture (no throw, just defer) - per-event frequency
 *   patterns - attack envelope > 0 - concurrency cap (max 4, drop not
 *   queue) - preference persistence - page hidden mutes -
 *   aria-live announcements - nodes released on ended (no leaks).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SoundEvent } from "./sound";

// -- fakes --------------------------------------------------------------------

type ParamCall = [string, number, number];

class FakeParam {
  value = 0;
  calls: ParamCall[] = [];
  setValueAtTime(v: number, t: number) {
    this.calls.push(["setValueAtTime", v, t]);
    this.value = v;
  }
  exponentialRampToValueAtTime(v: number, t: number) {
    this.calls.push(["exponentialRampToValueAtTime", v, t]);
  }
}

class FakeOsc {
  type = "";
  frequency = new FakeParam();
  onended: (() => void) | null = null;
  starts: number[] = [];
  stops: number[] = [];
  connect() {}
  start(t: number) {
    this.starts.push(t);
  }
  stop(t: number) {
    this.stops.push(t);
  }
  end() {
    this.onended?.();
  }
}

class FakeGain {
  gain = new FakeParam();
  connect() {}
}

class FakeCtx {
  state: "suspended" | "running" = "running";
  currentTime = 1;
  destination = {};
  oscillators: FakeOsc[] = [];
  gains: FakeGain[] = [];
  resumeCount = 0;
  createOscillator() {
    const o = new FakeOsc();
    this.oscillators.push(o);
    return o;
  }
  createGain() {
    const g = new FakeGain();
    this.gains.push(g);
    return g;
  }
  async resume() {
    this.resumeCount += 1;
    this.state = "running";
  }
}

interface FakeElement {
  attrs: Record<string, string>;
  style: { cssText: string };
  textContent: string;
  setAttribute(k: string, v: string): void;
}

interface FakeDocument {
  hidden: boolean;
  body: { children: FakeElement[]; appendChild(el: FakeElement): void };
  createElement(): FakeElement;
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(): void;
  dispatch(type: string): void;
  listeners: Record<string, Array<() => void>>;
}

function makeDocument(hidden = false): FakeDocument {
  const listeners: Record<string, Array<() => void>> = {};
  return {
    hidden,
    listeners,
    body: {
      children: [],
      appendChild(el: FakeElement) {
        this.children.push(el);
      },
    },
    createElement: () => ({
      attrs: {},
      style: { cssText: "" },
      textContent: "",
      setAttribute(k: string, v: string) {
        this.attrs[k] = v;
      },
    }),
    addEventListener(type: string, fn: () => void) {
      (listeners[type] ??= []).push(fn);
    },
    removeEventListener() {},
    dispatch(type: string) {
      for (const fn of listeners[type] ?? []) fn();
    },
  };
}

function makeLocalStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    raw: (k: string) => map.get(k),
  };
}

type CtxCtor = new () => FakeCtx;

interface BootEnv {
  ctxCtor?: CtxCtor;
  webkitCtor?: CtxCtor;
  document?: FakeDocument | null;
  navigator?: object | null;
  localStorage?: ReturnType<typeof makeLocalStorage> | null;
  matchMedia?: (query: string) => { matches: boolean };
}

const GLOBAL_KEYS = ["window", "document", "navigator", "localStorage"];

function setGlobal(key: string, value: unknown): void {
  Object.defineProperty(globalThis, key, {
    value,
    configurable: true,
    writable: true,
  });
}

async function boot(env: BootEnv = {}) {
  vi.resetModules();
  for (const key of GLOBAL_KEYS) {
    try {
      delete (globalThis as Record<string, unknown>)[key];
    } catch {
      // non-configurable pre-existing global - overwritten below anyway
    }
  }
  const instances: FakeCtx[] = [];
  if (env.ctxCtor || env.webkitCtor) {
    const Ctor = env.ctxCtor;
    const Webkit = env.webkitCtor;
    const track = (Base: CtxCtor): CtxCtor =>
      class extends Base {
        constructor() {
          super();
          instances.push(this);
        }
      };
    const win: Record<string, unknown> = {};
    if (Ctor) win.AudioContext = track(Ctor);
    if (Webkit) win.webkitAudioContext = track(Webkit);
    if (env.matchMedia) win.matchMedia = env.matchMedia;
    setGlobal("window", win);
  } else if (env.matchMedia) {
    setGlobal("window", { matchMedia: env.matchMedia });
  }
  if (env.document) setGlobal("document", env.document);
  if (env.navigator) setGlobal("navigator", env.navigator);
  if (env.localStorage) setGlobal("localStorage", env.localStorage);
  const mod = await import("./sound");
  return {
    mod,
    get ctx() {
      return instances.length > 0 ? instances[instances.length - 1] : null;
    },
    get constructed() {
      return instances.length;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  for (const key of GLOBAL_KEYS) {
    try {
      delete (globalThis as Record<string, unknown>)[key];
    } catch {
      // ignore
    }
  }
});

const EVENTS: SoundEvent[] = [
  "block_found",
  "transaction_sent",
  "transaction_received",
  "pop_reward",
  "system",
  "peer_connected",
  "mining_start",
  "mining_stop",
  "error",
];

// -- initialization ------------------------------------------------------------

describe("initialization", () => {
  it("init without any window does not throw and playback stays deferred", async () => {
    const { mod } = await boot();
    await expect(mod.soundEngine.init()).resolves.toBeUndefined();
    expect(() => mod.soundEngine.play("error")).not.toThrow();
    expect(() => mod.soundEngine.feedback("block_found")).not.toThrow();
  });

  it("play before the first gesture is a silent no-op", async () => {
    const doc = makeDocument();
    const env = await boot({ ctxCtor: FakeCtx, document: doc });
    env.mod.soundEngine.play("error");
    expect(env.constructed).toBe(0); // context not created ahead of a gesture
    expect(env.ctx).toBeNull();
  });

  it("the first user gesture creates the context (autoplay handshake)", async () => {
    const doc = makeDocument();
    const env = await boot({ ctxCtor: FakeCtx, document: doc });
    expect(doc.listeners["pointerdown"]).toHaveLength(1);
    expect(doc.listeners["touchstart"]).toHaveLength(1);
    expect(doc.listeners["keydown"]).toHaveLength(1);
    doc.dispatch("pointerdown");
    expect(env.constructed).toBe(1);
    env.mod.soundEngine.play("error");
    expect(env.ctx!.oscillators.length).toBeGreaterThan(0);
  });

  it("init is idempotent - one context, one master gain", async () => {
    const env = await boot({ ctxCtor: FakeCtx });
    await env.mod.soundEngine.init();
    await env.mod.soundEngine.init();
    expect(env.constructed).toBe(1);
    expect(env.ctx!.gains).toHaveLength(1); // master gain only
    expect(env.ctx!.gains[0].gain.value).toBe(0.2); // default volume
  });

  it("a suspended context is resumed on init", async () => {
    class SuspendedCtx extends FakeCtx {
      constructor() {
        super();
        this.state = "suspended";
      }
    }
    const env = await boot({ ctxCtor: SuspendedCtx });
    await env.mod.soundEngine.init();
    expect(env.ctx!.resumeCount).toBe(1);
    expect(env.ctx!.state).toBe("running");
  });

  it("falls back to webkitAudioContext when AudioContext is missing", async () => {
    const env = await boot({ webkitCtor: FakeCtx });
    await env.mod.soundEngine.init();
    expect(env.constructed).toBe(1);
  });

  it("no Web Audio API at all - init resolves and play is a no-op", async () => {
    setGlobal("window", {});
    vi.resetModules();
    const mod = await import("./sound");
    await expect(mod.soundEngine.init()).resolves.toBeUndefined();
    expect(() => mod.soundEngine.play("error")).not.toThrow();
  });
});

// -- patterns + envelopes ---------------------------------------------------------

const EXPECTED_VOICES: Record<
  SoundEvent,
  Array<{ type: string; from: number; to?: number; peak: number }>
> = {
  block_found: [
    { type: "sine", from: 50, to: 60, peak: 0.075 }, // CRT hum undertone
    { type: "square", from: 523.25, peak: 0.15 }, // C5
    { type: "square", from: 659.25, peak: 0.15 }, // E5
    { type: "square", from: 783.99, peak: 0.15 }, // G5
    { type: "square", from: 1046.5, peak: 0.15 }, // C6
  ],
  transaction_sent: [{ type: "triangle", from: 800, to: 200, peak: 0.1 }],
  transaction_received: [{ type: "sine", from: 400, to: 900, peak: 0.1 }],
  pop_reward: [
    { type: "sine", from: 1318.5, peak: 0.09 }, // E6
    { type: "sine", from: 1760, peak: 0.09 }, // A6
  ],
  system: [
    { type: "sine", from: 783.99, peak: 0.08 }, // G5
    { type: "sine", from: 1174.7, peak: 0.08 }, // D6
  ],
  peer_connected: [{ type: "sine", from: 950, to: 700, peak: 0.05 }],
  mining_start: [
    { type: "sine", from: 60, to: 170, peak: 0.1 },
    { type: "square", from: 880, peak: 0.1 },
  ],
  mining_stop: [{ type: "sine", from: 170, to: 55, peak: 0.1 }],
  error: [
    { type: "square", from: 200, peak: 0.12 },
    { type: "square", from: 200, peak: 0.12 },
  ],
};

describe("per-event patterns", () => {
  for (const event of EVENTS) {
    it(`${event} plays its spec voices (type + frequency + gain)`, async () => {
      const env = await boot({ ctxCtor: FakeCtx });
      await env.mod.soundEngine.init();
      env.mod.soundEngine.play(event);
      const oscs = env.ctx!.oscillators;
      const expected = EXPECTED_VOICES[event];
      expect(oscs).toHaveLength(expected.length);
      const base = env.ctx!.gains.length - oscs.length; // voice gains of this play
      oscs.forEach((osc, i) => {
        expect(osc.type).toBe(expected[i].type);
        const setFreq = osc.frequency.calls.find((c) => c[0] === "setValueAtTime");
        expect(setFreq?.[1]).toBeCloseTo(expected[i].from, 2);
        const sweep = osc.frequency.calls.find((c) => c[0] === "exponentialRampToValueAtTime");
        if (expected[i].to === undefined) {
          expect(sweep).toBeUndefined();
        } else {
          expect(sweep?.[1]).toBeCloseTo(expected[i].to as number, 2);
        }
        const attack = env.ctx!.gains[base + i].gain.calls.find(
          (c) => c[0] === "exponentialRampToValueAtTime",
        );
        expect(attack?.[1]).toBeCloseTo(expected[i].peak, 3); // reduced base gain
      });
    });
  }

  it("every voice uses a 5-10ms attack envelope with a 0.0001 silence floor", async () => {
    const env = await boot({ ctxCtor: FakeCtx });
    await env.mod.soundEngine.init();
    const masterGains = env.ctx!.gains.length;
    for (const event of EVENTS) {
      env.mod.soundEngine.play(event);
      env.ctx!.oscillators.forEach((o) => o.end()); // release for the next event
    }
    const voiceGains = env.ctx!.gains.slice(masterGains);
    const voiceCount = EVENTS.reduce((n, e) => n + EXPECTED_VOICES[e].length, 0);
    expect(voiceGains).toHaveLength(voiceCount);
    for (const g of voiceGains) {
      const calls = g.gain.calls;
      expect(calls[0][0]).toBe("setValueAtTime");
      expect(calls[0][1]).toBe(0.0001); // floor, never hard zero
      const attack = calls[1];
      expect(attack[0]).toBe("exponentialRampToValueAtTime");
      const attackDelta = attack[2] - calls[0][2];
      expect(attackDelta).toBeGreaterThanOrEqual(0.005);
      expect(attackDelta).toBeLessThanOrEqual(0.01);
      const decay = calls[2];
      expect(decay[0]).toBe("exponentialRampToValueAtTime");
      expect(decay[1]).toBe(0.0001); // tail returns to the floor - no click
      expect(decay[2]).toBeGreaterThan(attack[2]);
    }
  });

  it("every oscillator is started once and stopped once (one-shot nodes, no reuse)", async () => {
    const env = await boot({ ctxCtor: FakeCtx });
    await env.mod.soundEngine.init();
    env.mod.soundEngine.play("block_found");
    for (const osc of env.ctx!.oscillators) {
      expect(osc.starts).toHaveLength(1);
      expect(osc.stops).toHaveLength(1);
      expect(osc.stops[0]).toBeGreaterThan(osc.starts[0]);
    }
  });

  it("nothing exceeds 8kHz and effective peaks stay subliminal", async () => {
    const env = await boot({ ctxCtor: FakeCtx });
    await env.mod.soundEngine.init();
    for (const event of EVENTS) {
      env.mod.soundEngine.play(event);
      env.ctx!.oscillators.forEach((o) => o.end());
    }
    for (const osc of env.ctx!.oscillators) {
      for (const c of osc.frequency.calls) expect(c[1]).toBeLessThanOrEqual(8000);
    }
    const voiceGains = env.ctx!.gains.slice(1); // skip master
    for (const g of voiceGains) {
      const effective = g.gain.calls[1][1] * 0.2; // pre-master peak x default volume
      expect(effective).toBeLessThanOrEqual(0.03); // faint background blip
      // even at the hard volume ceiling (0.6) nothing gets loud
      expect(g.gain.calls[1][1] * 0.6).toBeLessThanOrEqual(0.09);
    }
  });
});

// -- concurrency ------------------------------------------------------------------

describe("concurrency cap", () => {
  it("allows at most 4 concurrent sounds and drops (never queues) the rest", async () => {
    const env = await boot({ ctxCtor: FakeCtx });
    await env.mod.soundEngine.init();
    for (let i = 0; i < 6; i++) env.mod.soundEngine.play("transaction_sent");
    // 4 accepted x 1 voice each; sounds 5 and 6 dropped with no nodes built
    expect(env.ctx!.oscillators).toHaveLength(4);
  });

  it("ended sounds release their slot - no leak across plays", async () => {
    const env = await boot({ ctxCtor: FakeCtx });
    await env.mod.soundEngine.init();
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 4; i++) env.mod.soundEngine.play("error"); // fill to cap
      const before = env.ctx!.oscillators.length;
      env.mod.soundEngine.play("error"); // must be dropped - still at cap
      expect(env.ctx!.oscillators.length).toBe(before);
      // end every last-osc of each sound: error's second voice ends last
      const oscs = env.ctx!.oscillators.slice();
      for (let i = 1; i < oscs.length; i += 2) oscs[i].end();
    }
    // 3 rounds x 4 sounds x 2 voices, all released each round
    expect(env.ctx!.oscillators).toHaveLength(24);
  });
});

// -- preferences --------------------------------------------------------------------

describe("preferences", () => {
  it("defaults are sound on, volume 0.2", async () => {
    const { mod } = await boot({ localStorage: makeLocalStorage() });
    expect(mod.getPreferences()).toEqual({
      sound_enabled: true,
      volume: 0.2,
    });
    expect(mod.soundEngine.isSoundEnabled()).toBe(true);
    expect(mod.soundEngine.getVolume()).toBe(0.2);
  });

  it("toggles persist across a module reload (localStorage round-trip)", async () => {
    const store = makeLocalStorage();
    const first = await boot({ localStorage: store });
    expect(first.mod.toggleSound()).toBe(false);
    first.mod.setVolume(0.4);
    expect(JSON.parse(store.raw("btwb.feedback.v1")!)).toEqual({
      sound_enabled: false,
      volume: 0.4,
    });
    const second = await boot({ localStorage: store });
    expect(second.mod.soundEngine.isSoundEnabled()).toBe(false);
    expect(second.mod.soundEngine.getVolume()).toBe(0.4);
    expect(second.mod.toggleSound()).toBe(true); // toggling back works too
  });

  it("volume is clamped to [0, 0.6] and applied to the live master gain", async () => {
    const env = await boot({ ctxCtor: FakeCtx, localStorage: makeLocalStorage() });
    await env.mod.soundEngine.init();
    env.mod.soundEngine.setVolume(0.4);
    expect(env.mod.soundEngine.getVolume()).toBe(0.4);
    const master = env.ctx!.gains[0];
    expect(master.gain.calls.at(-1)).toEqual(["setValueAtTime", 0.4, 1]);
    env.mod.soundEngine.setVolume(1.7);
    expect(env.mod.soundEngine.getVolume()).toBe(0.6); // hard ceiling - never loud
    env.mod.soundEngine.setVolume(0.9);
    expect(env.mod.soundEngine.getVolume()).toBe(0.6);
    env.mod.soundEngine.setVolume(-0.2);
    expect(env.mod.soundEngine.getVolume()).toBe(0);
  });

  it("corrupt stored preferences fall back to defaults", async () => {
    const store = makeLocalStorage();
    store.setItem("btwb.feedback.v1", "{not json");
    const { mod } = await boot({ localStorage: store });
    expect(mod.getPreferences()).toEqual({
      sound_enabled: true,
      volume: 0.2,
    });
  });

  it("disabled sound preference silences playback", async () => {
    const env = await boot({ ctxCtor: FakeCtx });
    await env.mod.soundEngine.init();
    env.mod.soundEngine.setSoundEnabled(false);
    env.mod.soundEngine.play("error");
    expect(env.ctx!.oscillators).toHaveLength(0);
  });
});

// -- visibility + accessibility -----------------------------------------------------

describe("page visibility", () => {
  it("a hidden page mutes sound and announcements", async () => {
    const doc = makeDocument(true);
    const env = await boot({
      ctxCtor: FakeCtx,
      document: doc,
    });
    await env.mod.soundEngine.init();
    env.mod.soundEngine.feedback("block_found");
    expect(env.ctx!.oscillators).toHaveLength(0);
    expect(doc.body.children).toHaveLength(0); // no announcer created
  });

  it("unhiding restores playback", async () => {
    const doc = makeDocument(true);
    const env = await boot({ ctxCtor: FakeCtx, document: doc });
    await env.mod.soundEngine.init();
    env.mod.soundEngine.play("error");
    expect(env.ctx!.oscillators).toHaveLength(0);
    doc.hidden = false;
    env.mod.soundEngine.play("error");
    expect(env.ctx!.oscillators).toHaveLength(2);
  });
});

describe("accessibility announcements", () => {
  it("feedback posts the event text to an aria-live status region", async () => {
    const doc = makeDocument();
    const env = await boot({ ctxCtor: FakeCtx, document: doc });
    await env.mod.soundEngine.init();
    env.mod.soundEngine.feedback("transaction_received");
    expect(doc.body.children).toHaveLength(1);
    const el = doc.body.children[0];
    expect(el.attrs["role"]).toBe("status");
    expect(el.attrs["aria-live"]).toBe("polite");
    expect(el.textContent).toBe("Transaction received - balance increased.");
  });

  it("identical consecutive events are re-announced (clear-then-set)", async () => {
    const doc = makeDocument();
    const env = await boot({ ctxCtor: FakeCtx, document: doc });
    await env.mod.soundEngine.init();
    env.mod.soundEngine.feedback("error");
    env.mod.soundEngine.feedback("error");
    expect(doc.body.children).toHaveLength(1); // region reused
    expect(doc.body.children[0].textContent).toBe("An operation failed.");
  });
});

// -- mining-reward suppression --------------------------------------------------------

describe("own-block reward suppression", () => {
  it("block_found feedback marks a recent own reward for 10 seconds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const env = await boot({ ctxCtor: FakeCtx });
    expect(env.mod.recentOwnBlockReward()).toBe(false);
    env.mod.soundEngine.feedback("block_found");
    expect(env.mod.recentOwnBlockReward()).toBe(true);
    vi.setSystemTime(1_000_000 + 9_999);
    expect(env.mod.recentOwnBlockReward()).toBe(true);
    vi.setSystemTime(1_000_000 + 10_001);
    expect(env.mod.recentOwnBlockReward()).toBe(false);
  });

  it("other events do not mark a reward", async () => {
    const env = await boot({ ctxCtor: FakeCtx });
    env.mod.soundEngine.feedback("transaction_sent");
    expect(env.mod.recentOwnBlockReward()).toBe(false);
  });
});
