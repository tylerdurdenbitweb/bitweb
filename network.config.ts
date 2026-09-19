// ===========================================================================
//  BITWEB MAINNET (BROWSER EDITION) - NETWORK CONFIGURATION
// ---------------------------------------------------------------------------
//  THIS IS THE ONLY FILE YOU EVER NEED TO EDIT TO POINT THE NETWORK
//  SOMEWHERE ELSE. Everything else adapts automatically.
//
//  -- HOW IT WORKS ---------------------------------------------------------
//  - There is NO application server. Every browser tab is a full node. Tabs
//    find each other through a WebRTC signaling rendezvous - signaling only
//    exchanges connection offers; the blockchain data itself flows directly
//    browser-to-browser over DataChannels.
//  - SIGNALING_HOSTS is an ORDERED FALLBACK LIST: boot walks it top-down,
//    claiming a lobby slot on the first reachable host. One dead rendezvous
//    can no longer strand new nodes off the mesh.
//  - LOBBY_PREFIX scopes the rendezvous: nodes only ever meet other tabs
//    using the same prefix. Change it and you run your own parallel network
//    with the same genesis (same chain id still applies on the wire).
//  - SEED_PEER_IDS pins preferred peers (rendezvous ids) tried first on
//    boot - the browser-edition equivalent of bootstrap seeds. The official
//    always-on seed (broker/seed-node.mjs) needs no pin here: it holds a
//    lobby slot 24/7, and every boot probes the whole primary lobby anyway.
//  - Offline peers are NEVER punished - only peers that send invalid data
//    earn strikes (3 strikes = dropped).
//
//  -- SELF-HOSTED RENDEZVOUS -------------------------------------------------
//  The repo ships its own signaling broker in broker/ (one-command deploy
//  on any free tier). It is intentionally NOT listed below until a real
//  deployment exists: a placeholder entry costs every boot a failed probe
//  and, worse, a slot namespace nobody else is on. When you deploy broker/,
//  add your host ABOVE the public cloud - that one-line edit is the whole
//  operation. The cloud stays listed as fallback so a broker hiccup can
//  never partition the network.
// ---------------------------------------------------------------------------

/** One PeerJS-compatible signaling endpoint. */
export interface SignalingHost {
  host: string;
  port: number;
  path: string;
  secure: boolean;
}

/**
 * Ordered signaling fallbacks. The default entry is the public PeerJS
 * cloud; add your own broker ABOVE or BELOW it - boot tries each host in
 * order and sticks to the first one that answers. Hosts that are down are
 * detected fast (first failed probe) and skipped, so a long list costs a
 * dead host ~one probe each, not a stall.
 */
export const SIGNALING_HOSTS: readonly SignalingHost[] = [
  // The public PeerJS-compatible cloud. When you deploy the project's own
  // broker (broker/), add it ABOVE this line: { host: "your-host", port: 443,
  // path: "/", secure: true } - boot then prefers it and keeps the cloud as
  // fallback. Until then the cloud is the single rendezvous, so every device
  // on earth meets in the same slot namespace.
  { host: "0.peerjs.com", port: 443, path: "/", secure: true },
] as const;

/** Lobby scope + slot range: a tab claims the first free id
 *  `${LOBBY_PREFIX}-slot-N` and probes the rest to find peers. */
export const LOBBY_PREFIX = "btwb-mainnet1";
export const LOBBY_SLOTS = 64;

/**
 * Overflow range above the primary lobby: when all primary slots are taken,
 * new tabs claim ids in slot-64 .. slot-(64+LOBBY_EXTENDED_SLOTS-1) and this
 * build sweeps that range on a rotating window (a few ids per minute, so a
 * quiet network pays nothing). Older builds only probe the primary range, so
 * extended-slot nodes lean on peer exchange until found - acceptable, because
 * a full primary lobby means the mesh is big and gossip is rich. Slot ids are
 * per-broker namespaces: the same slot number on two SIGNALING_HOSTS entries
 * is two different peers.
 */
export const LOBBY_EXTENDED_SLOTS = 192; // total addressable lobby = 256 ids

/** Preferred peers (rendezvous ids) contacted first on every boot. Empty:
 *  discovery runs through the lobby slots; the official seed node sits in
 *  the primary lobby around the clock. */
export const SEED_PEER_IDS: readonly string[] = [];

/** Same-browser tab mesh (BroadcastChannel) stays ON even when WebRTC is up:
 *  tabs of the same browser always see each other, which also powers the
 *  two-tab simulation tests. Set false to disable. */
export const LOCAL_TAB_MESH = true;

/**
 * Chain relay endpoints (WebSocket URLs, path included) - the LAST-RESORT
 * transport for networks where WebRTC cannot pass at all (carrier-grade
 * NAT, UDP blocked by the firewall). A plain WebSocket goes anywhere HTTPS
 * goes, so a relay room carries chain gossip between tabs that could never
 * open a direct DataChannel. The relay only forwards already-signed public
 * chain frames: it can censor but never forge, and the WebRTC mesh keeps
 * running in parallel, so it is a liveness dependency, never an integrity
 * one. Default is EMPTY on purpose: a relay only exists once you deploy
 * broker/ (it serves /relay on the same port as signaling). After
 * deploying, add e.g. "wss://your-broker-host/relay" here - one line, like
 * SIGNALING_HOSTS. A single session can also be pointed at a relay with
 * the ?relay=wss://host/relay URL parameter (comma separates several), a
 * rescue/debug hatch that never requires a redeploy.
 */
export const RELAY_URLS: readonly string[] = [] as const;

/**
 * Public MQTT broker rooms (WebSocket URLs, path included) - the
 * ZERO-CONFIG common meeting point, ON BY DEFAULT. Every device on earth
 * subscribes to the same two topics (`btwb/<chain-id>/lobby` for presence,
 * `btwb/<chain-id>/in/<id>` for direct frames) on these free public
 * brokers, so any two browsers that can reach the open internet at all
 * can see each other and sync one chain - even when carrier-grade NAT or
 * a UDP-blocking firewall makes a direct WebRTC channel impossible. MQTT
 * over WebSocket rides port 443 with TLS, anywhere HTTPS goes.
 *
 * Trust model: brokers see ONLY already-signed public chain frames
 * (blocks, transfers, hellos) - wallets and keys never leave the browser,
 * and the receiving node validates everything. The node connects to EVERY
 * broker listed here at once (plus WebRTC and the same-browser mesh in
 * parallel), so no single broker going down - or censoring - can
 * partition the network. These entries are free community infrastructure
 * operated for the public by their respective projects; traffic is a few
 * tiny JSON frames per minute per node.
 *
 * A session can add brokers with the ?mqtt=wss://host/mqtt URL parameter
 * (comma separates several), or disable the whole transport with
 * ?nomqtt=1 - debug/rescue hatches that never require a redeploy.
 */
export const MQTT_RELAYS: readonly string[] = [
  "wss://broker.emqx.io:8084/mqtt",
  "wss://broker.hivemq.com:8884/mqtt",
] as const;

/** Minimal ICE server shape (mirrors RTCIceServer without the DOM lib). */
export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/**
 * WebRTC connectivity kit. Signaling finds the peer; ICE is what actually
 * opens the DataChannel. STUN alone fails between mobile carrier NATs
 * (symmetric NAT), which is exactly where "two devices each mine their own
 * chain" comes from - they signal fine but can never connect. The TURN
 * relays below are the free public OpenRelay endpoints: they relay the
 * media path when a direct route does not exist. They are best-effort
 * public infrastructure, not a promise - for full control, self-host a
 * coturn server and add it at the TOP of this list (same one-line edit).
 * The credentials shown are OpenRelay's published public ones; a TURN
 * credential only authorizes relaying, it protects no user data.
 */
export const ICE_SERVERS: readonly IceServer[] = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun.relay.metered.ca:80"] },
  {
    urls: "turn:standard.relay.metered.ca:80",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
  {
    urls: "turn:standard.relay.metered.ca:443",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
  {
    urls: "turns:standard.relay.metered.ca:443?transport=tcp",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
] as const;
