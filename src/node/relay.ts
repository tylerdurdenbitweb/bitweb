/**
 * WsRelayTransport - the last-resort wire that works where WebRTC cannot.
 *
 * WebRTC is peer-to-peer, which is exactly why whole classes of networks
 * break it: carrier-grade NAT on mobile, firewalls that kill UDP, proxies
 * that only pass HTTPS. A plain WebSocket goes anywhere HTTPS goes, so a
 * relay room (broker/relay.mjs) forwards opaque chain gossip between the
 * tabs that joined it. Two phones on two carriers converge on ONE chain.
 *
 * Trust model: the relay sees ONLY already-signed public chain frames
 * (blocks, transfers, hellos) - wallets and keys never leave the browser.
 * Every frame is still validated by the receiving node, so the relay is a
 * LIVENESS dependency, never an integrity one; the WebRTC and same-browser
 * transports keep running in parallel, so a censoring relay cannot isolate
 * a node either.
 *
 * The link model mirrors BroadcastTransport: room membership is the link
 * set (no dial), messages are unicast by id through the server. Relay ids
 * live in their own namespace (`<room>-r-<hex>`) so a node reachable over
 * BOTH WebRTC and relay simply appears as two independent engine peers -
 * redundant paths, never a doubled identity.
 */
import { LOBBY_PREFIX, RELAY_URLS } from "../../network.config";
import { randomPeerId, type Transport, type TransportEvents } from "./transport";

/** Minimal socket surface - the browser WebSocket and the ws package both
 *  map onto it, so tests run the real protocol against a real server. */
export interface RelaySocket {
  on(event: "open" | "close" | "error", cb: () => void): void;
  on(event: "message", cb: (data: string) => void): void;
  send(data: string): void;
  close(): void;
}

export interface RelayTransportOptions {
  /** Reconnect ladder after a dropped socket; the last rung repeats. */
  reconnectLadderMs?: number[];
  /** App-level keepalive cadence (also the dead-socket detector). */
  heartbeatMs?: number;
  /** How long one connect attempt may take before trying the next URL. */
  openTimeoutMs?: number;
  /** Virtual links surfaced to the engine at most (roster can be bigger). */
  maxLinks?: number;
  /** Socket factory - tests inject one backed by the ws package. */
  newSocket?: (url: string) => RelaySocket;
}

interface RosterEntry {
  linked: boolean;
}

/** Adapt the browser's native WebSocket onto the tiny RelaySocket shape. */
function wrapNativeWebSocket(ws: WebSocket): RelaySocket {
  return {
    on(event, cb) {
      if (event === "message") {
        ws.addEventListener("message", (e: MessageEvent) => {
          if (typeof e.data === "string") cb(e.data);
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

/**
 * Relay endpoints in effect for THIS session: the configured RELAY_URLS
 * plus the `?relay=wss://host/relay` URL override (comma-separates several)
 * - a rescue/debug hatch: point any session at a relay without redeploying.
 */
export function relayUrlsFromRuntime(): string[] {
  const urls = [...RELAY_URLS];
  if (typeof window !== "undefined") {
    const extra = new URLSearchParams(window.location.search).get("relay");
    if (extra) {
      for (const u of extra.split(",")) {
        const clean = u.trim();
        if (/^wss?:\/\//.test(clean) && !urls.includes(clean)) urls.push(clean);
      }
    }
  }
  return urls;
}

export class WsRelayTransport implements Transport {
  readonly kind = "relay";
  readonly selfId: string;
  private urls: readonly string[];
  private room: string;
  private opts: Required<Omit<RelayTransportOptions, "newSocket">>;
  private newSocket: (url: string) => RelaySocket;
  private events: TransportEvents | null = null;
  private socket: RelaySocket | null = null;
  /** Insertion-ordered room roster; `linked` = surfaced to the engine. */
  private roster = new Map<string, RosterEntry>();
  private stopped = false;
  private connected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectStep = 0;
  private urlCursor = 0;
  private lastSeen = 0;

  constructor(urls: readonly string[], room: string = LOBBY_PREFIX, opts?: RelayTransportOptions) {
    this.urls = urls;
    this.room = room;
    this.selfId = randomPeerId(`${room}-r`);
    this.opts = {
      reconnectLadderMs: opts?.reconnectLadderMs ?? [2_000, 5_000, 15_000, 30_000, 60_000],
      heartbeatMs: opts?.heartbeatMs ?? 25_000,
      openTimeoutMs: opts?.openTimeoutMs ?? 8_000,
      maxLinks: opts?.maxLinks ?? 24,
    };
    this.newSocket =
      opts?.newSocket ?? ((url: string) => wrapNativeWebSocket(new WebSocket(url)));
  }

  /**
   * Like the WebRTC transport, start() never fails the node: a relay that
   * is unreachable right now arms the reconnect ladder and keeps trying
   * forever in the background.
   */
  async start(events: TransportEvents): Promise<void> {
    this.events = events;
    if (this.urls.length === 0) return; // not configured - inert by design
    this.connect();
    this.heartbeatTimer = setInterval(() => this.heartbeatTick(), this.opts.heartbeatMs);
  }

  private connect(): void {
    if (this.stopped) return;
    const url = this.urls[this.urlCursor % this.urls.length];
    this.urlCursor += 1;
    const ws = this.newSocket(url);
    this.socket = ws;
    let settled = false;
    // a connect attempt that neither opens nor errors within the window is
    // a dead URL - close it so the close handler advances the ladder
    const openTimer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try {
          ws.close();
        } catch {
          /* never opened */
        }
      }
    }, this.opts.openTimeoutMs);

    ws.on("open", () => {
      this.lastSeen = Date.now();
      ws.send(JSON.stringify({ t: "hello", v: 1, room: this.room, id: this.selfId }));
    });
    ws.on("message", (data) => {
      this.lastSeen = Date.now();
      let m: { t?: string } | null = null;
      try {
        m = JSON.parse(data) as { t?: string };
      } catch {
        return;
      }
      if (!m || typeof m !== "object") return;
      switch (m.t) {
        case "welcome": {
          settled = true;
          clearTimeout(openTimer);
          this.connected = true;
          this.reconnectStep = 0;
          const ids = (m as { roster?: unknown }).roster;
          if (Array.isArray(ids)) {
            for (const id of ids) if (typeof id === "string" && id !== this.selfId) this.learn(id);
          }
          break;
        }
        case "joined": {
          const id = (m as { id?: unknown }).id;
          if (typeof id === "string" && id !== this.selfId) this.learn(id);
          break;
        }
        case "left": {
          const id = (m as { id?: unknown }).id;
          if (typeof id === "string") this.unlearn(id);
          break;
        }
        case "msg": {
          const from = (m as { from?: unknown }).from;
          const payload = (m as { data?: unknown }).data;
          if (typeof from !== "string" || typeof payload !== "string") return;
          // only linked ids may talk to the engine: a roster member the
          // engine closed (peer cap) cannot talk its way back in
          if (this.roster.get(from)?.linked) this.events?.onMessage(from, payload);
          break;
        }
        case "pong":
          break; // lastSeen already updated - that is all a pong is for
        case "error":
          // room-full / replaced / bad-hello: the close that follows moves
          // us to the next URL or the next ladder rung - nothing to do here
          break;
      }
    });
    ws.on("close", () => {
      clearTimeout(openTimer);
      if (this.socket === ws) this.socket = null;
      if (this.stopped) return;
      this.dropAllLinks();
      this.connected = false;
      this.scheduleReconnect();
    });
    ws.on("error", () => {
      // the close event that follows owns the state transition
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const ladder = this.opts.reconnectLadderMs;
    const wait = ladder[Math.min(this.reconnectStep, ladder.length - 1)];
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, wait);
  }

  /**
   * Keepalive + dead-socket detection. A half-open mobile socket (the
   * classic: phone switches networks, the old TCP stream hangs forever)
   * stops answering app-level pings - two missed windows and we bury it
   * ourselves instead of waiting for the OS.
   */
  private heartbeatTick(): void {
    if (this.stopped) return;
    const ws = this.socket;
    if (!ws || !this.connected) return;
    if (Date.now() - this.lastSeen > this.opts.heartbeatMs * 2.5) {
      try {
        ws.close();
      } catch {
        /* already gone */
      }
      return;
    }
    try {
      ws.send(JSON.stringify({ t: "ping" }));
    } catch {
      /* closing */
    }
  }

  /** Roster add: surface as an engine link while under the link cap. */
  private learn(id: string): void {
    let entry = this.roster.get(id);
    if (!entry) {
      entry = { linked: false };
      this.roster.set(id, entry);
    }
    if (entry.linked) return;
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
    // backfill: a waiting roster member takes the freed link slot
    for (const [nextId, next] of this.roster) {
      if (!next.linked && this.linkedCount() < this.opts.maxLinks) {
        next.linked = true;
        this.events?.onOpen(nextId);
      }
    }
  }

  private dropAllLinks(): void {
    const linked = [...this.roster.entries()].filter(([, e]) => e.linked).map(([id]) => id);
    this.roster.clear();
    for (const id of linked) this.events?.onClose(id);
  }

  private linkedCount(): number {
    let n = 0;
    for (const e of this.roster.values()) if (e.linked) n += 1;
    return n;
  }

  dial(): void {
    // No-op BY DESIGN: the room roster IS the link set - a relay cannot
    // dial ids it has not met (and ids learned from peer exchange belong
    // to other transports' namespaces).
  }

  send(peerId: string, data: string): void {
    const ws = this.socket;
    if (!ws || !this.connected) return;
    if (!this.roster.get(peerId)?.linked) return;
    try {
      ws.send(JSON.stringify({ t: "msg", to: peerId, data }));
    } catch {
      /* socket racing a close */
    }
  }

  close(peerId: string): void {
    // Engine-initiated teardown (peer cap, strikes): drop the link without
    // forgetting the room member entirely - it stays eligible for backfill.
    const entry = this.roster.get(peerId);
    if (entry) entry.linked = false;
  }

  links(): string[] {
    return [...this.roster.entries()].filter(([, e]) => e.linked).map(([id]) => id);
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    const ws = this.socket;
    this.socket = null;
    try {
      ws?.close();
    } catch {
      /* already gone */
    }
    this.roster.clear();
  }
}
