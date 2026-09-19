// Smoke test: boot the broker on a scratch port, then prove BOTH services
// answer - the PeerJS handshake endpoint issues a fresh peer id, and the
// chain relay accepts a WebSocket, welcomes a hello, and routes a frame
// between two joined clients. Exits non-zero on any failure so CI / deploy
// checks can gate on it.
import { spawn } from "node:child_process";
import WebSocket from "ws";

const PORT = 19_900;
const child = spawn(process.execPath, ["server.js"], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});

let out = "";
child.stdout.on("data", (d) => (out += d));
child.stderr.on("data", (d) => (out += d));

const deadline = Date.now() + 20_000;
let signalingOk = false;
let relayOk = false;

async function relayCheck() {
  const url = (id) => `ws://127.0.0.1:${PORT}/relay`;
  const open = (ws) => new Promise((res, rej) => {
    ws.once("open", res);
    ws.once("error", rej);
  });
  const next = (ws, pred) =>
    new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error("relay frame timeout")), 5_000);
      ws.on("message", (raw) => {
        let m;
        try {
          m = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (pred(m)) {
          clearTimeout(timer);
          res(m);
        }
      });
    });
  const a = new WebSocket(url());
  const b = new WebSocket(url());
  await Promise.all([open(a), open(b)]);
  // b joins FIRST (empty room), then a joins: b must see a's "joined",
  // and a's welcome roster must already list b
  const bWelcome = next(b, (m) => m.t === "welcome" && m.roster.length === 0);
  b.send(JSON.stringify({ t: "hello", v: 1, room: "smoke-room", id: "smoke-b" }));
  await bWelcome;
  const aWelcome = next(a, (m) => m.t === "welcome" && m.roster.includes("smoke-b"));
  const bSeesJoin = next(b, (m) => m.t === "joined" && m.id === "smoke-a");
  a.send(JSON.stringify({ t: "hello", v: 1, room: "smoke-room", id: "smoke-a" }));
  await aWelcome;
  await bSeesJoin;
  const bGetsMsg = next(b, (m) => m.t === "msg" && m.from === "smoke-a" && m.data === "ping-payload");
  a.send(JSON.stringify({ t: "msg", to: "smoke-b", data: "ping-payload" }));
  await bGetsMsg;
  const aGetsPong = next(a, (m) => m.t === "pong");
  a.send(JSON.stringify({ t: "ping" }));
  await aGetsPong;
  a.close();
  b.close();
}

try {
  while (Date.now() < deadline && !signalingOk) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/peerjs/id?ts=${Date.now()}`);
      if (res.ok) {
        const id = (await res.text()).trim();
        if (/^[a-z0-9-]{16,64}$/i.test(id)) {
          signalingOk = true;
          console.log(`smoke: broker issued peer id ${id}`);
        }
      }
    } catch {
      // not up yet - retry
    }
    if (!signalingOk) await new Promise((r) => setTimeout(r, 400));
  }
  if (signalingOk) {
    try {
      const health = await fetch(`http://127.0.0.1:${PORT}/healthz`);
      if (health.ok) console.log("smoke: /healthz answers ok");
    } catch {
      /* optional probe */
    }
    await relayCheck();
    relayOk = true;
    console.log("smoke: relay joined two clients and routed a frame");
  }
} catch (err) {
  console.error("smoke: relay check failed:", err);
} finally {
  child.kill("SIGTERM");
}

if (!signalingOk) {
  console.error("smoke: broker did not answer /peerjs/id in time");
  console.error(out);
  process.exit(1);
}
if (!relayOk) {
  console.error("smoke: relay check failed");
  console.error(out);
  process.exit(1);
}
console.log("smoke: OK");
