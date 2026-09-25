/**
 * P2P engine - the browser full node's network brain.
 *
 * Transport-agnostic: works identically over WebRTC DataChannels (real
 * internet) and BroadcastChannel (same-browser tabs / the test simulation).
 *
 *   handshake   hello (chainId + genesisHash - strangers are not us), then a
 *               mutual proof-of-work challenge - data flows only after the
 *               peer burns CPU (~65k hashes), so flooding the mesh with fake
 *               identities costs real work per slot

 *   sync        getBlocks/blocks in batches of 16, longest valid chain wins,
 *               automatic rollback to the fork point (<= MAX_REORG_DEPTH);
 *               deeper forks trigger a full validate-then-adopt resync, so
 *               NO valid longer chain is ever refused and no honest peer is
 *               ever punished for simply having mined on a stale fork
 *   gossip      every accepted block/tx is relayed to all other links
 *   heartbeat   ping every 30s; 3 misses -> dropped
 *   fair play   strikes ONLY for invalid data (3 -> dropped); a peer that is
 *               merely offline or behind is never punished - and neither is
 *               one that merely RACES us (duplicate dials keep their
 *               handshake state; pre-verification data is buffered, not struck)
 */
import {
  CHAIN_ID,
  HEARTBEAT_MAX_MISSES,
  MAX_REORG_DEPTH,
  HEARTBEAT_MS,
  MAX_PEER_FAILURES,
  MAX_PEERS,
  NODE_AGENT,
  P2P_BLOCK_BATCH,
  P2P_VERSION,
  SYBIL_CHALLENGE_PREFIX,
  SYBIL_CHALLENGE_TIMEOUT_MS,
  decodeMessage,
  encodeMessage,
  type WireBlock,
  type WireHello,
  type WireMessage,
  type WireTx,
} from "@contracts/wire";
import {
  MAX_MONEY,
  MIN_TX_FEE,
  POP_ATTEST_MAX_AGE_S,
  POP_ATTEST_RESEND_MS,
  type PopAttestation,
} from "@contracts/protocol";
import {
  ChainValidationError,
  admitTransfer,
  adoptRemoteChain,
  applyWireBlock,
  chainHooks,
  getGenesisHash,
  getLocalMempool,
  getTipSummary,
  getWireBlock,
  rollbackToHeight,
  setPeerCountProvider,
  setPopAttestationsProvider,
  setPopMinerNodeIdProvider,
} from "./chain";
import { beginChainUpdate, setChainGateDetail, setChainGateProgress } from "./chain-gate";
import { loadWallet, signPopAttestation } from "@/lib/bitweb";
import {
  checkAddress,
  checkSybilSolution,
  isValidPubkeyHex,
  solveSybilChallenge,
  txidOfTransfer,
  verifyPopAttestationSignature,
  verifyTransferSignature,
  type TransferInput,
} from "./blockchain";
import type { Transport, TransportEvents } from "./transport";
import { bumpStat } from "./stats";

const REQUEST_TIMEOUT_MS = 8_000;
/** Max pending transfers offered per re-gossip round (anti-flood cap). */
const MEMPOOL_REGOSSIP_MAX = 100;

/** Cap on remembered gossip ids - bounded memory for years of uptime. */
const SEEN_TX_CAP = 8_192;
const SEEN_BLOCK_CAP = 4_096;

/**
 * Frames one unverified peer may park while its handshake is in flight
 * (honest-race buffer - see processMessage). Wire frames are small; 16 of
 * them cost a few KB and cover a peer's entire post-verification burst.
 */
const EARLY_DATA_CAP = 16;

/**
 * Bounded insertion-ordered set. Gossip dedup: every txid/block hash is
 * processed at most once per node, so duplicate relays (which are normal on
 * a mesh) never trigger expensive re-verification - and a flood of the SAME
 * invalid item can only ever earn ONE strike, not three.
 */
class LruSet {
  private map = new Map<string, true>();
  private cap: number;
  constructor(cap: number) {
    this.cap = cap;
  }
  /** true when the key was already present. */
  has(v: string): boolean {
    return this.map.has(v);
  }
  add(v: string): void {
    if (this.map.has(v)) return;
    this.map.set(v, true);
    if (this.map.size > this.cap) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }
  /** Un-mark a key (used when a dedupe was premature - see onGossipTx). */
  delete(v: string): void {
    this.map.delete(v);
  }
}

interface PeerState {
  id: string;
  hello: WireHello | null;
  helloSent: boolean;
  /** Sybil gate: true once the peer solved our proof-of-work challenge. */
  verified: boolean;
  /** The challenge nonce WE issued (single-use), null when none pending. */
  challenge: string | null;
  /** Last challenge nonce WE answered - each nonce earns one response only. */
  answeredChallenge: string | null;
  challengeTimer: ReturnType<typeof setTimeout> | null;
  /** Peer books are traded exactly once, after verification. */
  peerBookTraded: boolean;
  /**
   * Pre-verification data frames, buffered instead of struck: the peer has
   * verified US and started talking while THEIR answer to OUR challenge is
   * still in flight. Flushed in wire order once the gate opens. Bounded.
   */
  earlyData: string[];
  strikes: number;
  misses: number;
  awaitingPong: boolean;
  connectedAt: number;
  lastSeen: number;
  banned: boolean;
}

export interface PeerView {
  id: string;
  transport: string;
  height: number;
  agent: string;
  strikes: number;
  connectedAt: number;
  lastSeen: number;
}

export class P2pEngine {
  private peers = new Map<string, PeerState>();
  private activeTransports: Transport[] = [];
  private pendingBlocks = new Map<
    string,
    { resolve: (blocks: WireBlock[]) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private syncInFlight = false;
  private syncQueued: string | null = null;
  private syncing = false; // deep catch-up in progress - gossip stays quiet
  private seenTxs = new LruSet(SEEN_TX_CAP);
  private seenBlocks = new LruSet(SEEN_BLOCK_CAP);
  private queues = new Map<string, Promise<void>>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private attestTimer: ReturnType<typeof setInterval> | null = null;
  /** Attestations peers signed FOR us: payout address -> freshest attestation. */
  private attestations = new Map<string, PopAttestation>();
  private stopped = false;
  private regossipTick = 0;
  private onPeerChange: (() => void) | null = null;
  /**
   * The greatest height we have EVIDENCE for (peer hellos, applied gossip,
   * sync batches, our own wins). Early-warning only: sync lag is computed
   * against this, so a node that is being left behind can see it.
   */
  private bestKnown = 0;

  private transports: Transport[];
  /** Test hook: shrink the handshake deadline without editing the constant. */
  private challengeTimeoutMs: number;
  /**
   * Fork walk-back budget per sync round before the deep resync engages.
   * Consensus default MAX_REORG_DEPTH; tests inject a small value to reach
   * the deep path without mining dozens of blocks.
   */
  private maxReorgDepth: number;

  constructor(
    transports: Transport[],
    opts: { challengeTimeoutMs?: number; maxReorgDepth?: number } = {},
  ) {
    this.transports = transports;
    this.challengeTimeoutMs = opts.challengeTimeoutMs ?? SYBIL_CHALLENGE_TIMEOUT_MS;
    this.maxReorgDepth = opts.maxReorgDepth ?? MAX_REORG_DEPTH;
  }

  async start(onPeerChange?: () => void): Promise<void> {
    this.onPeerChange = onPeerChange ?? null;
    setPeerCountProvider(() => this.peerCount());
    // The 20% peer pool pays out ONLY to peers whose SIGNED attestations we
    // currently hold - re-evaluated per template. The miner's own node id is
    // the attestation target validators recompute preimages against.
    setPopAttestationsProvider(() => this.validPopAttestations());
    setPopMinerNodeIdProvider(() => this.minerNodeId());
    const events: TransportEvents = {
      onOpen: (id) => this.handleOpen(id),
      onMessage: (id, data) => this.handleMessage(id, data),
      onClose: (id) => this.handleClose(id),
      onPeerTip: (id, height, tipHashPrefix) => this.handlePeerTip(id, height, tipHashPrefix),
    };
    // Each transport is started independently: one failing (e.g. a blocked
    // signaling rendezvous) must never take the others down with it.
    for (const t of this.transports) {
      try {
        await t.start(events);
        this.activeTransports.push(t);
      } catch (err) {
        console.warn(`[p2p] transport "${t.kind}" failed to start - continuing without it:`, err);
      }
    }
    this.pushAnnouncedTip();
    this.heartbeat = setInterval(() => this.heartbeatRound(), HEARTBEAT_MS);
    // Peers re-sign and re-gossip their attestation on this cadence, keeping
    // every potential miner's cache inside the 300s freshness window.
    this.attestTimer = setInterval(() => this.attestRound(), POP_ATTEST_RESEND_MS);
    chainHooks.onBlockAccepted.push(this.onBlockHook);
    chainHooks.onTxAccepted.push(this.onTxHook);
  }

  // Kept as fields so stop() can unregister the exact same references -
  // a stopped engine must never keep gossiping through the chain hooks.
  private onBlockHook = (height: number): void => {
    this.pushAnnouncedTip();
    void this.gossipBlock(height);
  };
  private onTxHook = (t: TransferInput): void => this.gossipTx(t);

  /**
   * Advertise our fresh tip in presence announces (transports that have a
   * lobby - currently MQTT). Behind peers see the height within one
   * announce cadence and re-sync even when NO new block is being mined.
   */
  private pushAnnouncedTip(): void {
    void getTipSummary()
      .then((tip) => {
        for (const t of this.activeTransports) t.setAnnouncedTip?.(tip);
      })
      .catch(() => undefined);
  }

  /**
   * A presence announce carried the peer's tip height. Advisory only until
   * the peer is verified (announces are unauthenticated by design); then a
   * height above our tip is a reason to sync even if their hello is long
   * past and no new block is flowing.
   */
  private handlePeerTip(id: string, height: number, tipHashPrefix: string | null): void {
    if (this.stopped) return;
    void tipHashPrefix; // diagnostic today; reserved for fork forensics
    if (height > this.bestKnown) this.bestKnown = height;
    const p = this.peers.get(id);
    if (!p || p.banned || !p.verified) return;
    void getTipSummary()
      .then((tip) => {
        if (height > tip.height && !this.stopped) this.requestSync(id);
      })
      .catch(() => undefined);
  }

  stop(): void {
    this.stopped = true;
    const drop = <T,>(arr: T[], ref: T) => {
      const i = arr.indexOf(ref);
      if (i >= 0) arr.splice(i, 1);
    };
    drop(chainHooks.onBlockAccepted, this.onBlockHook);
    drop(chainHooks.onTxAccepted, this.onTxHook);
    this.queues.clear();
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.attestTimer) clearInterval(this.attestTimer);
    this.attestations.clear();
    for (const t of this.activeTransports) t.stop();
    for (const [, p] of this.pendingBlocks) {
      clearTimeout(p.timer);
      p.resolve([]);
    }
    this.pendingBlocks.clear();
    for (const [, p] of this.peers) {
      if (p.challengeTimer) clearTimeout(p.challengeTimer);
    }
    this.peers.clear();
  }

  peerCount(): number {
    let n = 0;
    for (const p of this.peers.values()) if (!p.banned) n++;
    return n;
  }

  /** Greatest height evidenced by hellos, gossip, sync or our own blocks. */
  bestKnownHeight(): number {
    return this.bestKnown;
  }

  /** True when at least one transport came up (broadcast mesh or WebRTC). */
  hasActiveTransports(): boolean {
    return this.activeTransports.length > 0;
  }

  /**
   * Wake-from-sleep revival (mobile Safari above all): iOS freezes timers
   * and silently kills WebSockets when the tab/screen sleeps, and a bfcache
   * restore brings the JS state back with every socket dead but no close
   * event delivered. Left alone, the node would sit in "no peers" for up to
   * a full reconnect-ladder rung (120 s) and then face a long catch-up
   * sync. Called by the boot layer on pageshow(persisted) / visible / online:
   * every transport re-proves liveness NOW (dead sockets are bounced
   * immediately, ladders reset to their first rung), our presence and tip
   * are re-announced, and a pending catch-up starts without waiting for the
   * next heartbeat tick. Cheap and idempotent - safe on repeat events.
   */
  revive(): void {
    if (this.stopped) return;
    for (const t of this.activeTransports) {
      try {
        t.revive?.();
      } catch (err) {
        console.warn(`[p2p] transport "${t.kind}" revive failed:`, err);
      }
    }
    this.pushAnnouncedTip();
    if (!this.syncInFlight && this.syncQueued === null) void this.retrySyncIfBehind();
  }

  /**
   * Boot bridge: resolves the moment the first sync DECISION is known -
   *   (a) a catch-up sync has started (its own chain-gate hold now owns the
   *       overlay - no gap, because requestSync engages it synchronously),
   *   (b) a connected peer is at or below our tip (nothing to fetch), or
   *   (c) the deadline passed (solo boot is fine - go ahead).
   * Polls on a short cadence and never rejects.
   */
  async waitForSyncDecision(deadlineMs: number): Promise<void> {
    const t0 = Date.now();
    while (Date.now() - t0 < deadlineMs) {
      if (this.stopped) return;
      if (this.syncInFlight || this.syncing || this.syncQueued !== null) return;
      for (const p of this.peers.values()) {
        if (p.banned || !p.hello) continue;
        const tip = await getTipSummary();
        if (p.hello.height <= tip.height) return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /**
   * Re-announce ourselves after the wallet is created, imported or destroyed:
   * a fresh hello, then a fresh attestation to every peer. After a wallet
   * destroy we simply stop attesting - peers' copies expire within 300 s.
   */
  async refreshPayoutAddress(): Promise<void> {
    if (this.stopped) return;
    for (const [id, peer] of this.peers) {
      if (!peer.hello) continue;
      await this.sendHello(id).catch(() => undefined);
      this.sendAttestationTo(id);
    }
  }

  /**
   * Our canonical PoP node id - the id peers sign attestations FOR, and the
   * id we publish as miner_peer_id when we win a block. The WebRTC lobby id
   * wins when both transports are up (it is unique across the whole network);
   * null when no transport is running (solo: the peer pool just burns).
   */
  minerNodeId(): string | null {
    if (this.activeTransports.length === 0) return null;
    const rtc = this.activeTransports.find((t) => t.kind === "webrtc");
    return (rtc ?? this.activeTransports[0]).selfId;
  }

  /** Attest our wallet address to one peer (they are a potential miner). */
  private sendAttestationTo(id: string): void {
    const peer = this.peers.get(id);
    const w = loadWallet();
    const target = peer?.hello?.nodeId;
    if (!w || !target || peer?.banned || !peer?.verified) return;
    const timestamp = Math.floor(Date.now() / 1000);
    const attestation: PopAttestation = {
      address: w.address,
      pubkey: w.pubHex,
      signature: signPopAttestation(w.privHex, {
        minerPeerId: target,
        address: w.address,
        timestamp,
      }),
      timestamp,
    };
    this.send(id, { type: "pop_attestation", attestation });
  }

  /** Every 60 s: re-sign and re-send our attestation to all connected peers. */
  private attestRound(): void {
    if (this.stopped) return;
    for (const [id, peer] of this.peers) {
      if (peer.hello && !peer.banned) this.sendAttestationTo(id);
    }
  }

  /**
   * Attestations we hold that are currently usable in OUR block template:
   * signature already verified on receipt; here we only drop entries too old
   * to survive the 300 s window once a block is actually found (60 s margin).
   */
  validPopAttestations(): PopAttestation[] {
    const nowS = Math.floor(Date.now() / 1000);
    const out: PopAttestation[] = [];
    for (const [addr, att] of this.attestations) {
      if (Math.abs(nowS - att.timestamp) > POP_ATTEST_MAX_AGE_S - 60) {
        this.attestations.delete(addr);
        continue;
      }
      out.push(att);
    }
    return out;
  }

  private onPopAttestation(att: PopAttestation): void {
    // Attestations are hints, not consensus data: an invalid one is dropped
    // WITHOUT a strike (clock-skewed honest peers must never be banned).
    // Consensus enforcement happens at block validation, not here.
    const myId = this.minerNodeId();
    if (!myId) return; // solo: nothing can be attested to us
    if (
      typeof att?.address !== "string" ||
      typeof att?.pubkey !== "string" ||
      typeof att?.signature !== "string" ||
      !Number.isInteger(att?.timestamp)
    ) {
      return;
    }
    const nowS = Math.floor(Date.now() / 1000);
    if (Math.abs(nowS - att.timestamp) > POP_ATTEST_MAX_AGE_S) return;
    if (!checkAddress(att.address)) return;
    if (
      !verifyPopAttestationSignature({
        minerPeerId: myId,
        address: att.address,
        timestamp: att.timestamp,
        pubkey: att.pubkey,
        signature: att.signature,
      })
    ) {
      return;
    }
    const prev = this.attestations.get(att.address);
    if (prev && att.timestamp <= prev.timestamp) return; // keep the freshest
    // one attestation per address, bounded cache (peers are <=32 anyway)
    if (this.attestations.size >= 256 && !prev) {
      const oldest = this.attestations.keys().next().value;
      if (oldest !== undefined) this.attestations.delete(oldest);
    }
    this.attestations.set(att.address, att);
  }

  peerList(): PeerView[] {
    const transportOf = (id: string) =>
      this.activeTransports.find((t) => t.links().includes(id))?.kind ?? "?";
    return [...this.peers.values()]
      .filter((p) => !p.banned)
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .map((p) => ({
        id: p.id,
        transport: transportOf(p.id),
        height: p.hello?.height ?? 0,
        agent: p.hello?.agent ?? "-",
        strikes: p.strikes,
        connectedAt: p.connectedAt,
        lastSeen: p.lastSeen,
      }));
  }

  // -- link lifecycle --------------------------------------------------------

  private handleOpen(id: string): void {
    if (this.stopped) return;
    // Duplicate link: two nodes dial each other simultaneously and the
    // transport tie-breaks down to one conn. The PeerState must SURVIVE the
    // swap - resetting it used to earn a perfectly honest peer spurious
    // strikes per boot. But anything we sent on the LOSER conn is gone, so
    // re-offer the handshake on the survivor: our hello if none arrived yet,
    // or the SAME pending challenge nonce (never a fresh one - the peer may
    // still be answering the first copy, and a re-issued nonce would make
    // that honest answer look unsolicited).
    const existing = this.peers.get(id);
    if (existing) {
      if (existing.hello === null) {
        void this.sendHello(id).catch(() => undefined);
      } else if (!existing.verified && existing.challenge !== null) {
        this.send(id, { type: "challenge", nonce: existing.challenge });
      }
      return;
    }
    if (this.peerCount() >= MAX_PEERS) {
      // over capacity - politely refuse by closing the newest link
      for (const t of this.activeTransports) t.close(id);
      return;
    }
    const p: PeerState = {
      id,
      hello: null,
      helloSent: true, // sent below - onHello must never answer a hello with a hello
      verified: false,
      challenge: null,
      answeredChallenge: null,
      challengeTimer: null,
      peerBookTraded: false,
      earlyData: [],
      strikes: 0,
      misses: 0,
      awaitingPong: false,
      connectedAt: Date.now(),
      lastSeen: Date.now(),
      banned: false,
    };
    this.peers.set(id, p);
    // a storage hiccup here must never surface as an unhandled rejection
    void this.sendHello(id).catch(() => undefined);
    this.onPeerChange?.();
  }

  private handleClose(id: string): void {
    const gone = this.peers.get(id);
    if (gone?.challengeTimer) clearTimeout(gone.challengeTimer);
    if (gone) bumpStat("peerDrops");
    this.peers.delete(id);
    this.queues.delete(id);
    const pending = this.pendingBlocks.get(id);
    if (pending) {
      clearTimeout(pending.timer);
      pending.resolve([]);
      this.pendingBlocks.delete(id);
    }
    this.onPeerChange?.();
  }

  private async sendHello(id: string): Promise<void> {
    const [genesisHash, tip] = await Promise.all([getGenesisHash(), getTipSummary()]);
    this.send(id, {
      type: "hello",
      hello: {
        chainId: CHAIN_ID,
        p2pVersion: P2P_VERSION,
        agent: NODE_AGENT,
        genesisHash,
        height: tip.height,
        tipHash: tip.hash,
        serverTime: Math.floor(Date.now() / 1000),
        // PoP: peers sign attestations FOR this id; we publish it as
        // miner_peer_id when we win. The wallet key never enters the wire.
        nodeId: this.minerNodeId(),
      },
    });
  }

  private send(id: string, m: WireMessage): void {
    const data = encodeMessage(m);
    for (const t of this.activeTransports) t.send(id, data);
  }

  private broadcast(m: WireMessage, except?: string): void {
    const data = encodeMessage(m);
    for (const t of this.activeTransports) {
      for (const id of t.links()) {
        if (id !== except && !this.peers.get(id)?.banned) t.send(id, data);
      }
    }
  }

  // -- strikes: invalid data ONLY, never for being offline ------------------

  private strike(id: string, why: string): void {
    const p = this.peers.get(id);
    if (!p || p.banned) return;
    p.strikes += 1;
    console.warn(`[p2p] strike ${p.strikes}/${MAX_PEER_FAILURES} for ${id}: ${why}`);
    if (p.strikes >= MAX_PEER_FAILURES) {
      p.banned = true;
      for (const t of this.activeTransports) t.close(id);
      this.handleClose(id);
    }
  }

  // -- message handling ------------------------------------------------------

  /**
   * Entry point - per-peer SERIAL queue. Transports deliver messages in
   * order, but each message's handling awaits storage, so naive firing lets
   * a later message overtake an earlier one (block N+1 applied before N ->
   * spurious "does not extend tip" churn). One promise chain per peer keeps
   * wire order end-to-end; one peer's failure never stalls another's queue.
   */
  private handleMessage(id: string, raw: string): void {
    if (this.stopped) return;
    const prev = this.queues.get(id) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(() => this.processMessage(id, raw));
    this.queues.set(id, next.catch(() => undefined));
    void next.catch((err) =>
      console.error(`[p2p] message handling failed for ${id}:`, err),
    );
  }

  private async processMessage(id: string, raw: string): Promise<void> {
    if (this.stopped) return;
    const p = this.peers.get(id);
    if (!p || p.banned) return;
    const m = decodeMessage(raw);
    if (!m) {
      this.strike(id, "unparseable message");
      return;
    }
    p.lastSeen = Date.now();

    // Sybil gate: until our handshake challenge is solved, only handshake
    // traffic is acted on. Data arriving early is almost always an honest
    // race - the peer verified US and started talking while their answer to
    // OUR challenge is still in flight - so it is BUFFERED (bounded) and
    // processed the moment the gate opens, never struck. A flood beyond the
    // cap is simply dropped: no work happens before proof-of-work either way.
    if (
      !p.verified &&
      m.type !== "hello" &&
      m.type !== "challenge" &&
      m.type !== "challengeResponse"
    ) {
      if (p.earlyData.length < EARLY_DATA_CAP) p.earlyData.push(raw);
      return;
    }

    switch (m.type) {
      case "hello":
        await this.onHello(p, m.hello);
        break;
      case "challenge": {
        // The peer's counter-challenge: burn the CPU and answer. Solving is
        // ~65k double hashes, done inline (a fraction of a second, once per
        // link) - cheaper than spinning up a worker for it.
        const nonce = (m as { nonce?: unknown }).nonce;
        if (typeof nonce !== "string" || !/^[0-9a-f]{16}$/.test(nonce)) {
          this.strike(id, "malformed challenge");
          break;
        }
        // The same nonce re-delivered (parallel-conn race) gets answered at
        // most once - a second answer would strike us on the far side.
        if (nonce === p.answeredChallenge) break;
        {
          const solution = solveSybilChallenge(nonce, SYBIL_CHALLENGE_PREFIX);
          if (solution !== null) {
            p.answeredChallenge = nonce;
            this.send(id, { type: "challengeResponse", nonce, solution });
          }
        }
        break;
      }
      case "challengeResponse": {
        const body = m as { nonce?: unknown; solution?: unknown };
        // Already through the gate: a duplicate answer (re-delivered by a
        // racing parallel conn, or sent twice before the peer saw our state)
        // is noise, not malice - ignore it. Striking it used to punish the
        // most common honest race on the network.
        if (p.verified) break;
        if (
          p.challenge === null ||
          typeof body.nonce !== "string" ||
          typeof body.solution !== "string"
        ) {
          this.strike(id, "unsolicited challenge response");
          break;
        }
        if (
          body.nonce !== p.challenge ||
          !checkSybilSolution(body.nonce, body.solution, SYBIL_CHALLENGE_PREFIX)
        ) {
          this.strike(id, "invalid challenge solution");
          break;
        }
        p.verified = true;
        p.challenge = null;
        if (p.challengeTimer) {
          clearTimeout(p.challengeTimer);
          p.challengeTimer = null;
        }
        await this.onPeerVerified(p);
        // The gate is open: anything the peer sent while OUR challenge was
        // in flight now gets processed, in wire order, on this same serial
        // queue. The peer may have vanished meanwhile - re-check each step.
        const early = p.earlyData;
        p.earlyData = [];
        for (const queued of early) {
          if (this.stopped || !this.peers.has(id)) return;
          await this.processMessage(id, queued);
        }
        break;
      }
      case "getBlocks":
        await this.onGetBlocks(id, m.from, m.count);
        break;
      case "blocks": {
        const pending = this.pendingBlocks.get(id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingBlocks.delete(id);
          pending.resolve(m.blocks);
        }
        break;
      }
      case "block":
        await this.onGossipBlock(p, m.block);
        break;
      case "tx":
        await this.onGossipTx(p, m.tx);
        break;
      case "pop_attestation":
        this.onPopAttestation(m.attestation);
        break;
      case "peers":
        for (const pid of m.ids.slice(0, MAX_PEERS)) {
          if (this.activeTransports.some((t) => t.selfId === pid)) continue;
          if (this.peers.has(pid) || this.peerCount() >= MAX_PEERS) continue;
          for (const t of this.activeTransports) t.dial(pid);
        }
        break;
      case "ping":
        this.send(id, { type: "pong", t: m.t });
        break;
      case "pong":
        p.misses = 0;
        p.awaitingPong = false;
        break;
    }
  }

  private async onHello(p: PeerState, hello: WireHello): Promise<void> {
    if (hello.chainId !== CHAIN_ID) return this.drop(p.id); // another network - no strike
    // Wire-generation gate: a node speaking a different protocol version
    // (e.g. a stale build after a consensus-relevant update) is dropped
    // politely instead of being allowed to feed us its reality. No strike -
    // running old code is not an attack, but it must not sync with us.
    if (hello.p2pVersion !== P2P_VERSION) return this.drop(p.id);
    const genesisHash = await getGenesisHash();
    if (hello.genesisHash !== genesisHash) return this.drop(p.id); // not our DNA
    p.hello = {
      ...hello,
      // a malformed node id means "this peer cannot be attested" - never an
      // error worth dropping an otherwise honest peer over
      nodeId:
        typeof hello.nodeId === "string" && hello.nodeId.length <= 64
          ? hello.nodeId
          : null,
    };
    if (hello.height > this.bestKnown) this.bestKnown = hello.height;
    // A hello is only ever ANSWERED if we have not sent one on this link -
    // otherwise two nodes would volley hellos back and forth forever.
    if (!p.helloSent) {
      p.helloSent = true;
      await this.sendHello(p.id);
    }
    // Everything beyond the hello - attestations, peer books, sync, gossip -
    // is earned by solving the sybil challenge, not by saying hello.
    this.issueChallenge(p);
    this.onPeerChange?.();
  }

  /**
   * Sybil gate: send the peer a single-use random challenge. A correct
   * answer (verified in the challengeResponse handler) unlocks data flow;
   * no answer within the timeout and the link is dropped - no strike,
   * because a slow honest machine is not an attacker.
   */
  private issueChallenge(p: PeerState): void {
    if (p.verified || p.challenge !== null) return;
    p.challenge = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    p.challengeTimer = setTimeout(() => {
      const q = this.peers.get(p.id);
      if (q && !q.verified) this.drop(p.id);
    }, this.challengeTimeoutMs);
    this.send(p.id, { type: "challenge", nonce: p.challenge });
  }

  /** Runs once, the moment a peer passes the sybil gate. */
  private async onPeerVerified(p: PeerState): Promise<void> {
    if (this.stopped || !this.peers.has(p.id) || !p.hello) return;
    // Prove our participation so this peer can pay us a PoP share when it
    // mines - only verified peers ever receive our attestations.
    this.sendAttestationTo(p.id);
    // trade peer books once - the mesh grows beyond the lobby
    if (!p.peerBookTraded) {
      p.peerBookTraded = true;
      this.send(p.id, { type: "peers", ids: this.peerList().map((v) => v.id) });
    }
    const tip = await getTipSummary();
    if (p.hello.height > tip.height) this.requestSync(p.id);
    // A fresh peer may be a miner who never saw our pending transfers -
    // hand them over (this is what lets a NON-mining sender get confirmed).
    void this.shareMempool(p.id);
    this.onPeerChange?.();
  }

  private drop(id: string): void {
    for (const t of this.activeTransports) t.close(id);
    this.handleClose(id);
  }

  private async onGetBlocks(id: string, from: number, count: number): Promise<void> {
    if (!Number.isInteger(from) || from < 0 || !Number.isInteger(count) || count < 1) {
      this.strike(id, "malformed getBlocks");
      return;
    }
    const cap = Math.min(count, P2P_BLOCK_BATCH);
    const out: WireBlock[] = [];
    for (let h = from; h < from + cap; h++) {
      const wb = await getWireBlock(h);
      if (!wb) break;
      out.push(wb);
    }
    this.send(id, { type: "blocks", blocks: out });
    // The peer just synced to our tip. NOW is when its state can actually
    // validate our pending transfers (balance/nonce reads are current) -
    // sharing before this moment hits "insufficient funds" on their side
    // and the tx would die in transit. The 2s grace lets them apply the
    // batch we just sent.
    const tip = await getTipSummary();
    if (out.length > 0 && out[out.length - 1].height >= tip.height) {
      setTimeout(() => void this.shareMempool(id), 2_000);
    }
  }

  private async onGossipBlock(p: PeerState, wb: WireBlock): Promise<void> {
    // Dedup: every mesh node relays each block once, so most arrivals here
    // are copies we have already processed. Drop them for free.
    if (typeof wb.hash === "string") {
      if (this.seenBlocks.has(wb.hash)) return;
      this.seenBlocks.add(wb.hash);
    }
    // A network block landing IS a chain update: the gate pauses mining for
    // the apply and the miner respins on the fresh tip right after - no
    // grinding a stale template until the next 30s refresh tick.
    const done = beginChainUpdate("new block from the network");
    try {
      await applyWireBlock(wb);
      if (wb.height > this.bestKnown) this.bestKnown = wb.height;
      this.pushAnnouncedTip(); // our tip moved - announce it on the lobbies
      // Relay once to every OTHER link: gossip must be multi-hop, or nodes
      // not directly linked to the miner never see the block and stay
      // behind until some later sync trigger. Receivers dedupe by hash,
      // so the mesh cost is one copy per link per block.
      this.broadcast({ type: "block", block: wb }, p.id);
    } catch (err) {
      if (!(err instanceof ChainValidationError)) throw err;
      if (err.message === "block does not extend our tip") {
        bumpStat("gossipStale");
        const tip = await getTipSummary();
        if (wb.height > tip.height) this.requestSync(p.id); // we're behind - catch up
        return; // stale/side-chain gossip is not an offence
      }
      bumpStat("gossipRejected");
      this.strike(p.id, `invalid gossiped block: ${err.message}`);
    } finally {
      done();
    }
  }

  private async onGossipTx(p: PeerState, t: WireTx): Promise<void> {
    // Stateless precheck: only provably-invalid data earns a strike. State
    // errors (nonce gap, duplicate, funds, full mempool) can hit an honest
    // peer racing the same gossip - ignored silently.
    if (
      t.type !== "transfer" ||
      t.fromAddress === null ||
      t.nonce === null ||
      t.pubkey === null ||
      t.signature === null ||
      !checkAddress(t.fromAddress) ||
      !checkAddress(t.toAddress) ||
      !Number.isInteger(t.amount) ||
      t.amount < 1 ||
      !Number.isInteger(t.fee) ||
      t.fee < MIN_TX_FEE ||
      t.amount + t.fee > MAX_MONEY ||
      !Number.isInteger(t.nonce) ||
      t.nonce < 0 ||
      !isValidPubkeyHex(t.pubkey)
    ) {
      this.strike(p.id, "malformed gossiped tx");
      return;
    }
    const shape: TransferInput = {
      from: t.fromAddress,
      to: t.toAddress,
      amount: t.amount,
      fee: t.fee,
      nonce: t.nonce,
      pubkey: t.pubkey,
      signature: t.signature,
    };
    // Dedup BEFORE the secp256k1 verify: relays are the common case, and a
    // flood of copies must not burn CPU. (The txid commits to the content,
    // so a mangled copy can never shadow the honest original.)
    const dedupId = txidOfTransfer(shape);
    if (this.seenTxs.has(dedupId)) return;
    this.seenTxs.add(dedupId);
    if (!verifyTransferSignature(shape) || dedupId !== t.txid) {
      this.strike(p.id, "forged gossiped tx");
      return;
    }
    try {
      await admitTransfer(shape);
    } catch {
      /* state-dependent rejection - honest races, not offences. CRITICAL:
       * un-dedupe the txid so a LATER copy can be retried: the rejection
       * may be purely transient (balance not synced yet, nonce arriving
       * out of order, mempool momentarily full). Keeping the txid in
       * seenTxs here would blackhole the transfer forever - every future
       * re-gossip copy would die at the dedupe check above. */
      this.seenTxs.delete(dedupId);
    }
  }

  // -- gossip ----------------------------------------------------------------

  private async gossipBlock(height: number): Promise<void> {
    const wb = await getWireBlock(height);
    if (!wb) return;
    if (height > this.bestKnown) this.bestKnown = height; // our own win counts too
    this.seenBlocks.add(wb.hash); // never re-process our own relay
    // While deep-syncing we accept dozens of blocks per batch - relaying
    // each one would flood the mesh with history it already has.
    if (this.syncing) return;
    this.broadcast({ type: "block", block: wb });
  }

  private gossipTx(t: TransferInput): void {
    this.seenTxs.add(txidOfTransfer(t)); // never re-process our own relay
    const wire: WireTx = {
      txid: txidOfTransfer(t),
      type: "transfer",
      fromAddress: t.from,
      toAddress: t.to,
      amount: t.amount,
      fee: t.fee,
      nonce: t.nonce,
      pubkey: t.pubkey,
      signature: t.signature,
      timestamp: Math.floor(Date.now() / 1000),
    };
    this.broadcast({ type: "tx", tx: wire });
  }

  // -- heartbeat -------------------------------------------------------------

  private heartbeatRound(): void {
    if (this.stopped) return;
    // Keep presence announces fresh: imports, prunes and deep resyncs move
    // the tip without firing block hooks.
    this.pushAnnouncedTip();
    for (const p of this.peers.values()) {
      if (p.banned) continue;
      if (p.awaitingPong) {
        p.misses += 1;
        if (p.misses >= HEARTBEAT_MAX_MISSES) {
          console.warn(`[p2p] ${p.id} missed ${HEARTBEAT_MAX_MISSES} heartbeats - dropped`);
          this.drop(p.id);
          continue;
        }
      }
      p.awaitingPong = true;
      this.send(p.id, { type: "ping", t: Date.now() });
    }
    // Every 2nd round (~1 min): re-gossip the local mempool. A transfer
    // created while alone (or whose first gossip copies died in transit -
    // e.g. arrived while the receiver was still syncing and failed its
    // balance check) would otherwise sit here forever: the sender would
    // have to mine their own block to ever see it confirm. Receivers
    // dedupe by txid, so repeat sends are cheap no-ops.
    this.regossipTick += 1;
    if (this.regossipTick >= 2) {
      this.regossipTick = 0;
      void this.shareMempool(null);
    }
    // Stuck-behind watchdog: hellos, gossip and announce tips raise
    // bestKnown, but a sync that died mid-flight (mobile blip, peer
    // timeout, broker reconnect) otherwise waited for the NEXT block or
    // peer before retrying - a node could sit behind forever on a quiet
    // network. Re-check every heartbeat and re-engage the longest peer.
    if (!this.syncInFlight && this.syncQueued === null) void this.retrySyncIfBehind();
  }

  private async retrySyncIfBehind(): Promise<void> {
    if (this.stopped || this.syncInFlight || this.syncQueued !== null) return;
    const tip = await getTipSummary();
    let best: PeerState | null = null;
    for (const p of this.peers.values()) {
      if (p.banned || !p.verified || !p.hello) continue;
      if (p.hello.height <= tip.height) continue;
      if (!best || p.hello.height > (best.hello?.height ?? 0)) best = p;
    }
    if (best) this.requestSync(best.id);
  }

  /**
   * Offer every locally pending transfer to a peer (or the whole mesh
   * when peerId is null). Relay-only: receivers re-validate on admission.
   */
  private async shareMempool(peerId: string | null): Promise<void> {
    if (this.stopped) return;
    let rows;
    try {
      rows = await getLocalMempool();
    } catch {
      return; // storage mid-rotation - next round retries
    }
    for (const r of rows.slice(0, MEMPOOL_REGOSSIP_MAX)) {
      const wire: WireTx = {
        txid: r.txid,
        type: "transfer",
        fromAddress: r.fromAddress,
        toAddress: r.toAddress,
        amount: r.amount,
        fee: r.fee,
        nonce: r.nonce,
        pubkey: r.pubkey,
        signature: r.signature,
        timestamp: r.timestamp,
      };
      if (peerId) this.send(peerId, { type: "tx", tx: wire });
      else this.broadcast({ type: "tx", tx: wire });
    }
  }

  // -- sync - longest valid chain, fork rollback <= MAX_REORG_DEPTH ----------

  private requestSync(peerId: string): void {
    this.syncQueued = peerId;
    if (this.syncInFlight) return;
    this.syncInFlight = true;
    void this.drainSync();
  }

  private async drainSync(): Promise<void> {
    try {
      let id: string | null;
      while ((id = this.syncQueued) !== null) {
        this.syncQueued = null;
        await this.syncFromPeer(id);
      }
    } finally {
      this.syncInFlight = false;
    }
  }

  private requestBlocks(peerId: string, from: number, count: number): Promise<WireBlock[]> {
    const prev = this.pendingBlocks.get(peerId);
    if (prev) {
      clearTimeout(prev.timer);
      prev.resolve([]);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingBlocks.delete(peerId);
        resolve([]); // offline peers never earn strikes - a timeout is silence
      }, REQUEST_TIMEOUT_MS);
      this.pendingBlocks.set(peerId, { resolve, timer });
      this.send(peerId, { type: "getBlocks", from, count });
    });
  }

  private async syncFromPeer(peerId: string): Promise<void> {
    this.syncing = true;
    // The whole catch-up (possibly many batches + bounded rollbacks) is ONE
    // gate burst: mining stays parked and the overlay shows live height
    // until the peer's tip is reached or the sync aborts.
    const done = beginChainUpdate("syncing with a peer");
    try {
      await this.syncFromPeerInner(peerId);
    } finally {
      done();
      this.syncing = false;
      // Our tip may have moved (batches, rollbacks or a deep resync):
      // re-announce it and relay the tip block once, so the rest of the
      // mesh converges on the chain we just adopted without waiting for
      // the next mined block.
      this.pushAnnouncedTip();
      void getTipSummary()
        .then((t) => {
          if (!this.stopped && t.height > 0) void this.gossipBlock(t.height);
        })
        .catch(() => undefined);
    }
  }

  private async syncFromPeerInner(peerId: string): Promise<void> {
    let rollbackBudget = this.maxReorgDepth;
    bumpStat("syncsStarted");
    // The overlay bar's target: the tip the peer advertised at handshake
    // (or the highest block we've already seen from it). It can only grow
    // as the peer keeps mining - the bar tracks the moving target.
    const target = (): number =>
      Math.max(this.peers.get(peerId)?.hello?.height ?? 0, this.bestKnown);
    // Each pass either extends our tip or rolls it back (bounded) - so it
    // always converges to the peer's chain if that chain is valid.
    for (;;) {
      const tip = await getTipSummary();
      setChainGateDetail(`block #${tip.height.toLocaleString("en-US")}`);
      if (target() > tip.height) setChainGateProgress(tip.height, target());
      const batch = await this.requestBlocks(peerId, tip.height + 1, P2P_BLOCK_BATCH);
      if (batch.length === 0) return; // caught up (or peer went quiet)
      let restart = false;
      for (const wb of batch) {
        try {
          await applyWireBlock(wb);
          if (wb.height > this.bestKnown) this.bestKnown = wb.height;
          if (target() > wb.height) setChainGateProgress(wb.height, target());
          continue;
        } catch (err) {
          if (!(err instanceof ChainValidationError)) throw err;
          if (err.message !== "block does not extend our tip") {
            this.strike(peerId, `sync: ${err.message}`);
            return;
          }
        }
        const cur = await getTipSummary();
        if (wb.height <= cur.height) continue; // stale/side-chain block
        if (wb.height === cur.height + 1 && wb.prevHash !== cur.hash) {
          // fork - step back one block and re-request from the new tip
          if (cur.height > 0 && rollbackBudget > 0) {
            await rollbackToHeight(cur.height - 1);
            bumpStat("syncRollbacks");
            rollbackBudget -= 1;
            restart = true;
            break;
          }
          // The fork point is beyond the walk-back budget (or the fork
          // diverged at genesis itself). A fork that deep used to earn the
          // HONEST peer a strike and leave both sides stranded forever -
          // the root cause of devices showing the same heights but
          // different supply. "Longest valid chain wins" still governs:
          // if the peer advertises a strictly longer chain, download it in
          // full, prove it in memory and adopt it atomically.
          if (await this.tryDeepResync(peerId)) return;
          this.strike(peerId, "fork beyond reorg depth");
          return;
        }
        // gap ahead of us - re-request from our current tip
        restart = true;
        break;
      }
      if (restart) continue;
      if (batch.length < P2P_BLOCK_BATCH) return; // peer's tip reached
    }
  }

  /**
   * Deep-fork repair. Downloads the peer's ENTIRE chain from genesis in
   * batches, then adopts it via adoptRemoteChain - which revalidates every
   * hash, target, timestamp, signature, PoP split and the whole monetary
   * ledger in memory BEFORE touching local storage. Nothing is destroyed
   * until a fully-proven, strictly-longer replacement exists, so a peer
   * serving garbage (or a pruned peer that cannot serve its early history)
   * never costs us our valid chain.
   *
   * Returns true when the situation is resolved one way or another (chain
   * adopted, or the peer struck for serving an invalid chain); false when
   * the peer cannot offer a provable longer chain and nothing was touched.
   */
  private async tryDeepResync(peerId: string): Promise<boolean> {
    const advertised = this.peers.get(peerId)?.hello?.height ?? 0;
    const tip = await getTipSummary();
    if (advertised <= tip.height) return false; // not longer - no mandate to adopt

    const blocks: WireBlock[] = [];
    let next = 0;
    for (;;) {
      const chunk = await this.requestBlocks(peerId, next, P2P_BLOCK_BATCH);
      if (chunk.length === 0) break; // peer went quiet - judge what we have
      if (chunk[0].height !== next) break; // gap: pruned peers cannot serve full history
      blocks.push(...chunk);
      next = blocks[blocks.length - 1].height + 1;
      setChainGateDetail(
        `deep fork repair: fetching block #${blocks[blocks.length - 1].height.toLocaleString("en-US")}`,
      );
      setChainGateProgress(blocks[blocks.length - 1].height, advertised);
      if (chunk.length < P2P_BLOCK_BATCH) break;
    }
    // Must start at OUR genesis and beat our tip, even truncated: a partial
    // download is a strict prefix of the peer's chain and still provable.
    if (blocks.length === 0 || blocks[0].height !== 0) return false;
    if (blocks[blocks.length - 1].height <= tip.height) return false;

    try {
      const height = await adoptRemoteChain(blocks);
      bumpStat("syncDeepResyncs");
      console.info(
        `[p2p] deep fork repaired: adopted ${peerId}'s chain, new tip #${height} ` +
          `(was #${tip.height} on a divergent fork)`,
      );
      if (height > this.bestKnown) this.bestKnown = height;
      return true;
    } catch (err) {
      // A chain that FAILS full validation is an offence - unlike silence.
      this.strike(
        peerId,
        `deep resync: ${err instanceof Error ? err.message : String(err)}`,
      );
      return true;
    }
  }
}
