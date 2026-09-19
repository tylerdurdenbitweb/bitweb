/**
 * Feedback engine - procedural 1980s phosphor-terminal audio. Every
 * sound is synthesized live with the Web Audio API
 * (OscillatorNode + GainNode, no samples, no files): square/triangle/sine
 * waves, 5-10ms attack envelopes, nothing above 8kHz.
 *
 * Design contract:
 *   - LAZY: the AudioContext is created on the FIRST user gesture only
 *     (browser autoplay policy). play() before that is a silent no-op.
 *   - SINGLETON: one engine, one context, one master gain for the app.
 *   - CONCURRENCY: at most MAX_CONCURRENT sounds at once; extras are
 *     dropped, never queued.
 *   - PATTERNS are cached data (frequencies/timings); live oscillator
 *     NODES are intentionally NOT reused - the Web Audio spec makes them
 *     one-shot (start() may be called exactly once), so each play builds
 *     fresh nodes from the cached pattern and every node is stop()ed and
 *     released via its onended handler. No leaks.
 *   - ACCESSIBILITY: sounds never carry information alone - every event
 *     also posts to an aria-live region and everything mutes while the
 *     page is hidden.
 */

export type SoundEvent =
  | "block_found"
  | "transaction_sent"
  | "transaction_received"
  | "pop_reward"
  | "system"
  | "peer_connected"
  | "mining_start"
  | "mining_stop"
  | "error";

export interface FeedbackPreferences {
  sound_enabled: boolean; // default true
  volume: number; // 0.0 - MAX_VOLUME, default 0.2
}

export interface SoundEngine {
  /** Create/resume the AudioContext. Safe to call any time, any number of times. */
  init(): Promise<void>;
  /** Play the sound for an event (no-op until initialized, muted, hidden or capped). */
  play(event: SoundEvent): void;
  /** Sound + screen-reader announcement together. */
  feedback(event: SoundEvent): void;
  setSoundEnabled(enabled: boolean): void;
  isSoundEnabled(): boolean;
  setVolume(volume: number): void;
  getVolume(): number;
}

// -- preferences ---------------------------------------------------------------

const PREFS_KEY = "btwb.feedback.v1";
/** Master ceiling: these are faint background blips, never loud alerts. */
const MAX_VOLUME = 0.6;
const DEFAULT_VOLUME = 0.2;
const DEFAULT_PREFS: FeedbackPreferences = {
  sound_enabled: true,
  volume: DEFAULT_VOLUME,
};

function loadPrefs(): FeedbackPreferences {
  try {
    const raw = globalThis.localStorage?.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed = JSON.parse(raw) as Partial<FeedbackPreferences>;
    return {
      sound_enabled:
        typeof parsed.sound_enabled === "boolean"
          ? parsed.sound_enabled
          : DEFAULT_PREFS.sound_enabled,
      volume:
        typeof parsed.volume === "number" && Number.isFinite(parsed.volume)
          ? Math.min(MAX_VOLUME, Math.max(0, parsed.volume))
          : DEFAULT_PREFS.volume,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

function savePrefs(p: FeedbackPreferences): void {
  try {
    globalThis.localStorage?.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    // storage full or blocked - preferences simply stay session-local
  }
}

const prefs = loadPrefs();

// -- sound patterns (cached data) ------------------------------------------------
// One Tone = one oscillator voice. `to` sweeps the frequency exponentially.
// Peaks are pre-master gains; with the default master volume (0.2) the
// effective output peaks sit between 0.01 and 0.03 - faint background
// blips from an old machine, not startling alerts.

interface Tone {
  type: OscillatorType;
  from: number; // Hz
  to?: number; // Hz - exponential sweep target
  at: number; // seconds after play()
  dur: number; // seconds
  peak: number; // pre-master gain
}

const ATTACK_S = 0.008; // 8ms - no clicks, no pops
const MAX_CONCURRENT = 4;

const PATTERNS: Record<SoundEvent, Tone[]> = {
  // 8-bit ascending arpeggio C5-E5-G5-C6 over a faint CRT power-on hum
  block_found: [
    { type: "sine", from: 50, to: 60, at: 0, dur: 1.05, peak: 0.075 }, // CRT hum undertone
    { type: "square", from: 523.25, at: 0.0, dur: 0.13, peak: 0.15 }, // C5
    { type: "square", from: 659.25, at: 0.11, dur: 0.13, peak: 0.15 }, // E5
    { type: "square", from: 783.99, at: 0.22, dur: 0.13, peak: 0.15 }, // G5
    { type: "square", from: 1046.5, at: 0.33, dur: 0.42, peak: 0.15 }, // C6, rings out
  ],
  // quick descending triangle blip 800 -> 200 Hz
  transaction_sent: [{ type: "triangle", from: 800, to: 200, at: 0, dur: 0.28, peak: 0.1 }],
  // quick ascending sine ping 400 -> 900 Hz
  transaction_received: [{ type: "sine", from: 400, to: 900, at: 0, dur: 0.28, peak: 0.1 }],
  // participation reward: soft double chime E6 -> A6 (quieter than a block win)
  pop_reward: [
    { type: "sine", from: 1318.5, at: 0, dur: 0.14, peak: 0.09 }, // E6
    { type: "sine", from: 1760, at: 0.13, dur: 0.22, peak: 0.09 }, // A6
  ],
  // system confirm (app installed, etc.): two soft sine steps up G5 -> D6,
  // quieter than a reward chime - information, not celebration
  system: [
    { type: "sine", from: 783.99, at: 0, dur: 0.12, peak: 0.08 }, // G5
    { type: "sine", from: 1174.7, at: 0.11, dur: 0.2, peak: 0.08 }, // D6
  ],
  // soft tick, almost subliminal
  peer_connected: [{ type: "sine", from: 950, to: 700, at: 0, dur: 0.12, peak: 0.05 }],
  // CRT power-on: low hum rising, tiny top blip
  mining_start: [
    { type: "sine", from: 60, to: 170, at: 0, dur: 0.42, peak: 0.1 },
    { type: "square", from: 880, at: 0.3, dur: 0.1, peak: 0.1 },
  ],
  // CRT power-off: hum falling away
  mining_stop: [{ type: "sine", from: 170, to: 55, at: 0, dur: 0.26, peak: 0.1 }],
  // two low square beeps
  error: [
    { type: "square", from: 200, at: 0, dur: 0.09, peak: 0.12 },
    { type: "square", from: 200, at: 0.14, dur: 0.13, peak: 0.12 },
  ],
};

/** Screen-reader phrasing: sound is never the ONLY channel. */
const ANNOUNCEMENTS: Record<SoundEvent, string> = {
  block_found: "Block found - mining reward accepted.",
  transaction_sent: "Transaction sent to the network.",
  transaction_received: "Transaction received - balance increased.",
  pop_reward: "Participation reward received - balance increased.",
  system: "Done.",
  peer_connected: "Peer connected.",
  mining_start: "Mining started.",
  mining_stop: "Mining stopped.",
  error: "An operation failed.",
};

// -- engine state ------------------------------------------------------------------

type AudioContextCtor = new () => AudioContext;

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let activeSounds = 0;
let lastOwnBlockAt = 0; // see markOwnBlockReward below
let announcer: HTMLElement | null = null;

function pageHidden(): boolean {
  return typeof document !== "undefined" && document.hidden;
}

function announce(text: string): void {
  if (typeof document === "undefined" || !document.body) return;
  if (!announcer) {
    const el = document.createElement("div");
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    // visually hidden, still reachable for assistive tech
    el.style.cssText =
      "position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;" +
      "clip:rect(0,0,0,0);white-space:nowrap;border:0";
    document.body.appendChild(el);
    announcer = el;
  }
  // clear-then-set so identical consecutive events are announced again
  announcer.textContent = "";
  announcer.textContent = text;
}

async function init(): Promise<void> {
  if (typeof window === "undefined") return;
  if (!ctx) {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
    if (!Ctor) return; // no Web Audio at all - sounds silently disabled
    try {
      ctx = new Ctor();
      master = ctx.createGain();
      master.gain.value = prefs.volume;
      master.connect(ctx.destination);
    } catch {
      ctx = null;
      master = null;
      return;
    }
  }
  if (ctx.state === "suspended") {
    try {
      await ctx.resume();
    } catch {
      // still blocked - the next user gesture retries
    }
  }
}

// Autoplay-policy handshake: the first gesture anywhere creates/resumes the
// context; later gestures re-resume it if a browser re-suspends.
if (typeof document !== "undefined") {
  const onGesture = () => void init();
  document.addEventListener("pointerdown", onGesture, { passive: true });
  document.addEventListener("touchstart", onGesture, { passive: true });
  document.addEventListener("keydown", onGesture, { passive: true });
}

function play(event: SoundEvent): void {
  if (!prefs.sound_enabled || pageHidden()) return;
  if (!ctx || !master || ctx.state !== "running") return; // deferred until first gesture
  if (activeSounds >= MAX_CONCURRENT) return; // drop, never queue

  const pattern = PATTERNS[event];
  const t0 = ctx.currentTime;
  let lastStop = 0;
  let lastOsc: OscillatorNode | null = null;

  activeSounds += 1;
  try {
    for (const tone of pattern) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const start = t0 + tone.at;
      const end = start + tone.dur;
      osc.type = tone.type;
      osc.frequency.setValueAtTime(tone.from, start);
      if (tone.to !== undefined) {
        osc.frequency.exponentialRampToValueAtTime(tone.to, end);
      }
      // attack-decay envelope: ramps only, exponential can never hit 0,
      // so use a tiny floor instead - silence without the click
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(tone.peak, start + ATTACK_S);
      gain.gain.exponentialRampToValueAtTime(0.0001, end);
      osc.connect(gain);
      gain.connect(master);
      osc.start(start);
      osc.stop(end + 0.02); // let the tail reach the floor first
      if (end > lastStop) {
        lastStop = end;
        lastOsc = osc;
      }
    }
  } catch {
    activeSounds -= 1;
    return;
  }

  const release = () => {
    activeSounds = Math.max(0, activeSounds - 1);
  };
  if (lastOsc) {
    lastOsc.onended = release;
  } else {
    release();
  }
}

function feedback(event: SoundEvent): void {
  if (event === "block_found") lastOwnBlockAt = Date.now();
  play(event);
  if (!pageHidden()) announce(ANNOUNCEMENTS[event]);
}

/**
 * The balance watcher (useFeedbackWatcher) uses this to tell a mining
 * reward apart from an incoming transfer: our own block_found already
 * played its sound seconds ago, so the balance increase it causes must
 * not double-announce as "transaction received".
 */
export function recentOwnBlockReward(withinMs = 10_000): boolean {
  return Date.now() - lastOwnBlockAt < withinMs;
}

function applyVolume(): void {
  if (master && ctx) master.gain.setValueAtTime(prefs.volume, ctx.currentTime);
}

export const soundEngine: SoundEngine = {
  init,
  play,
  feedback,
  setSoundEnabled(enabled: boolean) {
    prefs.sound_enabled = enabled;
    savePrefs(prefs);
  },
  isSoundEnabled: () => prefs.sound_enabled,
  setVolume(volume: number) {
    prefs.volume = Math.min(MAX_VOLUME, Math.max(0, volume));
    savePrefs(prefs);
    applyVolume();
  },
  getVolume: () => prefs.volume,
};

// -- exposed for the UI layer (spec section 7) -----------------------------------

export function getPreferences(): FeedbackPreferences {
  return { ...prefs };
}
export function toggleSound(): boolean {
  soundEngine.setSoundEnabled(!prefs.sound_enabled);
  return prefs.sound_enabled;
}
export function setVolume(v: number): void {
  soundEngine.setVolume(v);
}
