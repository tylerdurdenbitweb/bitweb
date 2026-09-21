/**
 * MqttRelayTransport - the ZERO-CONFIG common meeting point.
 *
 * The remaining way "two devices each mine their own chain" happens: both
 * boots are healthy, but the WebRTC path between them cannot be opened
 * (carrier-grade NAT on one side, UDP filtered on the other) and the node
 * has no relay configured. This transport closes that hole for good with
 * NO server of ours: every device on earth subscribes to the SAME two
 * topics on the SAME free public MQTT brokers (MQTT-over-WebSocket goes
 * anywhere HTTPS goes - port 443, TLS, proxies pass it). Presence and
 * chain gossip ride those rooms, so any two browsers that can reach the
 * open internet at all can see each other and sync one chain.
 *
 * Trust model (same as the WebSocket relay): brokers see ONLY
 * already-signed public chain frames - wallets and keys never leave the
 * browser, every frame is validated by the receiving node. A broker is a
 * LIVENESS dependency, never an integrity one; and because the node
 * connects to EVERY configured broker at once (plus WebRTC and the
 * same-browser mesh in parallel), no single broker going down - or
 * censoring - can partition the network.
 *
 * Link model mirrors BroadcastTransport/WsRelayTransport: room presence
 * is the link set (dial is a no-op), messages are unicast through a
 * per-peer inbox topic. Ids live in their own namespace (`m-<hex12>`), so
 * a node reachable over several transports appears as several independent
 * engine peers - redundant paths, never a doubled identity.
 *
 * The client below is a hand-rolled minimal MQTT 3.1.1 QoS0 stack
 * (~150 lines) so the runtime dependency count stays at zero. It does
 * exactly four things: CONNECT, SUBSCRIBE, PUBLISH QoS0, PINGREQ - which
 * is everything a gossip presence room needs.
 */
import { CHAIN_ID } from "@contracts/wire";
import { MQTT_RELAYS } from "../../network.config";
import { randomPeerId, type Transport, type TransportEvents } from "./transport";

// ===========================================================================
//  MINI MQTT 3.1.1 CLIENT (QoS0 over WebSocket)
// ===========================================================================

/** Binary socket surface: the browser WebSocket and the ws package both
 *  map onto it, so tests run the real wire protocol against a real broker. */
export interface MqttSocketLike {
  on(event: "open" | "close" | "error", cb: () => void): void;
  on(event: "message", cb: (data: Uint8Array) => void): void;
  send(data: Uint8Array): void;
  close(): void;
}

/** Adapt the browser's native WebSocket (binary, "mqtt" subprotocol). */
function wrapNativeWebSocket(ws: WebSocket): MqttSocketLike {
  ws.binaryType = "arraybuffer";
  return {
    on(event, cb) {
      if (event === "message") {
        ws.addEventListener("message", (e: MessageEvent) => {
          if (e.data instanceof ArrayBuffer) cb(new Uint8Array(e.data));
        });
      } else {
        const done = cb as () => void;
        ws.addEventListener(event, () => done());
      }
    },
    send: (d) => ws.send(d),
    close: () => ws.close(),
  };
}

const te = new TextEncoder();
const td = new TextDecoder();

/** Frame-level tracing for field debugging: append ?mqttdebug=1 to the URL
 *  and every transport event is logged in the browser console. Off by
 *  default; zero cost when off. */
const DEBUG =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).has("mqttdebug");
function dbg(...args: unknown[]): void {
  if (DEBUG) console.log("[mqtt]", ...args);
}
/** Best-effort frame label for logs (engine frames are JSON strings). */
function frameLabel(data: string): string {
  try {
    const t = (JSON.parse(data) as { type?: unknown }).type;
    return typeof t === "string" ? t : "?";
  } catch {
    return "?";
  }
}

function utf8(s: string): Uint8Array {
  return te.encode(s);
}

/** MQTT UTF-8 string: two-byte length prefix + bytes. */
function str(s: string): Uint8Array {
  const b = utf8(s);
  const out = new Uint8Array(2 + b.length);
  out[0] = b.length >> 8;
  out[1] = b.length & 255;
  out.set(b, 2);
  return out;
}

/** MQTT "remaining length" varint (1-4 bytes). */
function remainingLen(n: number): Uint8Array {
  const out: number[] = [];
  do {
    let d = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) d |= 0x80;
    out.push(d);
  } while (n > 0);
  return Uint8Array.from(out);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function packet(type: number, flags: number, body: Uint8Array): Uint8Array {
  const rl = remainingLen(body.length);
  const out = new Uint8Array(1 + rl.length + body.length);
  out[0] = (type << 4) | flags;
  out.set(rl, 1);
  out.set(body, 1 + rl.length);
  return out;
}

const PT = {
  CONNECT: 1,
  CONNACK: 2,
  PUBLISH: 3,
  SUBSCRIBE: 8,
  SUBACK: 9,
  PINGREQ: 12,
  PINGRESP: 13,
  DISCONNECT: 14,
} as const;

/** Hard cap on one MQTT packet: anything bigger is a rogue/buggy peer -
 *  the socket is dropped rather than buffering unbounded memory. */
const MAX_PACKET_BYTES = 1024 * 1024;

interface DecodedPacket {
  type: number;
  flags: number;
  body: Uint8Array;
}

/** Incremental parser: WebSocket frames may split or join MQTT packets. */
class PacketParser {
  private buf: Uint8Array = new Uint8Array(0);

  push(chunk: Uint8Array): DecodedPacket[] {
    this.buf = concat(this.buf, chunk);
    const out: DecodedPacket[] = [];
    for (;;) {
      if (this.buf.length < 2) break;
      let rl = 0;
      let mult = 1;
      let varintBytes = 0;
      let done = false;
      for (let i = 1; i < this.buf.length && i <= 4; i++) {
        const d = this.buf[i];
        rl += (d & 127) * mult;
        mult *= 128;
        varintBytes = i;
        if ((d & 128) === 0) {
          done = true;
          break;
        }
      }
      if (!done) break; // incomplete varint - wait for more bytes
      if (rl > MAX_PACKET_BYTES) throw new Error("mqtt packet exceeds cap");
      const headerLen = 1 + varintBytes;
      if (this.buf.length < headerLen + rl) break; // body not fully here yet
      out.push({ type: this.buf[0] >> 4, flags: this.buf[0] & 15, body: this.buf.subarray(headerLen, headerLen + rl) });
      this.buf = this.buf.subarray(headerLen + rl);
    }
    return out;
  }
}

export interface MiniMqttOptions {
  clientId: string;
  keepAliveSec?: number;
  connectTimeoutMs?: number;
  newSocket?: (url: string) => MqttSocketLike;
}

export interface MiniMqttEvents {
  /** CONNACK accepted: the session is live - subscribe now, publish after. */
  onConnect(): void;
  /** Subscriptions confirmed - safe to publish/expect traffic. */
  onReady(): void;
  onMessage(topic: string, payload: Uint8Array): void;
  /** Socket ended (any reason, expected or not) - the owner decides retry. */
  onClose(): void;
}

/**
 * One MQTT-over-WebSocket session. Never throws, never retries by itself
 * (the transport owns the reconnect ladder); onClose always fires exactly
 * once per connect attempt.
 */
export class MiniMqttClient {
  readonly url: string;
  private opts: Required<Omit<MiniMqttOptions, "newSocket">>;
  private newSocket: (url: string) => MqttSocketLike;
  private events: MiniMqttEvents;
  private socket: MqttSocketLike | null = null;
  private parser = new PacketParser();
  private ready = false;
  private closedNotified = false;
  private userStop = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastRx = 0;
  private nextPacketId = 1;
  /** packetId -> resolve(); SUBACKs we still wait for before "ready". */
  private pendingSubs = new Map<number, () => void>();

  constructor(url: string, opts: MiniMqttOptions, events: MiniMqttEvents) {
    this.url = url;
    this.opts = {
      clientId: opts.clientId,
      keepAliveSec: opts.keepAliveSec ?? 30,
      connectTimeoutMs: opts.connectTimeoutMs ?? 8_000,
    };
    this.newSocket =
      opts.newSocket ?? ((u: string) => wrapNativeWebSocket(new WebSocket(u, "mqtt")));
    this.events = events;
  }

  isReady(): boolean {
    return this.ready;
  }

  connect(): void {
    if (this.userStop) return;
    this.ready = false;
    this.closedNotified = false;
    this.parser = new PacketParser();
    let ws: MqttSocketLike;
    try {
      ws = this.newSocket(this.url);
    } catch {
      this.notifyClose();
      return;
    }
    this.socket = ws;
    const connectTimer = setTimeout(() => {
      // broker too slow - bury the attempt; close handler does the rest
      try {
        ws.close();
      } catch {
        /* never opened */
      }
    }, this.opts.connectTimeoutMs);

    ws.on("open", () => {
      this.lastRx = Date.now();
      const keep = this.opts.keepAliveSec;
      const body = concat(
        str("MQTT"),
        Uint8Array.from([4, 0x02, keep >> 8, keep & 255]), // v3.1.1, clean session
        str(this.opts.clientId),
      );
      try {
        ws.send(packet(PT.CONNECT, 0, body));
      } catch {
        /* closing */
      }
    });
    ws.on("message", (data) => {
      this.lastRx = Date.now();
      let packets: DecodedPacket[];
      try {
        packets = this.parser.push(data);
      } catch {
        try {
          ws.close();
        } catch {
          /* already gone */
        }
        return;
      }
      for (const p of packets) this.handlePacket(p, ws, connectTimer);
    });
    ws.on("close", () => {
      clearTimeout(connectTimer);
      this.cleanup();
      this.notifyClose();
    });
    ws.on("error", () => {
      // the close event that follows owns the state transition
    });
  }

  private handlePacket(p: DecodedPacket, ws: MqttSocketLike, connectTimer: ReturnType<typeof setTimeout>): void {
    switch (p.type) {
      case PT.CONNACK: {
        clearTimeout(connectTimer);
        if (p.body.length < 2 || p.body[1] !== 0) {
          try {
            ws.close();
          } catch {
            /* refused */
          }
          return;
        }
        this.armPing();
        this.events.onConnect();
        break;
      }
      case PT.SUBACK: {
        if (p.body.length < 2) return;
        const pid = (p.body[0] << 8) | p.body[1];
        const resolve = this.pendingSubs.get(pid);
        if (resolve) {
          this.pendingSubs.delete(pid);
          resolve();
        }
        break;
      }
      case PT.PUBLISH: {
        // QoS0 only (we subscribe QoS0, so brokers downgrade for us); if a
        // broker still sends QoS1, skip the 2-byte packet id - we never PUBACK,
        // worst case the broker redelivers and the transport's dedupe eats it.
        if (p.body.length < 2) return;
        const tlen = (p.body[0] << 8) | p.body[1];
        const qos = (p.flags >> 1) & 3;
        const off = 2 + tlen + (qos > 0 ? 2 : 0);
        if (p.body.length < off) return;
        this.events.onMessage(td.decode(p.body.subarray(2, 2 + tlen)), p.body.subarray(off));
        break;
      }
      case PT.PINGRESP:
        break; // lastRx already updated - that is all a pong is for
      default:
        break; // PUBACK etc. - nothing we send needs them
    }
  }

  private armPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    const ms = this.opts.keepAliveSec * 1000;
    this.pingTimer = setInterval(() => {
      const ws = this.socket;
      if (!ws) return;
      // half-open mobile socket detector: no bytes for 1.5 keepalives and
      // we bury it ourselves instead of waiting for the OS to notice
      if (Date.now() - this.lastRx > ms * 1.5) {
        try {
          ws.close();
        } catch {
          /* already gone */
        }
        return;
      }
      try {
        ws.send(packet(PT.PINGREQ, 0, new Uint8Array(0)));
      } catch {
        /* closing */
      }
    }, ms);
  }

  /** Subscribe and resolve once ALL SUBACKs are in (or the socket dies). */
  subscribeAll(topics: string[]): Promise<void> {
    const ws = this.socket;
    if (!ws) return Promise.resolve();
    const parts: Uint8Array[] = [];
    const ids: number[] = [];
    for (const t of topics) {
      const pid = this.nextPacketId++ & 0xffff || 1;
      ids.push(pid);
      parts.push(Uint8Array.from([pid >> 8, pid & 255]), str(t), Uint8Array.from([0]));
    }
    const waits = ids.map(
      (pid) =>
        new Promise<void>((resolve) => {
          this.pendingSubs.set(pid, resolve);
        }),
    );
    try {
      // one SUBSCRIBE packet per topic keeps the encoder dead simple
      for (let i = 0; i < ids.length; i++) {
        ws.send(packet(PT.SUBSCRIBE, 0x2, concat(parts[i * 3], parts[i * 3 + 1], parts[i * 3 + 2])));
      }
    } catch {
      /* closing - close event resolves everything */
    }
    return Promise.all(waits).then(() => undefined);
  }

  /** Mark the session usable: called once CONNACK landed and subs acked. */
  markReady(): void {
    if (this.userStop) return;
    this.ready = true;
    this.events.onReady();
  }

  publish(topic: string, payload: Uint8Array): void {
    const ws = this.socket;
    if (!ws || !this.ready) return;
    try {
      ws.send(packet(PT.PUBLISH, 0, concat(str(topic), payload)));
    } catch {
      /* socket racing a close */
    }
  }

  private cleanup(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.socket = null;
    this.ready = false;
    // wake any subscribeAll waiters so nothing dangles across a reconnect
    const pending = [...this.pendingSubs.values()];
    this.pendingSubs.clear();
    for (const resolve of pending) resolve();
  }

  private notifyClose(): void {
    if (this.closedNotified) return;
    this.closedNotified = true;
    this.events.onClose();
  }

  stop(): void {
    this.userStop = true;
    const ws = this.socket;
    try {
      if (ws && this.ready) ws.send(packet(PT.DISCONNECT, 0, new Uint8Array(0)));
    } catch {
      /* closing */
    }
    try {
      ws?.close();
    } catch {
      /* already gone */
    }
    this.cleanup();
  }
}

// ===========================================================================
//  RELAY TRANSPORT OVER PUBLIC MQTT ROOMS
// ===========================================================================

/** Topics are scoped by chain id, so two networks can never cross-talk. */
const TOPIC_ROOT = `btwb/${CHAIN_ID}`;
const LOBBY_TOPIC = `${TOPIC_ROOT}/lobby`;
const INBOX_PREFIX = `${TOPIC_ROOT}/in/`;

/** Engine frames are small JSON strings; 768KB leaves absurd headroom. */
const MAX_PAYLOAD_BYTES = 768 * 1024;
/** Inbound message dedupe window (same frame arrives via several brokers). */
const DEDUPE_CAP = 512;
/** Presence announces: cadence, jitter and tombstone horizon. */
const ID_RE = /^m-[0-9a-f]{12}$/;

/**
 * Presence announce payload. This is OUR application-level envelope (not
 * the frozen consensus wire format): receivers ignore fields they do not
 * know, so tip metadata rolls out safely across a mixed-version mesh. `h`
 * is the announcer's chain tip height, `th` a short tip-hash prefix for
 * diagnostics. A peer announcing a HIGHER tip than ours is worth syncing
 * from - this is what wakes a stuck node when nobody is mining new blocks.
 */
export function encodeAnnounce(
  selfId: string,
  tip: { height: number; hash: string } | null,
): string {
  const m: Record<string, unknown> = { v: 1, t: "hi", id: selfId };
  if (tip && Number.isInteger(tip.height) && tip.height >= 0) {
    m.h = tip.height;
    if (typeof tip.hash === "string" && /^[0-9a-f]{64}$/.test(tip.hash)) {
      m.th = tip.hash.slice(0, 12);
    }
  }
  return JSON.stringify(m);
}

/** Parse a lobby payload; null when malformed. Older nodes omit h/th. */
export function decodeAnnounce(
  m: Record<string, unknown>,
): { id: string; height: number | null; tipHashPrefix: string | null } | null {
  if (m.t !== "hi" || typeof m.id !== "string" || !ID_RE.test(m.id)) return null;
  const h = m.h;
  const height =
    typeof h === "number" && Number.isInteger(h) && h >= 0 && h <= Number.MAX_SAFE_INTEGER
      ? h
      : null;
  const th = m.th;
  const tipHashPrefix = typeof th === "string" && /^[0-9a-f]{1,64}$/.test(th) ? th : null;
  return { id: m.id, height, tipHashPrefix };
}

export interface MqttRelayOptions {
  announceMs?: number;
  ttlMs?: number;
  sweepMs?: number;
  maxLinks?: number;
  rosterCap?: number;
  reconnectLadderMs?: number[];
  keepAliveSec?: number;
  connectTimeoutMs?: number;
  /** How long an engine close() mutes a peer before it may re-link. The
   *  engine drops links for transient reasons too (a challenge answer lost
   *  in flight is "no strike - a slow honest machine is not an attacker"),
   *  so the mute must EXPIRE: the peer re-links on a later announce and
   *  gets a fresh handshake. */
  muteMs?: number;
  newSocket?: (url: string) => MqttSocketLike;
}

interface RosterEntry {
  lastSeen: number;
  linked: boolean;
  /** Engine closed this link: presence refreshes keep it known but it is
   *  NOT re-surfaced until this timestamp passes (see muteMs). */
  mutedUntil: number;
}

interface BrokerConn {
  client: MiniMqttClient;
  ready: boolean;
  step: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Relay endpoints in effect for THIS session: the configured MQTT_RELAYS
 * plus the `?mqtt=wss://host/mqtt` URL override (comma-separates several) -
 * a rescue/debug hatch that never requires a redeploy. `?nomqtt=1` turns
 * the whole transport off (paired with `?nowebrtc=1` for isolation tests).
 */
export function mqttUrlsFromRuntime(): string[] {
  const urls = [...MQTT_RELAYS];
  if (typeof window !== "undefined") {
    const extra = new URLSearchParams(window.location.search).get("mqtt");
    if (extra) {
      for (const u of extra.split(",")) {
        const clean = u.trim();
        if (/^wss?:\/\//.test(clean) && !urls.includes(clean)) urls.push(clean);
      }
    }
  }
  return urls;
}

export class MqttRelayTransport implements Transport {
  readonly kind = "mqtt";
  readonly selfId: string;
  private urls: readonly string[];
  private opts: Required<Omit<MqttRelayOptions, "newSocket">>;
  private newSocket?: (url: string) => MqttSocketLike;
  private events: TransportEvents | null = null;
  private brokers: BrokerConn[] = [];
  private roster = new Map<string, RosterEntry>();
  private seen = new Set<string>();
  private seenQueue: string[] = [];
  private stopped = false;
  private announceTimer: ReturnType<typeof setTimeout> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  /** Latest tip the engine wants us to advertise (null: pre-chain boot). */
  private announcedTip: { height: number; hash: string } | null = null;

  setAnnouncedTip(tip: { height: number; hash: string }): void {
    this.announcedTip = tip;
  }

  constructor(urls: readonly string[], opts?: MqttRelayOptions) {
    this.urls = urls;
    this.selfId = randomPeerId("m");
    this.opts = {
      announceMs: opts?.announceMs ?? 15_000,
      ttlMs: opts?.ttlMs ?? 45_000,
      sweepMs: opts?.sweepMs ?? 5_000,
      maxLinks: opts?.maxLinks ?? 24,
      rosterCap: opts?.rosterCap ?? 256,
      reconnectLadderMs: opts?.reconnectLadderMs ?? [3_000, 8_000, 20_000, 60_000, 120_000],
      keepAliveSec: opts?.keepAliveSec ?? 30,
      connectTimeoutMs: opts?.connectTimeoutMs ?? 8_000,
      muteMs: opts?.muteMs ?? 60_000,
    };
    this.newSocket = opts?.newSocket;
  }

  /**
   * Like every transport here, start() never fails the node: an unreachable
   * broker arms its own reconnect ladder and keeps trying forever in the
   * background. The node meets the network on whichever broker answers first.
   */
  async start(events: TransportEvents): Promise<void> {
    this.events = events;
    if (this.urls.length === 0) return; // not configured - inert by design
    for (const url of this.urls) {
      const broker: BrokerConn = {
        client: this.makeClient(url, () => broker),
        ready: false,
        step: 0,
        timer: null,
      };
      this.brokers.push(broker);
      broker.client.connect();
    }
    this.scheduleAnnounce();
    this.sweepTimer = setInterval(() => this.sweep(), this.opts.sweepMs);
  }

  /** Build one broker session; `getBroker` resolves the owning BrokerConn
   *  lazily because the object literal needs the client first. */
  private makeClient(url: string, getBroker: () => BrokerConn): MiniMqttClient {
    return new MiniMqttClient(
      url,
      {
        clientId: `btwb-${this.selfId}-${Math.floor(Math.random() * 1e6)}`,
        keepAliveSec: this.opts.keepAliveSec,
        connectTimeoutMs: this.opts.connectTimeoutMs,
        newSocket: this.newSocket,
      },
      {
        onConnect: () => {
          // join the two rooms on every (re)connect, THEN mark ready
          const b = getBroker();
          void b.client
            .subscribeAll([LOBBY_TOPIC, `${INBOX_PREFIX}${this.selfId}`])
            .then(() => b.client.markReady());
        },
        onReady: () => {
          if (this.stopped) return;
          const b = getBroker();
          b.ready = true;
          b.step = 0;
          this.announceOn(b);
        },
        onMessage: (topic, payload) => this.handleMqtt(topic, payload),
        onClose: () => {
          const b = getBroker();
          b.ready = false;
          this.scheduleReconnect(b);
        },
      },
    );
  }

  private scheduleReconnect(b: BrokerConn): void {
    if (this.stopped || b.timer) return;
    const ladder = this.opts.reconnectLadderMs;
    const wait = ladder[Math.min(b.step, ladder.length - 1)];
    b.step += 1;
    b.timer = setTimeout(() => {
      b.timer = null;
      if (this.stopped) return;
      b.client = this.makeClient(b.client.url, () => b);
      b.client.connect();
    }, wait);
  }

  private scheduleAnnounce(): void {
    if (this.stopped) return;
    // jittered cadence: a hundred phones booting together must not thump
    // the public brokers in lockstep
    const jitter = 0.75 + Math.random() * 0.5;
    this.announceTimer = setTimeout(() => {
      this.announceTimer = null;
      for (const b of this.brokers) if (b.ready) this.announceOn(b);
      this.scheduleAnnounce();
    }, this.opts.announceMs * jitter);
  }

  private announceOn(b: BrokerConn): void {
    dbg("announce via", b.client.url);
    b.client.publish(LOBBY_TOPIC, utf8(encodeAnnounce(this.selfId, this.announcedTip)));
  }

  private handleMqtt(topic: string, payload: Uint8Array): void {
    if (this.stopped) return;
    if (payload.length > MAX_PAYLOAD_BYTES) return;
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(td.decode(payload)) as Record<string, unknown>;
    } catch {
      return;
    }
    if (!m || typeof m !== "object" || m.v !== 1) return;
    if (topic === LOBBY_TOPIC) {
      const ann = decodeAnnounce(m);
      if (!ann) return;
      if (ann.id === this.selfId) return; // brokers echo our own announce
      dbg("presence", ann.id);
      this.learn(ann.id);
      // Tip metadata is advisory: the engine cross-checks it against the
      // verified hello before acting on it.
      if (ann.height !== null) this.events?.onPeerTip?.(ann.id, ann.height, ann.tipHashPrefix);
      return;
    }
    if (topic === `${INBOX_PREFIX}${this.selfId}`) {
      if (m.t !== "m") return;
      const from = m.from;
      const to = m.to;
      const data = m.d;
      const nonce = m.n;
      if (typeof from !== "string" || !ID_RE.test(from)) return;
      if (to !== this.selfId) return;
      if (typeof data !== "string" || typeof nonce !== "string" || nonce.length > 24) return;
      // the same frame reaches us once per broker - deliver it once
      const key = `${from}:${nonce}`;
      if (this.seen.has(key)) return;
      this.seen.add(key);
      this.seenQueue.push(key);
      if (this.seenQueue.length > DEDUPE_CAP) {
        const old = this.seenQueue.shift();
        if (old) this.seen.delete(old);
      }
      // Implicit presence: a well-formed frame from a valid id proves the
      // sender is in the room - learn it BEFORE the linked-check, or a
      // handshake challenge that outruns the sender's first announce would
      // be lost and the link would die at the challenge deadline. (Muted
      // peers are not re-linked: learn() respects mutedUntil.)
      this.learn(from);
      // only linked ids may talk to the engine: a roster member the engine
      // closed cannot talk its way back in before the mute expires
      const linkedNow = this.roster.get(from)?.linked === true;
      dbg("inbound", frameLabel(data), "from", from, "linked:", linkedNow, "bytes:", data.length);
      if (linkedNow) this.events?.onMessage(from, data);
      return;
    }
  }

  /** Roster add/refresh: surface as an engine link while under the cap. */
  private learn(id: string): void {
    let entry = this.roster.get(id);
    if (!entry) {
      if (this.roster.size >= this.opts.rosterCap) return;
      entry = { lastSeen: 0, linked: false, mutedUntil: 0 };
      this.roster.set(id, entry);
    }
    entry.lastSeen = Date.now();
    if (entry.linked || entry.mutedUntil > Date.now()) return;
    if (this.linkedCount() >= this.opts.maxLinks) return;
    entry.linked = true;
    this.events?.onOpen(id);
  }

  /** Roster drop: report the link's death, then promote a waiting member. */
  private unlearn(id: string): void {
    const entry = this.roster.get(id);
    if (!entry) return;
    this.roster.delete(id);
    if (entry.linked) this.events?.onClose(id);
    for (const [nextId, next] of this.roster) {
      if (!next.linked && next.mutedUntil <= Date.now() && this.linkedCount() < this.opts.maxLinks) {
        next.linked = true;
        this.events?.onOpen(nextId);
      }
    }
  }

  /** Presence tombstone sweep: silent peers are forgotten, links reported. */
  private sweep(): void {
    if (this.stopped) return;
    const now = Date.now();
    for (const [id, entry] of [...this.roster]) {
      if (now - entry.lastSeen > this.opts.ttlMs) this.unlearn(id);
    }
  }

  private linkedCount(): number {
    let n = 0;
    for (const e of this.roster.values()) if (e.linked) n += 1;
    return n;
  }

  dial(): void {
    // No-op BY DESIGN: the room presence IS the link set - a relay cannot
    // dial ids it has not met (and ids learned from peer exchange belong
    // to other transports' namespaces).
  }

  send(peerId: string, data: string): void {
    if (!this.roster.get(peerId)?.linked) return;
    const ready = this.brokers.filter((b) => b.ready);
    if (ready.length === 0) return;
    // Fan the frame out to EVERY ready broker, not just one: MQTT QoS0 with
    // a clean session queues nothing, so a copy published on a broker the
    // peer has not finished joining (or has just lost) vanishes silently.
    // Boot-time readiness always differs between two nodes, and one shared
    // broker is all we can ever count on. All copies carry the SAME nonce,
    // so the receiver's dedupe collapses them back to exactly one delivery.
    const nonceBytes = new Uint8Array(6);
    crypto.getRandomValues(nonceBytes);
    const nonce = [...nonceBytes].map((x) => x.toString(16).padStart(2, "0")).join("");
    const payload = utf8(JSON.stringify({ v: 1, t: "m", from: this.selfId, to: peerId, d: data, n: nonce }));
    dbg("send", frameLabel(data), "to", peerId, "bytes:", data.length, "brokers:", ready.length);
    for (const b of ready) b.client.publish(`${INBOX_PREFIX}${peerId}`, payload);
  }

  close(peerId: string): void {
    dbg("engine closed", peerId, "- muted", this.opts.muteMs, "ms");
    // Engine-initiated teardown (peer cap, strikes, lost handshake): drop
    // the link and do NOT re-surface it on its very next announce, or the
    // engine's decision would flap every announce cadence. The mute is
    // TIMED, not permanent: the engine also drops links for transient
    // reasons (a challenge answer lost in flight earns no strike), so after
    // muteMs the peer becomes eligible again and gets a fresh handshake.
    const entry = this.roster.get(peerId);
    if (entry) {
      entry.linked = false;
      entry.mutedUntil = Date.now() + this.opts.muteMs;
    }
  }

  links(): string[] {
    return [...this.roster.entries()].filter(([, e]) => e.linked).map(([id]) => id);
  }

  stop(): void {
    this.stopped = true;
    if (this.announceTimer) clearTimeout(this.announceTimer);
    this.announceTimer = null;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    for (const b of this.brokers) {
      if (b.timer) clearTimeout(b.timer);
      b.timer = null;
      b.client.stop();
    }
    this.brokers = [];
    this.roster.clear();
    this.seen.clear();
    this.seenQueue = [];
  }
}
