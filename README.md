# BitWeb (BTWB)

## What is BitWeb?

BitWeb is an experimental, fully decentralized cryptocurrency
that runs entirely inside web browsers. There is no company,
no server, no database, and no central authority. Every person
who opens BitWeb in their browser becomes a full node in a
peer-to-peer network.

BitWeb is NOT a financial product. It is NOT an investment.
It is a technology experiment.

## Mainnet

This build IS the main network: chain id `bitweb-mainnet-1`,
born 2026-08-23 (genesis timestamp 1787443200). The earlier
experimental network is archived and retired - its coins never
migrated, exactly as promised. Every v2 signature binds this
chain id, so data from any other network can never leak onto
mainnet (and vice versa).

## How It Works

### The Network
Your browser connects directly to other browsers using WebRTC,
and every device on earth also meets in the same public MQTT
rooms (zero-config, on by default - see MQTT_RELAYS in
network.config.ts). No middleman. No server. Every tab is a
node.
After the hello, each side must solve a small proof-of-work
challenge (~65,000 hashes, seconds of CPU) before any data
flows. Flooding the network with fake identities costs real
work per connection - sybils are expensive, honesty is cheap.

### The Blockchain
Every node stores a copy of the chain in browser storage
(IndexedDB). Blocks are gossiped peer-to-peer.

### Fair Mining
ALL devices mine at the SAME speed: 70,000 hashes per second.
This is enforced by a hashrate cap in the mining Web Worker.
A phone and a supercomputer have the exact same chance of
finding a block. Hardware power does NOT matter.
The winner is determined by luck.

### Tokenomics

- Emission: Exponential decay. The reward shrinks smoothly every
  block on one continuous curve - no step events, no calendar dates.
  reward = 50 * e^(-0.000005 * (height - 1,000)) after the bootstrap era.
- Bootstrap: First 1,000 blocks have 10x reward (500 BTWB).
- ~42M soft cap - asymptotic, never enforced.
- Block reward split (70/20/10):
  - 70% -> Miner (Proof of Work)
  - 20% -> Connected peers equally (Proof of Participation)
  - 10% -> Burned (destroyed forever)
- Fees: 100% of transaction fees are BURNED.
  Fees are NOT given to miners.
- The Terminal page shows a live "BURNED FOREVER: %x" counter -
  lifetime burn (split + dust + unclaimed PoP + fees) as a share of
  the soft cap. It is derived exactly: (sum of all block rewards ever
  emitted) minus (current total supply); nothing extra is stored.

### Proof of Participation (PoP)
You earn BTWB just by keeping your tab open and connected.
You do NOT need to mine. 20% of every block reward is shared
equally among all connected peers. This works on mobile too.

PoP is secured by peer attestations. Each connected peer signs
a cryptographic attestation proving they are connected:

  BTWBPOP_ATTEST|{miner node id}|{peer address}|{timestamp}

Peers sign right after every handshake and re-sign every 60
seconds. The miner includes these attestations in the block.
Every node verifies the signatures, the 300-second freshness
window, and that the attested set matches the payout set
EXACTLY. A miner cannot fake the peer list. If no peer holds
a valid attestation, the entire 20% pool is burned instead.

### Mining Fairness
- One miner per browser (Web Locks API, with a
  BroadcastChannel claim protocol on browsers that lack it).
- Miner cooldown: cannot mine two consecutive blocks
  (enforced by consensus from block 2,000).
- Hashrate cap: 70,000 H/s for ALL devices.

### Wallet (Portable)
- Generate or import a secp256k1 keypair.
- Export your private key as a portable .bitweb wallet file
  (or copy the hex) to move between devices.
- Import on any browser - paste the hex (0x prefix, uppercase
  and surrounding whitespace are all tolerated) or upload the
  wallet file.
- WARNING: Anyone with your private key controls your funds.
  Export and store securely. BitWeb cannot recover lost keys.
- Backup reminder: once a wallet holds 1,000+ BTWB, the
  terminal reminds you to export the key file - if it was
  never backed up, or the backup is over 30 days old - at
  most once every 12 hours. The Wallet page shows a live
  KEY BACKUP status line; a successful export resets the clock.
- Storage watchdog: if the browser offers only memory-only
  storage (private window) or denies persistent storage
  (evictable under quota pressure), the terminal warns once
  per session and re-requests persistence on a slow throttle.

### Consensus Rules
- Longest valid chain wins.
- Blocks must have valid PoW (hash < target).
- Transactions must have valid signatures and sufficient balance.
- Miner cooldown enforced (1 block wait, from block 2,000).
- PoP attestations verified cryptographically.
- All fees burned.
- Deep-reorg discipline: fork walk-backs are bounded (32 blocks);
  beyond that the node downloads the candidate chain in full,
  revalidates every block and the whole ledger in memory, and only
  then adopts it - so a longer valid chain is never refused and no
  device can stay stranded on a dead fork.

## Survival & Resilience

- The blockchain lives in EVERY user's browser. No single
  point of failure.
- If the hosting site goes down, existing tabs keep working.
- If the site is hacked, blockchain data is unaffected.
- If PeerJS signaling fails, fallback methods work: tabs of
  the same browser always mesh directly, seed peers and lobby
  slots are probed again as soon as the rendezvous returns.
- Signaling itself is redundant and self-hostable:
  network.config.ts holds an ORDERED list of PeerJS-compatible
  brokers (SIGNALING_HOSTS). The default build rendezvouses on
  the public cloud so every device on earth shares one slot
  namespace; the project's own broker (source and one-command
  deploy in broker/) can be added ABOVE it once deployed, with
  the cloud kept as fallback. Boot walks the list top-down,
  claiming a lobby slot on the first host that answers. One
  dead rendezvous cannot strand new nodes.
- The network "sleeps" when all tabs close, but does not "die".
- Seed nodes: community-operated tabs open 24/7, pinned in
  network.config.ts plus the lobby: 64 primary slots probed on
  every boot, and when those fill up, an overflow range of 192
  more ids that this build sweeps on a slow rotating window
  (peer exchange carries the mesh meanwhile). Slot probing
  starts from a random offset so simultaneous boots do not herd
  onto slot-0, and the first dial wave repeats on a short
  backoff ladder (3s/5s/10s/20s) because broker registrations
  take a moment to propagate - then a 60s healing cadence.
- Mutual dials converge on ONE connection deterministically
  (the lexicographically smaller id keeps its outbound link,
  the larger keeps the inbound one), and the handshake is
  idempotent across the swap: hellos are re-offered on the
  surviving link, pending challenges are re-sent with the SAME
  nonce, each nonce is answered at most once, and a duplicate
  answer after verification is ignored - racing is not malice,
  so honest peers never earn strikes for it.
- The lobby registration is self-healing end to end: a dropped
  signaling socket is reconnected in place (same id, live
  DataChannels untouched), a slot stolen while the node slept
  forces a full re-claim, and a boot during a network hiccup no
  longer costs the session - the reclaim ladder (5s/15s/60s)
  keeps retrying FOREVER in the background. A node that could
  not hear the network at boot joins it the moment the network
  answers, with no reload and no manual step.
- Zero-config common meeting point (MQTT_RELAYS): every device
  subscribes to the same two topics on free public MQTT brokers
  (MQTT-over-WebSocket: port 443, TLS, anywhere HTTPS goes).
  Presence and chain gossip ride those rooms, so two phones on
  two carriers - where carrier-grade NAT may make a direct
  WebRTC channel impossible - still see each other and mine ONE
  chain. The node connects to EVERY listed broker at once, so
  no single broker can partition the network; brokers see only
  public, already-signed frames (liveness, never integrity).
  ?mqtt=wss://host/mqtt adds a broker, ?nomqtt=1 disables the
  transport (debug hatches, no redeploy needed).
- Last-resort chain relay (RELAY_URLS): when every WebRTC
  route fails - carrier-grade NAT, UDP-blocking firewalls - a
  plain WebSocket relay room (broker/, same port as signaling)
  still carries chain gossip between devices. It sees only
  public, already-signed frames: it can censor but never forge,
  and the WebRTC mesh keeps running alongside, so the relay is
  a liveness dependency, never an integrity one. A session can
  also be pointed at a relay ad hoc with ?relay=wss://host/relay
  (and ?nowebrtc=1 forces relay-only mode for tests).
- Snapshots every 1,000 blocks: the node persists a full
  account-state snapshot locally, so boot recovery replays
  from the latest snapshot instead of the whole chain.
- Pruning: old confirmed transactions can be pruned to save
  storage (the reorg window is always kept).
- Chain export: the whole chain fits in one downloadable
  file. Import it on a fresh node and every block is
  re-validated like a normal sync - a file is a sync, never
  a trust decision. One export plus one source zip is the
  entire network, archived.

### Chain export/import hardening

- An import never trusts the file. Before a single write,
  the whole file is validated offline: strict schema
  (whitelisted fields, wrong types rejected, unknown fields
  dropped), every block hash recomputed from its PoW
  preimage, target schedule replayed, linkage, timestamps,
  miner cooldown, coinbase = the exact 70/20/10 split for
  the height (bootstrap x10 included), merkle roots, PoP
  attestation signatures, transfer signatures - and the
  entire ledger is replayed in memory. ANY single failure
  rejects the ENTIRE file. Nothing is partially applied.
- Exports carry public chain data only - no secrets, ever.
  Export asserts this: no secret-shaped fields, and the
  loaded wallet's private key must appear nowhere in the
  payload, or the export refuses to run.
- Tip transparency: the export flow shows the height and
  full tip hash for out-of-band verification. If an import
  meets a differing local chain, both tip hashes are shown
  and replacing needs an explicit click - never silent.
- Chain-provided strings (block messages, miner addresses)
  are rendered as text only; no UI layer injects them as
  HTML.

### Update gate (passive mode while the chain mutates)

- Every chain-changing path - file import, peer sync, fork
  rollback, a gossiped block landing, a mined-block commit,
  a history prune - holds a single ref-counted gate
  (src/node/chain-gate.ts). While it is held the system is
  passive: mining can neither start nor keep running (a
  running miner's workers are killed in the same tick and it
  auto-resumes on the fresh tip when the gate releases), and
  a centered UPDATING window blocks the UI with live
  progress until balances and supply are fully recomputed.
  Sub-250ms mutations (single gossip blocks) never flash the
  window, but still pause and restart mining instantly - no
  more grinding a stale template until the next refresh tick.
- Import is end-to-end: the gate opens when the file is
  selected, covers validation and block-by-block apply, and
  stays up until every cached view (balance, history, info)
  has been refetched - the coins are visible before the
  window closes.

### Checkpoints (low-difficulty rewrite defense)

At 22-bit starting difficulty, re-mining a forged chain is
cheap. The protocol therefore pins checkpoint hashes
(contracts/protocol.ts, CHECKPOINTS): a block at a pinned
height accepts exactly one hash - consensus-level, not UI -
and no reorg or import may cross the highest pinned height.
Genesis (height 0) is pinned today; a new pin is added every
1,000 blocks (CHECKPOINT_INTERVAL) as the network grows.
Limitation, stated plainly: history between the last pin and
the tip is protected only by proof-of-work and the 32-block
reorg window (MAX_REORG_DEPTH), so a young, low-hashrate
network must not be treated as final settlement. Deeper
history (below the newest pin) cannot be rewritten at all.

Release process for new pins (operator runbook): export the
canonical chain from any synced, honest node (Terminal page ->
EXPORT CHAIN), then run
`npx vite-node scripts/checkpoints-from-export.ts <file>`.
The script trusts nothing - it recomputes every header hash
from the consensus serialization, re-checks prevHash linkage
and PoW targets, demands the pinned genesis, and emits pins
only at interval multiples at least 2x the reorg window below
the tip. Paste the emitted lines into CHECKPOINTS and ship a
release. Old nodes keep validating as before; updated nodes
reject any fork that crosses a pin.

## Site Migration

The blockchain is NOT tied to the hosting URL. It is tied to
protocol constants (genesis hash, CHAIN_ID, consensus rules).
If BitWeb moves to a new URL with the same protocol, the same
chain continues. No fork occurs.

IMPORTANT: Export your private key BEFORE switching URLs.
Browser storage is scoped to the domain. Your coins live on
the chain, and your key is the only thing that proves they
are yours. After the move, your node resyncs the chain from
its peers automatically - or import a chain export file and
be fully synced before the first peer even connects.

## User Guide

### Getting Started
1. Open BitWeb in your browser.
2. Generate a wallet.
3. Export your private key and store it safely.
4. Start mining or just stay connected to earn PoP rewards.

### Earning Without Mining
Keep your tab open and connected. You earn 20% of every
block reward shared among all peers. Works on mobile too.
Keep the app in foreground for best results.

### Common Problems
- "No peers connected": Wait, refresh, or open a second tab
  in the same browser - the same-browser mesh always connects.
- "Mining already active": Another tab is mining. Close it
  (one miner per browser, enforced with the Web Locks API).
- Wallet disappeared: You cleared browser data. Import your key.
- Balance shows 0: Wait for blockchain sync from peers.

### Safety Rules
1. ALWAYS export your private key.
2. NEVER share your private key.
3. ALWAYS export before clearing browser data.
4. ALWAYS export before switching browsers or devices.
5. This is an experiment. Do not store significant value.

## Known Limitations

- Browser tabs must remain open. All tabs closed = network pauses.
- Browser storage limited (~50MB-1GB). Pruning required.
- Mobile browsers may suspend background tabs.
- Corporate firewalls may block WebRTC.
- PeerJS is a third-party dependency.
- WebRTC exposes your IP address to the peers you connect to.
  That is the price of true peer-to-peer.
- The one-miner lock is scoped to one browser profile on one
  origin. Multiple browsers, profiles, incognito windows or
  devices each get their own vote - no software can bind a
  vote to a physical machine without an identity layer, and
  this system has none by design. The hashrate cap guarantees
  every vote is equally strong; it cannot guarantee every
  voter is equally singular.
- This is an EXPERIMENT. Not for production financial use.

### Threat Model

Defended in code (and where):

- Fake or rewritten history: every block is fully validated (PoW,
  linkage, merkle, full ledger replay); checkpoints pin known-good
  heights; walk-back reorgs stay within the 32-block window, and
  deeper divergence is healed by a fully-proven validate-then-adopt
  resync instead of blind trust; chain imports validate everything
  before writing anything and reject shorter chains by default.
- Sybil floods: a mutual proof-of-work handshake (~65k hashes) gates
  every peer slot; 32 slots max; invalid data earns strikes (3 =
  dropped); offline peers are never punished.
- Gossip floods: each txid/block hash is processed at most once
  (bounded LRU dedup), wire messages are capped at 1 MiB, and every
  peer's messages are handled on a serial queue.
- Mempool spam: 512 slots total, 64 per sender, minimum relay fee
  (fees burn, so spam costs real coins).
- Forged PoP payouts: every payout requires the recipient peer's own
  ECDSA attestation, re-verified by every node, inside a 300 s
  freshness window, with the equal split and miner exclusion enforced
  by consensus.
- Key theft via injected scripts: the CSP allows same-origin scripts
  only, there is zero third-party code, and the UI never injects HTML.
- Silent storage eviction: the node requests persistent storage at
  boot and exposes usage in the NETWORK HEALTH strip.
- Stale code after an update: the service worker's cache namespace is
  stamped with a content hash of each build, and nodes speaking a
  different wire protocol version are dropped at the handshake.

Accepted (unfixable without breaking the serverless, no-identity
design):

- A vote is a browser, not a person. Multiple browsers, profiles or
  devices multiply voting power. The 70,000 H/s cap equalizes each
  vote's strength; no software can count voters without identity.
- The miner cooldown binds an address, so rotating wallets evades it.
  It is a fairness nudge, not a security wall.
- Eclipse attacks: a node that only ever meets hostile peers can be
  fed attacker-mined history within the 32-block reorg window
  (checkpoints bound the absolute depth). Watch SYNC and STALE in
  NETWORK HEALTH; import a trusted chain file to recover.
- The project's own PeerJS broker (broker/) and the static hosting are
  replaceable pieces of infrastructure (network.config.ts, the source zip),
  and neither touches chain data after boot. A public third-party signaling
  cloud remains configured as fallback.
- WebRTC reveals your IP address to peers. Peer-to-peer without
  relays cannot hide it, and relays are servers.
- Legacy v1 signatures carry no chain binding and remain valid
  forever (historical blocks need them); every wallet signs v2
  (chain-id-bound) from the start.
- A malicious browser extension or a compromised device can read the
  wallet. No web app can defend against its own environment.

## Legal

BitWeb is experimental open-source software under the MIT
license. There is no company, foundation, fund, or central
operator. Nothing here is financial advice or an investment
opportunity. BTWB has no promised value. Users are responsible
for their own tax obligations and legal compliance in their
respective jurisdictions. Use at your own risk.

## Development

- Author: Tyler Durden
- License: MIT
- Language: TypeScript
- Build: Vite
- Tests: `npx vitest run` (106 tests) - real-browser smokes in `dev-smoke/`
- No geographic location or jurisdiction is associated
  with this project.

## Contributing

1. Fork the repository.
2. Create a feature branch.
3. Submit a pull request.
4. Do NOT include geographic or identifying information.
5. All code must be in English.
