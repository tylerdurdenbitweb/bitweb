/**
 * PoP attestation attack matrix - pure consensus-level unit tests over
 * validatePoPAttestations. Every trick a hostile miner could try to inflate
 * the 20% peer pool must come back false; the honest shapes must stay true.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_POP_RECIPIENTS,
  POP_ATTEST_MAX_AGE_S,
  type PopAttestation,
} from "@contracts/protocol";
import { signPopAttestation, walletFromPrivHex } from "@/lib/bitweb";
import { validatePoPAttestations } from "./chain";
import type { PopTransfer } from "./storage";

const miner = walletFromPrivHex("0a".repeat(32))!;
const peerA = walletFromPrivHex("0b".repeat(32))!;
const peerB = walletFromPrivHex("0c".repeat(32))!;
const MINER_PEER = "btwb-lobby-miner-1";
const T = 1_700_000_000; // fixed anchor - freshness is measured against it

function attest(
  w = peerA,
  target = MINER_PEER,
  ts = T,
  address?: string,
): PopAttestation {
  const addr = address ?? w.address;
  return {
    address: addr,
    pubkey: w.pubHex,
    signature: signPopAttestation(w.privHex, { minerPeerId: target, address: addr, timestamp: ts }),
    timestamp: ts,
  };
}

const pay = (a: PopAttestation, index: number, amount = 1_000): PopTransfer => ({
  address: a.address,
  amount,
  index,
});

const block = (popTransfers: PopTransfer[], popAttestations: PopAttestation[]) => ({
  minerPeerId: MINER_PEER,
  miner: miner.address,
  timestamp: T,
  popTransfers,
  popAttestations,
});

describe("PoP attestation attack matrix", () => {
  it("honest shapes pass: zero peers (burn) and exact attested sets", () => {
    expect(block([], [])).toSatisfy((b) => validatePoPAttestations(b)); // whole pool burns
    const a = attest(peerA);
    expect(validatePoPAttestations(block([pay(a, 0)], [a]))).toBe(true);
    const b = attest(peerB);
    expect(validatePoPAttestations(block([pay(a, 0), pay(b, 1)], [a, b]))).toBe(true);
  });

  it("ATTACK: one sockpuppet key claiming TWO pool shares (duplicate address)", () => {
    // Two attestations from the same wallet (different timestamps) plus two
    // matching payouts - before the distinct-address rule this PASSED and
    // let a single sybil key drain the entire pool via 32 duplicates.
    const a1 = attest(peerA, MINER_PEER, T);
    const a2 = attest(peerA, MINER_PEER, T - 30);
    expect(a1.address).toBe(a2.address);
    expect(validatePoPAttestations(block([pay(a1, 0), pay(a2, 1)], [a1, a2]))).toBe(false);
  });

  it("ATTACK: miner attests itself to grab the peer pool", () => {
    const selfAtt = attest(miner);
    expect(validatePoPAttestations(block([pay(selfAtt, 0)], [selfAtt]))).toBe(false);
  });

  it("ATTACK: attestation signed for a DIFFERENT miner is replayed here", () => {
    const forOther = attest(peerA, "btwb-lobby-someone-else");
    // the payout matches the address, but the signature binds another target
    expect(validatePoPAttestations(block([pay(forOther, 0)], [forOther]))).toBe(false);
  });

  it("ATTACK: stale attestation outside the freshness window", () => {
    const stale = attest(peerA, MINER_PEER, T - POP_ATTEST_MAX_AGE_S - 1);
    expect(validatePoPAttestations(block([pay(stale, 0)], [stale]))).toBe(false);
    const fromFuture = attest(peerA, MINER_PEER, T + POP_ATTEST_MAX_AGE_S + 1);
    expect(validatePoPAttestations(block([pay(fromFuture, 0)], [fromFuture]))).toBe(false);
  });

  it("ATTACK: payout without attestation, and attestation without payout", () => {
    const a = attest(peerA);
    expect(validatePoPAttestations(block([pay(a, 0)], []))).toBe(false); // unattested payout
    expect(validatePoPAttestations(block([], [a]))).toBe(false); // unpaid attestation
  });

  it("ATTACK: pubkey swapped after signing (address/pubkey mismatch)", () => {
    const a = attest(peerA);
    const swapped: PopAttestation = { ...a, pubkey: peerB.pubHex };
    expect(validatePoPAttestations(block([pay(a, 0)], [swapped]))).toBe(false);
  });

  it("ATTACK: signature tampered after signing", () => {
    const a = attest(peerA);
    const tampered: PopAttestation = { ...a, signature: `ff${a.signature.slice(2)}` };
    expect(validatePoPAttestations(block([pay(a, 0)], [tampered]))).toBe(false);
  });

  it("ATTACK: more attested peers than the recipient cap", () => {
    const wallets = Array.from({ length: MAX_POP_RECIPIENTS + 1 }, (_, i) =>
      walletFromPrivHex((i + 16).toString(16).padStart(2, "0").repeat(32))!,
    );
    const atts = wallets.map((w) => attest(w));
    const pays = atts.map((a, i) => pay(a, i));
    expect(validatePoPAttestations(block(pays, atts))).toBe(false);
  });

  it("ATTACK: block with payouts but no miner peer id at all", () => {
    const a = attest(peerA);
    expect(
      validatePoPAttestations({ ...block([pay(a, 0)], [a]), minerPeerId: null }),
    ).toBe(false);
  });

  it("ATTACK: non-integer attestation timestamps", () => {
    const a = { ...attest(peerA), timestamp: T + 0.5 };
    expect(validatePoPAttestations(block([pay(a, 0)], [a]))).toBe(false);
  });
});
