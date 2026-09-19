/**
 * Browser wallet - secp256k1 key custody lives here and ONLY here.
 * The private key is generated locally, persisted in the node's IndexedDB
 * `wallet` store (mirrored in a synchronous hot cache for the UI), and used
 * exclusively for local signing. It is never sent over the network.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import {
  buildAddress,
  isValidAddress,
  serializePopAttestation,
  serializeTxForSigV2,
} from "@contracts/protocol";

// -- hashing (must byte-match src/node/blockchain.ts) ------------------------
export function dsha256Hex(ascii: string): string {
  return bytesToHex(sha256(sha256(utf8ToBytes(ascii))));
}

function sha256Bytes(ascii: string): Uint8Array {
  return sha256(utf8ToBytes(ascii));
}

// -- keys & addresses --------------------------------------------------------
export interface WalletKeys {
  privHex: string;
  pubHex: string;
  address: string;
}

export function generateWallet(): WalletKeys {
  const priv = secp256k1.utils.randomSecretKey();
  const w = walletFromPrivHex(bytesToHex(priv));
  if (!w) throw new Error("freshly generated key failed self-check");
  return w;
}

export function walletFromPrivHex(privHex: string): WalletKeys | null {
  // Accept the formats real users paste: surrounding whitespace or a trailing
  // newline, an optional 0x prefix, uppercase hex. Canonicalize to the 64
  // lowercase hex chars the rest of the stack expects.
  const clean = privHex.trim().replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(clean)) return null;
  try {
    const priv = hexToBytes(clean);
    if (!secp256k1.utils.isValidSecretKey(priv)) return null;
    const pub = secp256k1.getPublicKey(priv, true); // 33B compressed
    const pubHex = bytesToHex(pub);
    const hash160 = bytesToHex(ripemd160(sha256(pub)));
    return { privHex: clean, pubHex, address: buildAddress(hash160, dsha256Hex) };
  } catch {
    return null;
  }
}

export function checkAddress(addr: string): boolean {
  return isValidAddress(addr, dsha256Hex);
}

// -- signing -----------------------------------------------------------------
export interface UnsignedTransfer {
  from: string;
  to: string;
  amount: number;
  fee: number;
  nonce: number;
}

/**
 * Deterministic RFC-6979 ECDSA, low-S normalized, 64-byte compact hex.
 * Signs the v2 preimage, which embeds the chain id - the signature is
 * provably meaningless on any other network (replay protection).
 */
export function signTransfer(privHex: string, tx: UnsignedTransfer): string {
  const msgHash = sha256Bytes(serializeTxForSigV2(tx));
  const sig = secp256k1.sign(msgHash, hexToBytes(privHex));
  return bytesToHex(sig);
}

/**
 * Signs a PoP attestation: "BTWBPOP_ATTEST|{minerPeerId}|{address}|{timestamp}"
 * - the same deterministic RFC-6979 ECDSA as transfers, low-S, compact hex.
 * The miner's node id is INSIDE the preimage, so an attestation is valid for
 * exactly one miner and cannot be replayed for anyone else.
 */
export function signPopAttestation(
  privHex: string,
  a: { minerPeerId: string; address: string; timestamp: number },
): string {
  const msgHash = sha256Bytes(serializePopAttestation(a));
  return bytesToHex(secp256k1.sign(msgHash, hexToBytes(privHex)));
}

/** Local self-check before broadcasting (mirrors node verification). */
export function verifyOwnSignature(
  tx: UnsignedTransfer,
  pubHex: string,
  signature: string,
): boolean {
  try {
    return secp256k1.verify(
      hexToBytes(signature),
      sha256Bytes(serializeTxForSigV2(tx)),
      hexToBytes(pubHex),
    );
  } catch {
    return false;
  }
}

// -- storage -----------------------------------------------------------------
// Synchronous hot cache for the UI + an async persistence adapter injected
// at node boot (the IndexedDB `wallet` store). hydrateWallet() runs BEFORE
// the first render, so loadWallet() below is always safe to call from React
// state initializers. Without an adapter (unit tests) the hot cache alone
// carries the session.
export interface WalletAdapter {
  load(): Promise<string | null>;
  save(privHex: string): Promise<void>;
  clear(): Promise<void>;
}

let hot: string | null = null;
let adapter: WalletAdapter | null = null;

/* Reactive session store: ONE wallet state shared by every component.
 * useWallet() subscribes via useSyncExternalStore, so generate / import /
 * eject in ANY component instantly re-render ALL readers (topbar, wallet
 * page, transfers page). The snapshot is cached per key - getSnapshot must
 * return a stable reference between emissions or React loops forever. */
const walletListeners = new Set<() => void>();
let cachedFor: string | null | undefined; // undefined = not computed yet
let cachedSnap: WalletKeys | null = null;

function emitWallet(): void {
  cachedFor = undefined; // force snapshot recomputation
  for (const fn of walletListeners) fn();
}

export function subscribeWallet(fn: () => void): () => void {
  walletListeners.add(fn);
  return () => {
    walletListeners.delete(fn);
  };
}

export function getWalletSnapshot(): WalletKeys | null {
  if (cachedFor !== hot) {
    cachedFor = hot;
    cachedSnap = hot ? walletFromPrivHex(hot) : null;
  }
  return cachedSnap;
}

export async function hydrateWallet(a: WalletAdapter): Promise<void> {
  adapter = a;
  hot = (await a.load()) ?? null;
  emitWallet();
}

export function loadWallet(): WalletKeys | null {
  return getWalletSnapshot();
}

export function saveWallet(w: WalletKeys): void {
  hot = w.privHex;
  emitWallet();
  // Persistence must never fail silently - a lost key is a lost wallet.
  if (adapter) {
    adapter.save(w.privHex).catch((err) => {
      console.error("[wallet] FAILED to persist the private key - export a backup NOW:", err);
    });
  }
}

export function clearWallet(): void {
  hot = null;
  emitWallet();
  if (adapter) {
    adapter.clear().catch((err) => {
      console.error("[wallet] failed to clear persisted key:", err);
    });
  }
}
