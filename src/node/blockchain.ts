/**
 * Browser-node cryptographic primitives + pure chain functions.
 * Everything runs on @noble - no Node APIs, no WebCrypto async: validation
 * must stay synchronous so chain application can run inside one IndexedDB
 * transaction without ever yielding to the event loop.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  buildAddress,
  isValidAddress,
  serializeTxForId,
  serializeTxForIdV2,
  serializePopAttestation,
  serializeTxForSig,
  serializeTxForSigV2,
} from "@contracts/protocol";

// -- hashing -----------------------------------------------------------------
export function sha256Hex(ascii: string): string {
  return bytesToHex(sha256(utf8ToBytes(ascii)));
}

export function dsha256Hex(ascii: string): string {
  return bytesToHex(sha256(sha256(utf8ToBytes(ascii))));
}

/** Single SHA-256 (bytes) of the signed message - the ECDSA message hash. */
export function sigMessageHash(ascii: string): Uint8Array {
  return sha256(utf8ToBytes(ascii));
}

// -- addresses & keys --------------------------------------------------------
export function hash160HexFromPubkey(pubkeyHex: string): string {
  return bytesToHex(ripemd160(sha256(hexToBytes(pubkeyHex))));
}

export function addressFromPubkey(pubkeyHex: string): string {
  return buildAddress(hash160HexFromPubkey(pubkeyHex), dsha256Hex);
}

export function checkAddress(addr: string): boolean {
  return isValidAddress(addr, dsha256Hex);
}

export function isValidPubkeyHex(pubkeyHex: string): boolean {
  if (!/^(02|03)[0-9a-f]{64}$/.test(pubkeyHex)) return false;
  try {
    secp256k1.Point.fromHex(pubkeyHex);
    return true;
  } catch {
    return false;
  }
}

// -- transactions ------------------------------------------------------------
export interface TransferInput {
  from: string;
  to: string;
  amount: number;
  fee: number;
  nonce: number;
  pubkey: string;
  signature: string;
}

/**
 * Which signature preimage a transfer actually verifies under:
 *   2 = chain-bound v2 (canonical), 1 = legacy v1, 0 = invalid.
 * v2 is tried first; v1 remains accepted so historical blocks and
 * in-flight legacy transactions stay valid forever (no hard fork).
 */
export function signatureVersionOf(t: TransferInput): 0 | 1 | 2 {
  if (!/^[0-9a-f]{128}$/.test(t.signature)) return 0;
  if (!isValidPubkeyHex(t.pubkey)) return 0;
  try {
    const sig = hexToBytes(t.signature);
    const pub = hexToBytes(t.pubkey);
    if (secp256k1.verify(sig, sigMessageHash(serializeTxForSigV2(t)), pub)) return 2;
    if (secp256k1.verify(sig, sigMessageHash(serializeTxForSig(t)), pub)) return 1;
  } catch {
    return 0;
  }
  return 0;
}

/**
 * The txid commits to the same preimage version the signature proves -
 * a v1-signed transfer keeps its legacy v1 txid, everything else gets the
 * canonical v2 txid. An attacker cannot re-wrap a signed transfer under a
 * different version: the signature would no longer verify.
 */
export function txidOfTransfer(t: TransferInput): string {
  return signatureVersionOf(t) === 1
    ? dsha256Hex(serializeTxForId(t))
    : dsha256Hex(serializeTxForIdV2(t));
}

export function verifyTransferSignature(t: TransferInput): boolean {
  return signatureVersionOf(t) !== 0;
}

/**
 * Verifies a PoP attestation end-to-end: well-formed 64-byte signature and
 * compressed pubkey, the pubkey really derives the payout address, and the
 * ECDSA signature verifies over the canonical preimage - which binds the
 * attestation to ONE miner peer id, so it cannot be replayed for another.
 * Freshness (timestamp window) is a consensus check done by the caller.
 */
export function verifyPopAttestationSignature(a: {
  minerPeerId: string;
  address: string;
  timestamp: number;
  pubkey: string;
  signature: string;
}): boolean {
  if (!/^[0-9a-f]{128}$/.test(a.signature)) return false;
  if (!isValidPubkeyHex(a.pubkey)) return false;
  if (addressFromPubkey(a.pubkey) !== a.address) return false;
  try {
    return secp256k1.verify(
      hexToBytes(a.signature),
      sigMessageHash(serializePopAttestation(a)),
      hexToBytes(a.pubkey),
    );
  } catch {
    return false;
  }
}

// -- sybil handshake challenge -------------------------------------------------
/**
 * Solves a handshake challenge: the smallest counter (hex) whose
 * dsha256("{nonce}:{solution}") carries the required zero prefix. Bounded
 * at 2^24 tries; the expected work at prefix "0000" is 65,536 double
 * hashes - a fraction of a second once per connection.
 */
export function solveSybilChallenge(nonce: string, prefix: string): string | null {
  for (let i = 0; i < 1 << 24; i++) {
    const s = i.toString(16);
    if (dsha256Hex(`${nonce}:${s}`).startsWith(prefix)) return s;
  }
  return null;
}

/** Verifies a handshake solution without trusting its shape. */
export function checkSybilSolution(nonce: string, solution: string, prefix: string): boolean {
  return /^[0-9a-f]{1,8}$/.test(solution) && dsha256Hex(`${nonce}:${solution}`).startsWith(prefix);
}

// -- merkle tree -------------------------------------------------------------
/** Pairwise double-SHA-256 merkle root over hex txids (last duplicated). */
export function merkleRootHex(txids: string[]): string {
  if (txids.length === 0) return "0".repeat(64);
  let level = txids.slice();
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i];
      const b = i + 1 < level.length ? level[i + 1] : a;
      next.push(dsha256Hex(a + b));
    }
    level = next;
  }
  return level[0];
}
