/**
 * Transports - how a browser tab reaches other tabs.
 *
 *   BroadcastTransport - same-browser mesh over BroadcastChannel. Always on
 *     (network.config LOCAL_TAB_MESH), powers the two-tab simulation tests.
 *   PeerJsTransport    - real WebRTC DataChannels, signaled through the
 *     ordered PeerJS-compatible rendezvous list in network.config.ts
 *     (SIGNALING_HOSTS - first reachable host wins). Loaded lazily so
 *     the test suite (and browsers that block WebRTC) never pay for it.
 *     The registration is self-healing: a boot during a network hiccup no
 *     longer strands the node - the reclaim ladder retries forever, a
 *     dropped socket is reconnected in place, and a slot stolen while the
 *     node slept forces a full re-claim.
 *   MqttRelayTransport - (mqtt.ts) the zero-config common meeting point:
 *     presence + chain gossip over free public MQTT broker rooms
 *     (MQTT_RELAYS, on by default), so any two devices that can reach the
 *     open internet at all can see each other - even where carrier-grade
 *     NAT makes a direct WebRTC channel impossible. Hand-rolled minimal
 *     MQTT 3.1.1 QoS0 client, zero runtime dependencies.
 *   WsRelayTransport   - (relay.ts) the last-resort wire: plain WebSocket
 *     through the broker's relay room, for networks where WebRTC cannot
 *     pass at all.
 *
 * All implement the same tiny contract; the P2P engine (p2p.ts) is
 * transport-agnostic.
 */
import { CHAIN_ID } from "@contracts/wire";
import {
  ICE_SERVERS,
  LOBBY_EXTENDED_SLOTS,
  LOBBY_PREFIX,
  LOBBY_SLOTS,
  SEED_PEER_IDS,
  SIGNALING_HOSTS,
  type SignalingHost,
} from "../../network.config";

export interface TransportEvents {
  /** A link to peerId is ready for traffic (inbound or outbound). */
  onOpen(peerId: string): void;
  onMessage(peerId: string, data: string): void;
  onClose(peerId: string): void;
}

export interface Transport {
  readonly selfId: string;
  readonly kind: string;
  start(events: TransportEvents): Promise<void>;
  stop(): void;
  /** Request an outbound link (no-op if one already exists). */
  dial(peerId: string): void;
  /** Send one framed message; silent no-op if the link is gone. */
  send(peerId: string, data: string): void;
  /** Politely close one link. */
  close(peerId: string): void;
  /** Currently open links. */
  links(): string[];
}

export function randomPeerId(prefix: string): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return `${prefix}-${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

// ===========================================================================
//  BROADCAST CHANNEL - same-browser mesh (and the test simulation)
// ===========================================================================

const PRESENCE_MS = 15_000; // re-announce cadence
const PRESENCE_TTL_MS = 45_000; // silent peers are forgotten
const CLAIM_DEADLINE_MS = 20_000; // max time to claim a lobby slot at boot
const REDIAL_MS = 60_000; // mesh-healing cadence for unclaimed lobby links
/** Early redial ladder after boot: broker registrations propagate in seconds. */
const REDIAL_BOOST_MS = [3_000, 5_000, 10_000, 20_000];

type SysMsg =
  | { sys: "presence"; from: string }
  | { sys: "here"; from: string; to: string }
  | { sys: "bye"; from: string }
  | { sys: "msg"; from: string; to: string; data: string };

/**
 * Virtual full-mesh links over one BroadcastChannel: every live tab is a
 * "link". Presence beacons keep the roster fresh; `send` unicasts by `to`.
 * Node.js (vitest) ships a compatible BroadcastChannel, so the exact same
 * code runs the two-tab P2P simulation tests.
 */
export class BroadcastTransport implements Transport {
  readonly kind = "broadcast";
  readonly selfId: string;
  private channelName: string;
  private bc: BroadcastChannel | null = null;
  private events: TransportEvents | null = null;
  private roster = new Map<string, number>(); // peerId -> lastSeen ms
  private beacon: ReturnType<typeof setInterval> | null = null;
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(selfId?: string, channelName?: string) {
    this.selfId = selfId ?? randomPeerId("tab");
    this.channelName = channelName ?? `bitweb-v2-${CHAIN_ID}`;
  }

  start(events: TransportEvents): Promise<void> {
    this.events = events;
    this.bc = new BroadcastChannel(this.channelName);
    this.bc.onmessage = (e: MessageEvent) => this.handle(e.data as SysMsg);
    this.beacon = setInterval(() => this.announce(), PRESENCE_MS);
    this.sweeper = setInterval(() => this.sweep(), PRESENCE_MS);
    if (typeof window !== "undefined") window.addEventListener("beforeunload", this.bye);
    this.announce();
    return Promise.resolve();
  }

  private post(m: SysMsg): void {
    this.bc?.postMessage(m);
  }

  private announce(): void {
    this.roster.set(this.selfId, Date.now());
    this.post({ sys: "presence", from: this.selfId });
  }

  private bye = (): void => this.post({ sys: "bye", from: this.selfId });

  private handle(m: SysMsg): void {
    if (!m || typeof m !== "object" || !("sys" in m)) return;
    const ev = this.events;
    if (!ev) return;
    switch (m.sys) {
      case "presence":
        if (m.from === this.selfId) return;
        this.post({ sys: "here", from: this.selfId, to: m.from });
        this.learn(m.from);
        break;
      case "here":
        if (m.to !== this.selfId || m.from === this.selfId) return;
        this.learn(m.from);
        break;
      case "bye": {
        if (this.roster.delete(m.from)) ev.onClose(m.from);
        break;
      }
      case "msg":
        if (m.to !== "*" && m.to !== this.selfId) return;
        if (m.from === this.selfId) return;
        this.learn(m.from);
        ev.onMessage(m.from, m.data);
        break;
    }
  }

  private learn(peerId: string): void {
    const known = this.roster.has(peerId);
    this.roster.set(peerId, Date.now());
    if (!known && peerId !== this.selfId) this.events?.onOpen(peerId);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, seen] of this.roster) {
      if (id !== this.selfId && now - seen > PRESENCE_TTL_MS) {
        this.roster.delete(id);
        this.events?.onClose(id);
      }
    }
  }

  dial(): void {
    // No-op BY DESIGN: a BroadcastChannel cannot dial - every same-browser
    // tab is already discovered through presence beacons. Learning ids that
    // arrived over the WIRE (peer exchange) would fabricate phantom links:
    // remote WebRTC ids are unreachable here, yet would count toward
    // MAX_PEERS and get heartbeat-pinged until dropped.
  }

  send(peerId: string, data: string): void {
    if (!this.roster.has(peerId)) return;
    this.post({ sys: "msg", from: this.selfId, to: peerId, data });
  }

  close(peerId: string): void {
    if (this.roster.delete(peerId)) this.events?.onClose(peerId);
  }

  links(): string[] {
    return [...this.roster.keys()].filter((id) => id !== this.selfId);
  }

  stop(): void {
    this.bye();
    if (this.beacon) clearInterval(this.beacon);
    if (this.sweeper) clearInterval(this.sweeper);
    if (typeof window !== "undefined") window.removeEventListener("beforeunload", this.bye);
    this.bc?.close();
    this.bc = null;
    this.roster.clear();
  }
}

// ===========================================================================
//  PEERJS / WEBRTC - the real browser-to-browser wire
// ===========================================================================

interface PeerJsLike {
  /** PeerJS live-state flags (optional so test fakes stay tiny). */
  readonly disconnected?: boolean;
  readonly destroyed?: boolean;
  on(event: "open", cb: (id: string) => void): void;
  on(event: "connection", cb: (conn: PeerJsConn) => void): void;
  on(event: "error", cb: (err: { type?: string; message?: string }) => void): void;
  on(event: "disconnected", cb: () => void): void;
  connect(id: string, opts?: { serialization?: string; reliable?: boolean }): PeerJsConn;
  reconnect(): void;
  destroy(): void;
}

interface PeerJsConn {
  peer: string;
  open: boolean;
  on(event: "open", cb: () => void): void;
  on(event: "data", cb: (data: unknown) => void): void;
  on(event: "close", cb: () => void): void;
  on(event: "error", cb: (err: unknown) => void): void;
  send(data: string): void;
  close(): void;
}

export type PeerCtor = new (id: string, o: object) => PeerJsLike;

/**
 * Tri-state probe: true = id claimed (peer opened), false = id busy or the
 * attempt timed out (try the next one), "down" = the rendezvous itself is
 * unreachable (abort against this host - no id will succeed there). On
 * success the opened peer is handed to onOpen BEFORE resolving, so the
 * caller wires its handlers without a race.
 */
function probeIdOnce(
  Ctor: PeerCtor,
  id: string,
  opts: object,
  timeoutMs: number,
  onOpen: (peer: PeerJsLike) => void,
): Promise<boolean | "down" | "silent"> {
  return new Promise((resolve) => {
    let settled = false;
    const peer = new Ctor(id, opts);
    const timer = setTimeout(() => finish("silent"), timeoutMs);
    const finish = (ok: boolean | "down" | "silent") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (ok !== true) {
        try {
          peer.destroy();
        } catch {
          /* never opened */
        }
      }
      resolve(ok);
    };
    peer.on("open", () => {
      onOpen(peer);
      finish(true);
    });
    peer.on("error", (err) => {
      if (settled) return;
      // id taken -> try the next slot
      if (err?.type === "unavailable-id") return finish(false);
      // server/socket-level failures mean the rendezvous is down
      if (
        err?.type === "network" ||
        err?.type === "server-error" ||
        err?.type === "socket-error" ||
        err?.type === "browser-incompatible"
      ) {
        return finish("down");
      }
      finish(false);
    });
  });
}

/**
 * A probe that never answers is NOT a taken id - it is a rendezvous that
 * cannot speak (dead host, misdeployed broker, blocked network). Treating
 * silence as "busy" used to mark a dead host as reachable, so the boot
 * walked its whole lobby (and could even park the overflow id on it). One
 * short retry separates a slow-but-alive host from a silent one; two
 * consecutive silences = down.
 */
async function probeId(
  Ctor: PeerCtor,
  id: string,
  opts: object,
  timeoutMs: number,
  onOpen: (peer: PeerJsLike) => void,
): Promise<boolean | "down"> {
  const first = await probeIdOnce(Ctor, id, opts, timeoutMs, onOpen);
  if (first !== "silent") return first;
  const retry = await probeIdOnce(Ctor, id, opts, Math.max(1_000, Math.floor(timeoutMs / 2)), onOpen);
  if (retry === "silent") return "down";
  return retry;
}

export interface ClaimOptions {
  /** Ordered signaling fallbacks - walked top-down. */
  hosts: readonly SignalingHost[];
  slotPrefix: string;
  /** Primary lobby range probed in order: slot-0 .. slot-(slots-1). */
  slots: number;
  /**
   * Overflow range claimed only when every primary slot is taken:
   * slot-slots .. slot-(slots+extendedSlots-1). 0 disables overflow.
   */
  extendedSlots?: number;
  /** Max time spent probing ONE host before falling to the next. */
  perHostDeadlineMs: number;
  /** Timeout for a single id probe (default 8s). */
  probeTimeoutMs?: number;
  /**
   * Probe-order rotation start (default: random). Nodes booting in the same
   * instant all used to pounce on slot-0, colliding on the broker; a random
   * rotation decorrelates them. Tests inject a fixed value for determinism.
   */
  startOffset?: number;
}

export interface ClaimResult {
  id: string;
  host: SignalingHost;
  /** true = a numbered lobby slot; false = the random overflow id. */
  slotClaimed: boolean;
}

/**
 * Serverless discovery with rendezvous fallback. For each host, in order:
 * claim the first free `${slotPrefix}-slot-N` (the rendezvous rejects taken
 * ids, so claiming is consensus by occupancy). A host that never answers
 * costs one failed probe, then the next host takes over - one dead broker
 * can no longer strand new nodes. When every reachable host's lobby is
 * full, fall back to a random overflow id on the FIRST reachable host;
 * peer exchange still finds us through the mesh. Throws only when NO host
 * answered at all.
 */
export async function claimLobbyId(
  Ctor: PeerCtor,
  o: ClaimOptions,
  onPeer: (peer: PeerJsLike) => void,
): Promise<ClaimResult> {
  const probeTimeoutMs = o.probeTimeoutMs ?? 8_000;
  const extendedSlots = o.extendedSlots ?? 0;
  let firstReachable: { host: SignalingHost; opts: object } | null = null;
  for (const host of o.hosts) {
    const opts = {
      host: host.host,
      port: host.port,
      path: host.path,
      secure: host.secure,
      debug: 0,
      // ICE kit lives in network.config.ts - STUN alone cannot traverse
      // mobile carrier NATs, TURN relays can.
      config: { iceServers: [...ICE_SERVERS] },
    };
    const deadline = Date.now() + o.perHostDeadlineMs;
    // Primary range first (rotated by startOffset so simultaneous boots do
    // not herd onto slot-0); the extended overflow range is only walked when
    // the primary lobby is full (a taken id fails fast, so the walk is cheap
    // exactly when it matters and skipped otherwise).
    const order: number[] = [];
    const off = o.startOffset ?? Math.floor(Math.random() * Math.max(1, o.slots));
    for (let i = 0; i < o.slots; i++) order.push((off + i) % o.slots);
    for (let i = 0; i < extendedSlots; i++) {
      order.push(o.slots + ((off + i) % extendedSlots));
    }
    for (const slot of order) {
      if (Date.now() >= deadline) break;
      const id = `${o.slotPrefix}-slot-${slot}`;
      const r = await probeId(Ctor, id, opts, probeTimeoutMs, onPeer);
      if (r === "down") break; // dead rendezvous - straight to the next host
      firstReachable ??= { host, opts }; // any non-"down" answer proves life
      if (r === true) return { id, host, slotClaimed: true };
    }
  }
  if (firstReachable) {
    // every lobby slot busy on the reachable host: fall back to a random
    // overflow id - peer exchange will still find us through the mesh
    const id = `${o.slotPrefix}-x-${randomPeerId("n").slice(2)}`;
    const r = await probeId(Ctor, id, firstReachable.opts, probeTimeoutMs, onPeer);
    if (r === true) return { id, host: firstReachable.host, slotClaimed: false };
  }
  throw new Error("signaling rendezvous unreachable");
}

/** How many extended-lobby ids each redial cycle probes. */
export const EXTENDED_PROBE_BATCH = 8;

/**
 * The rotating extended-lobby scan window (pure). Returns `batch` slot
 * numbers from [primarySlots, primarySlots+extendedSlots), starting at
 * `cursor` and WRAPPING around - so with one batch per redial cycle the
 * whole overflow range is swept every extendedSlots/batch cycles without
 * any persisted state. Empty when extendedSlots is 0.
 */
export function extendedProbeWindow(
  cursor: number,
  batch: number,
  extendedSlots: number,
  primarySlots: number,
): number[] {
  if (extendedSlots <= 0 || batch <= 0) return [];
  const out: number[] = [];
  for (let i = 0; i < batch; i++) {
    out.push(primarySlots + ((cursor + i) % extendedSlots));
  }
  return out;
}

/**
 * Serverless discovery: a tab CLAIMS the first free lobby id
 * `${LOBBY_PREFIX}-slot-N` (see claimLobbyId), then dials every other slot
 * plus the configured SEED_PEER_IDS. After the first link, peer exchange
 * (engine-side `peers` messages) carries the mesh far beyond the lobby.
 * The constructor accepts an optional Peer constructor so tests can run
 * the full claim dance against an in-memory fake rendezvous.
 */
export interface PeerJsRecoveryOptions {
  /** Registration watchdog cadence (default 30s). */
  watchdogMs?: number;
  /**
   * Backoff ladder for a full re-claim when the registration is gone for
   * good (destroyed peer, stolen slot, or a boot during a network hiccup).
   * The last rung repeats forever - a node NEVER gives up on the mesh.
   */
  reclaimLadderMs?: number[];
}

export class PeerJsTransport implements Transport {
  readonly kind = "webrtc";
  readonly selfId: string; // set after the lobby slot is claimed
  private peer: PeerJsLike | null = null;
  private conns = new Map<string, PeerJsConn>();
  private events: TransportEvents | null = null;
  private slotPrefix: string;
  private peerCtor: PeerCtor | null;
  /** Resolved constructor (start() caches it so re-claims skip the import). */
  private ctor: PeerCtor | null = null;
  /**
   * The peer whose registration is fully seated (id adopted, first dial
   * wave sent). wirePeer attaches its "open" handler while the claim is
   * still in flight; only a SEATED peer's re-open may fire redialLobby -
   * a claim-time open would dial with the stale "pending" selfId.
   */
  private seatedPeer: PeerJsLike | null = null;
  private recovery: Required<PeerJsRecoveryOptions>;
  private stopped = false;
  private redialTimer: ReturnType<typeof setInterval> | null = null;
  /** Early discovery boost ladder (see onClaimed()); cleared on stop. */
  private boostTimer: ReturnType<typeof setTimeout> | null = null;
  /** Registration watchdog (see watchdogTick); cleared on stop. */
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  /** Pending full re-claim (backoff ladder); cleared on stop. */
  private reclaimTimer: ReturnType<typeof setTimeout> | null = null;
  private reclaimStep = 0;
  private reclaiming = false;
  /** Rotating cursor into the extended-lobby range (see redialLobby). */
  private extendedCursor = 0;

  constructor(slotPrefix: string = LOBBY_PREFIX, peerCtor?: PeerCtor, recovery?: PeerJsRecoveryOptions) {
    this.slotPrefix = slotPrefix;
    this.peerCtor = peerCtor ?? null;
    this.recovery = {
      watchdogMs: recovery?.watchdogMs ?? 30_000,
      reclaimLadderMs: recovery?.reclaimLadderMs ?? [5_000, 15_000, 60_000],
    };
    this.selfId = `${slotPrefix}-pending`;
  }

  /**
   * Boot NEVER fails because of signaling: a rendezvous that is down right
   * now (offline boot, captive portal, hiccup) used to throw here, which
   * dropped the transport for the REST OF THE SESSION - the node then mined
   * its own chain forever, invisible to everyone. Instead we go "cold" and
   * let the reclaim ladder bring the registration up the moment any host
   * answers. Existing DataChannel links would survive anyway (they are
   * peer-to-peer), so recovering the signaling socket heals everything.
   */
  async start(events: TransportEvents): Promise<void> {
    this.events = events;
    let Ctor = this.peerCtor;
    if (!Ctor) {
      const { Peer } = await import("peerjs");
      Ctor = Peer as unknown as PeerCtor;
    }
    this.ctor = Ctor;
    try {
      await this.claim();
    } catch {
      // cold start - the reclaim ladder owns the retries from here
      this.scheduleReclaim();
    }
    // Mesh healing: initial dials may race peers that come online later (or
    // survive our own rendezvous reconnect). Re-offer unclaimed links on a
    // slow cadence - dial() is a no-op for links that already exist.
    this.redialTimer = setInterval(() => this.redialLobby(), REDIAL_MS);
    // Registration watchdog: a dropped signaling socket must be noticed and
    // re-connected even when PeerJS stays silent (mobile browsers suspend
    // sockets aggressively when the tab goes to the background).
    this.watchdogTimer = setInterval(() => this.watchdogTick(), this.recovery.watchdogMs);
  }

  /** One claim attempt against the ordered rendezvous list. */
  private async claim(): Promise<void> {
    const Ctor = this.ctor;
    if (!Ctor) throw new Error("transport never started");
    // Per-host deadline: 64 sequential slot probes against a DEAD rendezvous
    // would otherwise keep the boot screen up for minutes - and with several
    // hosts configured, each gets its own bounded window.
    const res = await claimLobbyId(
      Ctor,
      {
        hosts: SIGNALING_HOSTS,
        slotPrefix: this.slotPrefix,
        slots: LOBBY_SLOTS,
        extendedSlots: LOBBY_EXTENDED_SLOTS,
        perHostDeadlineMs: CLAIM_DEADLINE_MS,
      },
      (peer) => {
        this.peer = peer;
        this.wirePeer(peer);
      },
    );
    this.onClaimed(res.id);
  }

  /** A fresh registration is live: adopt the id and (re-)mesh aggressively. */
  private onClaimed(id: string): void {
    (this as { selfId: string }).selfId = id;
    this.seatedPeer = this.peer;
    this.reclaimStep = 0;
    this.redialLobby();
    this.startBoost();
  }

  /**
   * Early discovery boost: our first dial wave can race a peer whose
   * broker registration has not propagated yet (and vice versa) - the
   * public cloud's backends converge in seconds, so retry on a short
   * backoff ladder before settling into the steady healing cadence.
   */
  private startBoost(): void {
    if (this.boostTimer) clearTimeout(this.boostTimer);
    let boostStep = 0;
    const boostTick = () => {
      this.redialLobby();
      boostStep += 1;
      if (boostStep < REDIAL_BOOST_MS.length) {
        this.boostTimer = setTimeout(boostTick, REDIAL_BOOST_MS[boostStep]);
      }
    };
    this.boostTimer = setTimeout(boostTick, REDIAL_BOOST_MS[0]);
  }

  /**
   * The watchdog: PeerJS does not always notice (or survive) a lost
   * signaling socket on its own. Every tick:
   *   - peer object destroyed -> nothing left to repair: full re-claim.
   *   - socket disconnected   -> reconnect() in place (same id, links live).
   *   - no peer at all (cold) -> make sure the reclaim ladder is armed.
   */
  private watchdogTick(): void {
    if (this.stopped) return;
    const peer = this.peer;
    if (!peer) {
      if (!this.reclaimTimer && !this.reclaiming) this.scheduleReclaim();
      return;
    }
    if (peer.destroyed) {
      void this.fullReclaim();
      return;
    }
    if (peer.disconnected) {
      try {
        peer.reconnect();
      } catch {
        /* the next tick (or the reclaim ladder) catches a stuck socket */
      }
    }
  }

  private scheduleReclaim(): void {
    if (this.stopped || this.reclaiming || this.reclaimTimer) return;
    const ladder = this.recovery.reclaimLadderMs;
    const wait = ladder[Math.min(this.reclaimStep, ladder.length - 1)];
    this.reclaimTimer = setTimeout(() => {
      this.reclaimTimer = null;
      void this.fullReclaim();
    }, wait);
  }

  /**
   * Full re-registration: tear the dead registration down (the engine hears
   * one onClose per link, so its peer book never goes stale), then claim a
   * fresh slot - the id may change when ours was taken while we slept.
   * Failure just re-arms the ladder; giving up is not an option.
   */
  private async fullReclaim(): Promise<void> {
    if (this.stopped || this.reclaiming || !this.events) return;
    this.reclaiming = true;
    let claimed = false;
    try {
      this.teardownRegistration();
      await this.claim();
      claimed = true;
    } catch {
      /* still unreachable - the ladder below re-arms itself */
    } finally {
      // cleared BEFORE arming the next rung: scheduleReclaim refuses to
      // arm while a reclaim is in flight
      this.reclaiming = false;
    }
    if (!claimed) {
      this.reclaimStep += 1;
      this.scheduleReclaim();
    }
  }

  /** Destroy the current registration, closing every link it carried. */
  private teardownRegistration(): void {
    const old = this.peer;
    this.peer = null;
    this.seatedPeer = null;
    try {
      old?.destroy();
    } catch {
      /* already gone */
    }
    for (const [id, conn] of [...this.conns]) {
      this.conns.delete(id);
      try {
        conn.close();
      } catch {
        /* already gone */
      }
      this.events?.onClose(id);
    }
  }

  private redialLobby(): void {
    for (const seed of SEED_PEER_IDS) this.dial(seed);
    for (let slot = 0; slot < LOBBY_SLOTS; slot++) {
      const id = `${this.slotPrefix}-slot-${slot}`;
      if (id !== this.selfId) this.dial(id);
    }
    // Extended-lobby sweep: one small rotating batch per cycle (8 ids/min
    // with the default cadence -> the whole overflow range every 24 min).
    // Costs nothing on a quiet network; finds overflow peers on a busy one.
    for (const slot of extendedProbeWindow(
      this.extendedCursor,
      EXTENDED_PROBE_BATCH,
      LOBBY_EXTENDED_SLOTS,
      LOBBY_SLOTS,
    )) {
      const id = `${this.slotPrefix}-slot-${slot}`;
      if (id !== this.selfId) this.dial(id);
    }
    if (LOBBY_EXTENDED_SLOTS > 0) {
      this.extendedCursor = (this.extendedCursor + EXTENDED_PROBE_BATCH) % LOBBY_EXTENDED_SLOTS;
    }
  }

  private wirePeer(peer: PeerJsLike): void {
    peer.on("connection", (conn) => this.wireConn(conn, "in"));
    // A reconnect re-opens with the SAME id: heal the mesh immediately
    // instead of waiting for the next 60s redial cycle. (Only for the
    // seated registration - a claim-time open is meshed by onClaimed.)
    peer.on("open", () => {
      if (this.seatedPeer === peer) this.redialLobby();
    });
    peer.on("disconnected", () => {
      // First response is an in-place reconnect (keeps the id, keeps the
      // DataChannels); the watchdog and the reclaim ladder are the safety
      // net when this one shot is not enough (suspended tab, network
      // switch, captive portal).
      try {
        peer.reconnect();
      } catch {
        /* rendezvous hiccup - the watchdog retries on its cadence */
      }
    });
    peer.on("error", (err) => {
      // Our lobby slot was claimed by someone else while we were away
      // (reconnect collided with a fresh boot): this registration can never
      // come back, so claim a fresh one. Anything else is per-connection
      // noise, handled on the connections themselves.
      if (err?.type === "unavailable-id") void this.fullReclaim();
    });
  }

  /**
   * One logical link per peer. Mutual dials (both sides connect at once)
   * produce TWO parallel conns; if each side kept whichever opened last, A
   * would keep conn-1 while B keeps conn-2 - half-closed links and frames
   * delivered twice (a duplicated challenge answer used to strike honest
   * peers). Perfect-negotiation tie-break instead: the lexicographically
   * SMALLER id keeps its OUTBOUND conn, the larger keeps its INBOUND one -
   * both ends compute the same winner with zero coordination, and the loser
   * conn's close event is ignored because it no longer sits in the map.
   */
  private wireConn(conn: PeerJsConn, dir: "in" | "out"): void {
    const id = conn.peer;
    conn.on("open", () => {
      const old = this.conns.get(id);
      if (old && old !== conn && old.open) {
        const keepDir = this.selfId < id ? "out" : "in";
        const winner = dir === keepDir ? conn : old;
        const loser = dir === keepDir ? old : conn;
        // Seat the winner BEFORE closing the loser: a synchronously-firing
        // close event must find the map already pointing at the winner, so
        // the loser's drop is absorbed instead of tearing the link down.
        this.conns.set(id, winner);
        try {
          loser.close();
        } catch {
          /* already gone */
        }
        // The engine only hears about a NEW link when the winner is the new
        // conn; a losing inbound/outbound duplicate never disturbs it.
        if (winner === conn) this.events?.onOpen(id);
        return;
      }
      this.conns.set(id, conn);
      this.events?.onOpen(id);
    });
    conn.on("data", (data) => {
      if (typeof data === "string") this.events?.onMessage(id, data);
    });
    const drop = () => {
      if (this.conns.get(id) === conn) {
        this.conns.delete(id);
        this.events?.onClose(id);
      }
    };
    conn.on("close", drop);
    conn.on("error", drop);
  }

  dial(peerId: string): void {
    if (!this.peer || peerId === this.selfId || this.conns.has(peerId)) return;
    try {
      const conn = this.peer.connect(peerId, { serialization: "json", reliable: true });
      this.wireConn(conn, "out");
    } catch {
      /* peer unknown to the rendezvous - harmless */
    }
  }

  send(peerId: string, data: string): void {
    const conn = this.conns.get(peerId);
    if (conn?.open) {
      try {
        conn.send(data);
      } catch {
        /* link racing a close */
      }
    }
  }

  close(peerId: string): void {
    const conn = this.conns.get(peerId);
    if (conn) {
      try {
        conn.close();
      } catch {
        /* already gone */
      }
      this.conns.delete(peerId);
    }
  }

  links(): string[] {
    return [...this.conns.entries()].filter(([, c]) => c.open).map(([id]) => id);
  }

  stop(): void {
    this.stopped = true;
    if (this.redialTimer) clearInterval(this.redialTimer);
    this.redialTimer = null;
    if (this.boostTimer) clearTimeout(this.boostTimer);
    this.boostTimer = null;
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
    if (this.reclaimTimer) clearTimeout(this.reclaimTimer);
    this.reclaimTimer = null;
    const events = this.events;
    this.events = null;
    const old = this.peer;
    this.peer = null;
    this.seatedPeer = null;
    try {
      old?.destroy();
    } catch {
      /* already gone */
    }
    for (const [id, conn] of [...this.conns]) {
      this.conns.delete(id);
      try {
        conn.close();
      } catch {
        /* already gone */
      }
      events?.onClose(id);
    }
  }
}
