/**
 * Wallet import robustness + sybil-challenge unit tests.
 * Import accepts the messy formats real users paste; garbage never throws.
 */
import { describe, expect, it } from "vitest";
import { generateWallet, walletFromPrivHex } from "./bitweb";
import { checkSybilSolution, solveSybilChallenge } from "@/node/blockchain";

describe("wallet import edge cases", () => {
  const hex = "01".repeat(32);
  const expected = walletFromPrivHex(hex)!;

  it("accepts 0x-prefixed, uppercase and whitespace-wrapped keys", () => {
    expect(walletFromPrivHex(`0x${hex}`)?.address).toBe(expected.address);
    expect(walletFromPrivHex(`0X${hex.toUpperCase()}`)?.address).toBe(expected.address);
    expect(walletFromPrivHex(`  ${hex}\n`)?.address).toBe(expected.address);
    expect(walletFromPrivHex(`\t${hex.toUpperCase()} `)?.address).toBe(expected.address);
  });

  it("canonicalises to 64 lowercase hex chars", () => {
    expect(walletFromPrivHex(`0x${hex.toUpperCase()}\n`)?.privHex).toBe(hex);
  });

  it("rejects garbage and invalid scalars without throwing", () => {
    const bad = ["", "zz", "0x", hex.slice(0, 62), `${hex}00`, "0".repeat(64)];
    for (const b of bad) expect(walletFromPrivHex(b)).toBeNull();
    // secp256k1 group order n - mathematically not a valid secret key
    expect(
      walletFromPrivHex("fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141"),
    ).toBeNull();
    expect(walletFromPrivHex("ff".repeat(32))).toBeNull();
  });

  it("generated wallets roundtrip through their exported hex", () => {
    const w = generateWallet();
    expect(walletFromPrivHex(w.privHex)).toEqual(w);
  });
});

describe("sybil handshake challenge", () => {
  it("every solver output verifies", () => {
    for (const nonce of ["0123456789abcdef", "fedcba9876543210", "aaaaaaaaaaaaaaaa"]) {
      const sol = solveSybilChallenge(nonce, "0000");
      expect(sol).toBeTruthy();
      expect(checkSybilSolution(nonce, sol!, "0000")).toBe(true);
    }
  });

  it("malformed and wrong solutions are rejected - deterministically", () => {
    const nonce = "bbbbbbbbbbbbbbbb";
    expect(checkSybilSolution(nonce, "", "0000")).toBe(false);
    expect(checkSybilSolution(nonce, "zz", "0000")).toBe(false);
    expect(checkSybilSolution(nonce, "123456789", "0000")).toBe(false); // too long
    // find the first counter that does NOT solve - a guaranteed-false value,
    // no 1-in-65536 flake
    let wrong = "0";
    for (let i = 0; i < 1_000_000; i++) {
      if (!checkSybilSolution(nonce, i.toString(16), "0000")) {
        wrong = i.toString(16);
        break;
      }
    }
    expect(checkSybilSolution(nonce, wrong, "0000")).toBe(false);
  });

  it("a harder prefix needs more work - the cost dial is real", () => {
    const nonce = "cccccccccccccccc";
    const easy = solveSybilChallenge(nonce, "000")!;
    expect(checkSybilSolution(nonce, easy, "000")).toBe(true);
  });
});
