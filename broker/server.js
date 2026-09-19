/**
 * ===========================================================================
 *  BITWEB MAINNET - SIGNALING BROKER + CHAIN RELAY
 * ===========================================================================
 *  ONE process, ONE port, TWO rendezvous services:
 *
 *  1. PeerJS-compatible WebRTC signaling (WebSocket path /peerjs):
 *     introduces browser tabs so they can open direct DataChannels. It
 *     never sees chain data.
 *  2. Chain relay (WebSocket path /relay): forwards opaque chain gossip
 *     between tabs when a direct WebRTC route does not exist (carrier NAT,
 *     UDP-blocking firewalls). It sees only public, already-signed chain
 *     frames - it can censor but never forge, and the other transports
 *     keep running in parallel.
 *
 *  If this process dies, tabs already on the mesh keep running and new
 *  tabs fall through to the next entry in SIGNALING_HOSTS / RELAY_URLS.
 *
 *  Upgrade routing is done BY HAND (both WebSocket endpoints run in
 *  noServer mode): the ws library destroys sockets on paths it does not
 *  own, so two path-scoped servers can never share one HTTP server's
 *  upgrade event directly.
 *
 *  Environment:
 *    PORT            listen port (default 9000; Render/Fly inject it)
 *    TRUST_PROXY     "1" when behind a TLS-terminating proxy (Render, Fly,
 *                    Caddy, Nginx) so rate limits see real client IPs
 * ===========================================================================
 */
"use strict";

const express = require("express");
const http = require("node:http");
const { ExpressPeerServer } = require("peer");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT || 9000);
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const SIGNALING_PATH = "/peerjs"; // what PeerJS builds from config path "/"
const RELAY_PATH = "/relay";

async function main() {
  const server = http.createServer();

  // WebRTC signaling. Two details matter here:
  //  - ExpressPeerServer only wires its routes when its "mount" event
  //    fires, so it must be mounted on a real express app (app.use), not
  //    called as a bare request listener.
  //  - The createWebSocketServer hook swaps PeerJS's path-scoped socket
  //    server for a noServer one - WE route upgrades to it, so it can no
  //    longer kill the relay's sockets (and vice versa).
  let signalingWss = null;
  const peerApp = ExpressPeerServer(server, {
    path: "/",
    proxied: TRUST_PROXY,
    allow_discovery: true,
    alive_timeout: 60_000,
    createWebSocketServer: () => {
      signalingWss = new WebSocketServer({ noServer: true });
      return signalingWss;
    },
  });
  const app = express();
  app.get("/healthz", (_req, res) => {
    // Cheap liveness probe for the host (Render health checks, uptime bots).
    res.type("text/plain").send("ok");
  });
  app.use("/", peerApp);
  server.on("request", app);

  // Chain relay (same noServer pattern - attachRelay only wires the logic).
  const { attachRelay } = await import("./relay.mjs");
  const relay = attachRelay(server, { path: RELAY_PATH, manualUpgrade: true });

  server.on("upgrade", (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url ?? "/", "http://broker.local").pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname === RELAY_PATH) {
      relay.wss.handleUpgrade(req, socket, head, (ws) => relay.wss.emit("connection", ws, req));
      return;
    }
    if (pathname === SIGNALING_PATH && signalingWss) {
      signalingWss.handleUpgrade(req, socket, head, (ws) => signalingWss.emit("connection", ws, req));
      return;
    }
    socket.destroy();
  });

  server.listen(PORT, () => {
    console.log(
      `[broker] BitWeb signaling + relay listening on :${PORT} (signaling ${SIGNALING_PATH}, relay ${RELAY_PATH}, proxied=${TRUST_PROXY})`,
    );
  });
}

main().catch((err) => {
  console.error("[broker] fatal:", err);
  process.exit(1);
});
