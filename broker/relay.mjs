/**
 * ===========================================================================
 *  BITWEB MAINNET - CHAIN RELAY (last-resort transport)
 * ===========================================================================
 *  WebRTC is peer-to-peer, which is exactly why it can fail: carrier-grade
 *  NAT, firewalls that kill UDP, networks where even TURN is blocked. A
 *  plain WebSocket goes anywhere HTTPS goes. This relay is the transport of
 *  last resort: it forwards opaque chain frames between the tabs in one
 *  room, so two phones on two mobile carriers still converge on ONE chain.
 *
 *  What the relay can and cannot do:
 *  - It sees ONLY public chain gossip (blocks, transfers, hellos) - wallets
 *    and keys never leave the browser. It is a liveness dependency, never
 *    an integrity one: every frame is validated by the receiving node, so a
 *    hostile relay can censor but cannot forge. Censorship is cured by the
 *    other transports (WebRTC, same-browser mesh) running in parallel.
 *  - Rooms are scoped by the lobby prefix; ids are the nodes' relay ids.
 *
 *  Protocol (JSON, one object per frame):
 *    client -> { t:"hello", v:1, room, id }   first frame, joins the room
 *    server -> { t:"welcome", id, roster }    full roster after join
 *    server -> { t:"joined", id } / { t:"left", id }   roster deltas
 *    client -> { t:"msg", to, data }          routed inside the room
 *    server -> { t:"msg", from, data }
 *    client -> { t:"ping" }  server -> { t:"pong" }   app-level keepalive
 *    server -> { t:"error", code }            then closes
 *
 *  Safety rails: frame cap, per-socket rate cap, room cap, zombie-id
 *  takeover, and a ping sweep that buries silently dead sockets.
 * ===========================================================================
 */
import { WebSocketServer } from "ws";

const FRAME_CAP = 512 * 1024; // one frame, bytes - far above any sync batch
const RATE_WINDOW_MS = 10_000;
const RATE_MAX = 240; // frames per window per socket (gossip bursts included)
const ROOM_CAP = 256; // members per room; the mesh needs only a few links
const MAX_ROOMS = 64;
const ID_RE = /^[A-Za-z0-9_-]{4,80}$/;
const SWEEP_MS = 30_000; // dead-socket burial cadence

function send(ws, obj) {
  try {
    if (ws.readyState === 1) ws.send(JSON.stringify(obj));
  } catch {
    /* socket racing a close */
  }
}

/**
 * Attach the relay to an existing HTTP server. Other upgrade listeners
 * (PeerJS signaling) keep their own paths - we only touch `path`.
 *
 * @param {import("node:http").Server} server
 * @param {{ path?: string, onLog?: (line: string) => void, manualUpgrade?: boolean }} [opts]
 *   manualUpgrade: do NOT attach an upgrade listener - the caller routes
 *   upgrades to `wss.handleUpgrade` itself (required when the HTTP server
 *   also carries PeerJS signaling, whose ws listener kills foreign paths).
 */
export function attachRelay(server, opts = {}) {
  const path = opts.path ?? "/relay";
  const log = opts.onLog ?? ((line) => console.log(line));
  const wss = new WebSocketServer({ noServer: true, maxPayload: FRAME_CAP });
  /** @type {Map<string, Map<string, import("ws").WebSocket>>} */
  const rooms = new Map();

  if (!opts.manualUpgrade) {
    server.on("upgrade", (req, socket, head) => {
      let pathname;
      try {
        pathname = new URL(req.url ?? "/", "http://relay.local").pathname;
      } catch {
        socket.destroy();
        return;
      }
      if (pathname !== path) return; // not ours - leave the socket alone
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    });
  }

  wss.on("connection", (ws) => {
    ws.bitweb = { room: null, id: null, alive: true, sent: 0, windowStart: Date.now() };
    ws.on("pong", () => {
      if (ws.bitweb) ws.bitweb.alive = true;
    });
    ws.on("message", (raw) => {
      const st = ws.bitweb;
      if (!st) return;
      // token bucket: shed load instead of letting one socket drown a room
      const now = Date.now();
      if (now - st.windowStart > RATE_WINDOW_MS) {
        st.windowStart = now;
        st.sent = 0;
      }
      st.sent += 1;
      if (st.sent > RATE_MAX) return;
      if (raw.length > FRAME_CAP) return;
      let m;
      try {
        m = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!m || typeof m !== "object") return;

      if (!st.id) {
        // first frame must be a well-formed hello
        if (
          m.t !== "hello" ||
          m.v !== 1 ||
          typeof m.room !== "string" ||
          typeof m.id !== "string" ||
          !ID_RE.test(m.room) ||
          !ID_RE.test(m.id)
        ) {
          send(ws, { t: "error", code: "bad-hello" });
          ws.close();
          return;
        }
        let room = rooms.get(m.room);
        if (!room) {
          if (rooms.size >= MAX_ROOMS) {
            send(ws, { t: "error", code: "rooms-full" });
            ws.close();
            return;
          }
          room = new Map();
          rooms.set(m.room, room);
        }
        // zombie takeover: a reconnected node reclaims its id; the stale
        // socket is buried so the roster never lies
        const old = room.get(m.id);
        if (old && old !== ws) {
          const oldState = old.bitweb;
          if (oldState) oldState.id = null; // the close handler must not evict US
          send(old, { t: "error", code: "replaced" });
          old.close();
          room.delete(m.id);
        }
        if (room.size >= ROOM_CAP) {
          send(ws, { t: "error", code: "room-full" });
          ws.close();
          return;
        }
        room.set(m.id, ws);
        st.room = m.room;
        st.id = m.id;
        send(ws, { t: "welcome", id: m.id, roster: [...room.keys()].filter((k) => k !== m.id) });
        for (const [pid, sock] of room) {
          if (pid !== m.id) send(sock, { t: "joined", id: m.id });
        }
        log(`[relay] + ${m.id} (${m.room}: ${room.size} nodes)`);
        return;
      }

      if (m.t === "ping") {
        send(ws, { t: "pong" });
        return;
      }
      if (
        m.t === "msg" &&
        typeof m.to === "string" &&
        typeof m.data === "string" &&
        m.data.length <= FRAME_CAP
      ) {
        const target = rooms.get(st.room)?.get(m.to);
        if (target) send(target, { t: "msg", from: st.id, data: m.data });
      }
    });
    ws.on("close", () => {
      const st = ws.bitweb;
      if (!st || !st.room || !st.id) return;
      const room = rooms.get(st.room);
      if (room?.get(st.id) === ws) {
        room.delete(st.id);
        for (const sock of room.values()) send(sock, { t: "left", id: st.id });
        if (room.size === 0) rooms.delete(st.room);
        log(`[relay] - ${st.id}`);
      }
      st.id = null;
    });
  });

  // ping sweep: ws-level pings bury sockets that died without a close frame
  // (the classic half-open mobile connection)
  const sweep = setInterval(() => {
    for (const ws of wss.clients) {
      const st = ws.bitweb;
      if (st && !st.alive) {
        ws.terminate();
        continue;
      }
      if (st) st.alive = false;
      try {
        ws.ping();
      } catch {
        /* already gone */
      }
    }
  }, SWEEP_MS);
  sweep.unref?.();

  return {
    wss,
    rooms,
    path,
    close() {
      clearInterval(sweep);
      for (const c of wss.clients) c.terminate();
      wss.close();
    },
  };
}
