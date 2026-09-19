# BitWeb Signaling Broker + Chain Relay + Seed Node

The browser network needs exactly ONE piece of always-on infrastructure.
This folder is that piece, in a single process on a single port:

1. **Signaling** (WebSocket path `/peerjs`): the PeerJS-compatible WebRTC
   rendezvous so tabs can find each other. It only exchanges connection
   offers; blocks flow directly browser-to-browser afterwards.
2. **Chain relay** (WebSocket path `/relay`): the last-resort transport for
   networks where WebRTC cannot pass at all (carrier-grade NAT, UDP blocked
   by the firewall). It forwards opaque, already-signed chain gossip between
   the tabs in one room - it can censor but never forge, and the WebRTC mesh
   keeps running in parallel.
3. **Seed node** (optional, `seed-node.mjs`): a tab that never closes, so
   the chain keeps moving when no user tab is open.

## Deploy the broker (Render, ~5 minutes, free)

1. Push this repo to your Git host.
2. Render dashboard -> **New -> Blueprint** -> select the repo.
   Render reads `broker/render.yaml` and builds `broker/Dockerfile`.
3. When it is live, copy its URL (`https://<name>.onrender.com`) and wire it
   into `../network.config.ts`, two one-line edits:
   - add `{ host: "<name>.onrender.com", port: 443, path: "/", secure: true }`
     as the FIRST entry of `SIGNALING_HOSTS` (the config ships with the
     public cloud only - your broker goes ABOVE it, the cloud stays as
     fallback);
   - add `"wss://<name>.onrender.com/relay"` to `RELAY_URLS` so devices
     behind hostile NATs still converge on one chain.
   Then redeploy the web app. That is the entire wiring.

Any Docker host works the same way:

```bash
cd broker
docker build -t bitweb-broker .
docker run -p 9000:9000 -e TRUST_PROXY=1 bitweb-broker
```

Plain Node works too:

```bash
cd broker
npm ci
PORT=9000 TRUST_PROXY=1 npm start
```

Verify any deployment: `npm run smoke` - it boots the broker and proves
BOTH services (a peer id from `/peerjs/id`, plus two relay clients meeting
in a room and exchanging a frame). Manual check: `curl https://<host>/healthz`
should answer `ok`.

Notes:
- Free Render sleeps when idle. Connected peers keep it awake; if it does
  sleep, new tabs fall through to the public cloud fallback in
  `SIGNALING_HOSTS` automatically - the network never partitions.
- TLS is terminated by the host; `TRUST_PROXY=1` is already set in
  `render.yaml`. Behind your own proxy (Caddy/Nginx), keep it on.
- The relay needs no extra port or TLS certificate: it shares the broker's
  HTTPS endpoint. Free-tier WebSocket time limits are handled by the
  client's reconnect ladder - a dropped relay socket re-joins its room in
  seconds, with the same id.

## Run the seed node (optional but recommended at launch)

A tab that never closes: fully synced, always mining, so the chain keeps
producing blocks even with zero users online.

```bash
cd broker
npm i puppeteer-core
export APP_URL=https://your-bitweb-app-url
node seed-node.mjs
```

- Chain data and wallet live in `./.seed-profile/` and survive restarts.
- To keep the same payout identity across reinstalls, set `SEED_PRIVKEY` to
  any 64-hex secret (the script prints a fresh one on first run).
- Runs anywhere Chromium runs: a VPS, a home server, a Raspberry Pi.
