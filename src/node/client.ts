/**
 * Node client - boots the in-browser full node and exposes the exact API
 * surface the UI (and the miner hook) consumes. This is the browser twin of
 * the server version's tRPC chain router: same method names, same shapes.
 *
 * There is no HTTP anywhere. `sendTx` validates + gossips; `template` /
 * `submitBlock` feed the Web Worker miner; every read hits local storage.
 *
 * Tests build several independent nodes in one process by importing this
 * module freshly per node (vi.resetModules), each with its own storage and
 * its own BroadcastChannel transport - the two-tab simulation.
 */
import { hydrateWallet, loadWallet } from "@/lib/bitweb";
import {
  admitTransfer,
  assertExportCarriesNoSecrets,
  buildTemplate,
  exportChain,
  getAddressOverview,
  getInfo,
  getMempool,
  getRecentBlocks,
  getRecentTxs,
  getTipSummary,
  importChain,
  initChain,
  pruneConfirmedTxsBelow,
  submitBlock,
  type ChainExport,
  type TemplateView,
} from "./chain";
export { ChainConflictError, ChainDowngradeError } from "./chain";
import { IdbStorage } from "./idb";
import { MemoryStorage } from "./storage";
import { P2pEngine, type PeerView } from "./p2p";
import type { ChainStorage } from "./storage";
import { BroadcastTransport, PeerJsTransport, type Transport } from "./transport";
import { WsRelayTransport, relayUrlsFromRuntime } from "./relay";
import { MqttRelayTransport, mqttUrlsFromRuntime } from "./mqtt";
import { getNetStats } from "./stats";
import { beginChainUpdate, setChainGateDetail } from "./chain-gate";
import { MAX_PEERS } from "@contracts/wire";
import { MAX_MEMPOOL_TXS } from "@contracts/protocol";
import { LOCAL_TAB_MESH } from "../../network.config";
import type { TransferInput } from "./blockchain";

export interface BootOptions {
  /** Inject storage (tests: MemoryStorage). Default: real IndexedDB. */
  storage?: ChainStorage;
  /** Inject transports (tests: one BroadcastTransport). Default: mesh + WebRTC. */
  transports?: Transport[];
  /** Try the PeerJS/WebRTC transport. Default true; tests pass false. */
  webRtc?: boolean;
  /** Relay endpoints; default: RELAY_URLS + the ?relay= URL override. */
  relayUrls?: readonly string[];
  /** MQTT broker rooms; default: MQTT_RELAYS + the ?mqtt= URL override. */
  mqttUrls?: readonly string[];
  /** Called whenever the peer roster changes. */
  onPeerChange?: () => void;
}

export interface NodeHandle {
  storage: ChainStorage;
  engine: P2pEngine;
  transports: Transport[];
  /** "persistent" (IndexedDB) or "memory" (storage blocked - session-only). */
  storageMode: "persistent" | "memory";
  stop(): void;

  // -- the API surface (mirror of the server chain router) --
  info: typeof getInfo;
  recentBlocks: typeof getRecentBlocks;
  recentTxs: typeof getRecentTxs;
  mempool: typeof getMempool;
  address: typeof getAddressOverview;
  peers(): PeerView[];
  /** Re-sign and re-send our PoP attestation (after wallet create/import/eject). */
  refreshPayout(): Promise<void>;
  sendTx(input: TransferInput): Promise<{ txid: string }>;
  template(minerAddress: string): Promise<TemplateView>;
  submitBlock: typeof submitBlock;
  /** Portable full-chain file for site migration (export / fresh-node import). */
  exportChain: typeof exportChain;
  importChain: typeof importChain;
  /** Delete confirmed tx history below a horizon (headers stay). */
  pruneBelow: typeof pruneConfirmedTxsBelow;
  /** Early-warning snapshot: network weather + storage pressure, session-scoped. */
  health(): Promise<HealthView>;
}

/** What the NETWORK HEALTH strip renders - all local, nothing leaves the node. */
export interface HealthView {
  peers: number;
  peerCap: number;
  tipHeight: number;
  /** Greatest height we have evidence for (hellos / gossip / sync / own wins). */
  bestKnownHeight: number;
  /** max(0, bestKnown - tip): how far behind the best-known chain we are. */
  syncLag: number;
  gossipStale: number;
  gossipRejected: number;
  syncs: number;
  syncRollbacks: number;
  peerDrops: number;
  mempoolSize: number;
  mempoolCap: number;
  storage: {
    mode: "persistent" | "memory";
    usageBytes: number | null; // null when the browser hides estimates
    quotaBytes: number | null;
    usagePct: number | null;
    /** null = browser never answers; false = evictable under pressure. */
    persisted: boolean | null;
  };
}

async function bootFresh(opts: BootOptions = {}): Promise<NodeHandle> {
  // How long a fresh boot waits for the network to reveal a longer chain
  // before going solo. Peer discovery normally answers in 1-4s; the window
  // is a ceiling, not a target - a started sync or an up-to-date peer
  // releases it immediately (see waitForSyncDecision).
  const BOOT_SYNC_WINDOW_MS = 6_000;
  // 1. storage - real IndexedDB when possible, in-memory when the browser
  // blocks it (private mode, storage disabled). Never crash on this: a
  // memory-only node is fully functional, just forgetful.
  let storage: ChainStorage;
  let storageMode: NodeHandle["storageMode"];
  if (opts.storage) {
    storage = opts.storage;
    storageMode = storage instanceof IdbStorage ? "persistent" : "memory";
  } else {
    try {
      const idb = new IdbStorage();
      await idb.open();
      storage = idb;
      storageMode = "persistent";
      // Ask the browser to never auto-evict this origin's data under quota
      // pressure - silent eviction would lose both the chain and the wallet.
      // Best-effort: a denial just means default (evictable) persistence,
      // and the storage-usage metric in health() makes pressure visible.
      void navigator.storage
        ?.persist?.()
        .then((granted) => {
          if (!granted) {
            console.warn("[boot] persistent storage NOT granted - data may be evicted under quota pressure");
          }
        })
        .catch(() => undefined);
    } catch (err) {
      console.warn("[boot] IndexedDB unavailable - memory-only mode:", err);
      storage = new MemoryStorage();
      storageMode = "memory";
    }
  }

  // 2. chain (genesis sealed idempotently)
  await initChain(storage);

  // 2.5 boot gate: from the first hydration step until the network's first
  // sync decision, the whole app stays passive - the UPDATING overlay is up
  // and mining is refused. This closes the hole where the UI looked ready
  // and mining could start while the chain was still catching up. The gate
  // is released in finally, so even a boot crash can never wedge it.
  const bootGate = beginChainUpdate("starting up");
  setChainGateDetail("waking up the network");
  let transports: Transport[];
  let engine: P2pEngine;
  try {
    // 3. wallet custody - hydrate the hot cache from the `wallet` store
    if (storage instanceof IdbStorage) {
      const idb = storage;
      await hydrateWallet({
        load: () => idb.walletGet("main").then((r) => r?.privHex ?? null),
        save: (hex) => idb.walletPut(hex),
        clear: () => idb.walletClear(),
      });
    } else {
      let mem: string | null = null;
      await hydrateWallet({
        load: () => Promise.resolve(mem),
        save: (hex) => {
          mem = hex;
          return Promise.resolve();
        },
        clear: () => {
          mem = null;
          return Promise.resolve();
        },
      });
    }

    // 4. transports
    if (opts.transports) {
      transports = opts.transports;
    } else {
      transports = [];
      if (LOCAL_TAB_MESH) transports.push(new BroadcastTransport());
      // The ?nowebrtc=1 parameter is an e2e/debug escape hatch: it forces
      // the relay to carry everything, proving the last-resort path alone
      // still converges the chain.
      const noRtc =
        typeof window !== "undefined" &&
        new URLSearchParams(window.location.search).has("nowebrtc");
      if (opts.webRtc !== false && !noRtc) {
        // The rendezvous is probed during engine.start; a failure there must
        // not kill the node - broadcast mesh + solo mining still work.
        transports.push(new PeerJsTransport());
      }
      // The zero-config common meeting point: public MQTT rooms, ON BY
      // DEFAULT (MQTT_RELAYS). This is what lets two phones on two
      // carriers - where WebRTC may never connect - see each other and
      // mine ONE chain. ?nomqtt=1 disables it (debug/isolation hatch).
      const noMqtt =
        typeof window !== "undefined" &&
        new URLSearchParams(window.location.search).has("nomqtt");
      const mqttUrls = opts.mqttUrls ?? mqttUrlsFromRuntime();
      if (!noMqtt && mqttUrls.length > 0) transports.push(new MqttRelayTransport(mqttUrls));
      // The last-resort relay: configured through RELAY_URLS or the ?relay=
      // override. With no endpoints configured it is simply not constructed.
      const relayUrls = opts.relayUrls ?? relayUrlsFromRuntime();
      if (relayUrls.length > 0) transports.push(new WsRelayTransport(relayUrls));
    }

    // 5. engine
    engine = new P2pEngine(transports);
    try {
      await engine.start(opts.onPeerChange);
    } catch (err) {
      // WebRTC signaling may be blocked (corporate firewall, offline): degrade
      // to whatever transports DID start instead of failing the whole node.
      console.warn("[p2p] a transport failed to start - running degraded:", err);
    }

    // 6. sync bridge: hold the passive state until the network reveals whether
    // we are behind. A catch-up that starts inside this window takes over the
    // gate seamlessly (requestSync engages it synchronously - no flicker); a
    // quiet network releases us to solo mode after the window. Skipped when
    // no transport came up at all (nothing can arrive).
    if (engine.hasActiveTransports()) {
      setChainGateDetail("checking for a longer chain");
      await engine.waitForSyncDecision(BOOT_SYNC_WINDOW_MS);
    }
  } finally {
    bootGate();
  }

  return {
    storage,
    engine,
    transports,
    storageMode,
    stop: () => engine.stop(),
    info: getInfo,
    recentBlocks: getRecentBlocks,
    recentTxs: getRecentTxs,
    mempool: getMempool,
    address: getAddressOverview,
    peers: () => engine.peerList(),
    refreshPayout: () => engine.refreshPayoutAddress(),
    sendTx: (input) => admitTransfer(input),
    template: (addr) => buildTemplate(addr),
    submitBlock,
    // Belt and braces on top of chain-level assertions: if a wallet is
    // loaded in THIS tab, its private key must appear nowhere in the file.
    exportChain: async (): Promise<ChainExport> => {
      const data = await exportChain();
      const w = loadWallet();
      assertExportCarriesNoSecrets(data, w ? [w.privHex] : []);
      return data;
    },
    importChain,
    pruneBelow: pruneConfirmedTxsBelow,
    health: async (): Promise<HealthView> => {
      const [tip, mempoolSize] = await Promise.all([getTipSummary(), storage.mempoolCount()]);
      // Storage estimate is best-effort: browsers may hide it (privacy) or
      // lack the API entirely - nulls render as "-", never as a crash.
      let usageBytes: number | null = null;
      let quotaBytes: number | null = null;
      let persisted: boolean | null = null;
      try {
        const est = await navigator.storage?.estimate?.();
        if (est) {
          usageBytes = est.usage ?? null;
          quotaBytes = est.quota ?? null;
        }
        persisted = (await navigator.storage?.persisted?.()) ?? null;
      } catch {
        /* metric unavailable - degrade, never fail */
      }
      const bestKnownHeight = Math.max(engine.bestKnownHeight(), tip.height);
      const stats = getNetStats();
      return {
        peers: engine.peerCount(),
        peerCap: MAX_PEERS,
        tipHeight: tip.height,
        bestKnownHeight,
        syncLag: Math.max(0, bestKnownHeight - tip.height),
        gossipStale: stats.gossipStale,
        gossipRejected: stats.gossipRejected,
        syncs: stats.syncsStarted,
        syncRollbacks: stats.syncRollbacks,
        peerDrops: stats.peerDrops,
        mempoolSize,
        mempoolCap: MAX_MEMPOOL_TXS,
        storage: {
          mode: storageMode,
          usageBytes,
          quotaBytes,
          usagePct:
            usageBytes !== null && quotaBytes ? Math.round((usageBytes / quotaBytes) * 100) : null,
          persisted,
        },
      };
    },
  };
}

/**
 * Default-boot sharing. React 18 dev (StrictMode) mounts effects twice and
 * Vite HMR re-runs modules, which used to call bootNode twice in the same
 * page realm - and the second call died on "chain already bound to a
 * storage". Now the first default boot lives in a globalThis registry (it
 * survives module re-evaluation, so HMR reuses the still-running node
 * instead of rebinding); later callers get a handle over the SAME node, and
 * the engine only stops when the LAST wrapped handle stops. A failed boot
 * clears the registry so the next call retries cleanly. Custom storage or
 * transport injection (tests) always boots privately, never shared.
 */
interface SharedBoot {
  promise: Promise<NodeHandle>;
  refs: number;
}

const BOOT_KEY = "__btwbSharedBoot";

function bootBox(): { current: SharedBoot | null } {
  const g = globalThis as Record<string, unknown>;
  let box = g[BOOT_KEY] as { current: SharedBoot | null } | undefined;
  if (!box || typeof box !== "object") {
    box = { current: null };
    g[BOOT_KEY] = box;
  }
  return box;
}

export function bootNode(opts: BootOptions = {}): Promise<NodeHandle> {
  if (opts.storage || opts.transports) return bootFresh(opts);

  const box = bootBox();
  if (!box.current) {
    const shared: SharedBoot = { promise: null as never, refs: 0 };
    shared.promise = bootFresh(opts)
      .then((inner) => inner)
      .catch((err: unknown) => {
        if (box.current === shared) box.current = null;
        throw err;
      });
    box.current = shared;
  }
  const shared = box.current;
  shared.refs += 1;
  return shared.promise.then((inner) => {
    let stopped = false;
    return {
      ...inner,
      stop: () => {
        if (stopped) return;
        stopped = true;
        shared.refs -= 1;
        if (shared.refs <= 0 && box.current === shared) {
          box.current = null;
          inner.stop();
        }
      },
    };
  });
}
