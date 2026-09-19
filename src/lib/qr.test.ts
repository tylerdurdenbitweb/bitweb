// Payment-URI payload tests + full QR image roundtrip:
// encode URI -> render to real PNG (qrcode) -> decode pixels (pngjs + jsQR) -> parse URI.
// This proves the exact path a phone camera will take in production.
import { describe, expect, it } from "vitest";
import QRCode from "qrcode";
import { PNG } from "pngjs";
import jsQR from "jsqr";
import { buildPaymentUri, parsePaymentUri } from "./qr";
import { generateWallet, dsha256Hex } from "./bitweb";
import { buildAddress } from "@contracts/protocol";

const A = generateWallet().address;
const B = generateWallet().address;

describe("buildPaymentUri", () => {
  it("builds a bare address URI", () => {
    expect(buildPaymentUri(A)).toBe(`bitweb:${A}`);
  });

  it("builds a URI with a normalised amount", () => {
    expect(buildPaymentUri(A, "12.50000000")).toBe(`bitweb:${A}?amount=12.5`);
    expect(buildPaymentUri(A, "0.00000001")).toBe(`bitweb:${A}?amount=0.00000001`);
  });

  it("rejects invalid addresses and amounts", () => {
    expect(buildPaymentUri("btw1deadbeef")).toBeNull();
    expect(buildPaymentUri(A, "abc")).toBeNull();
    expect(buildPaymentUri(A, "-1")).toBeNull();
    expect(buildPaymentUri(A, "0")).toBeNull();
    expect(buildPaymentUri(A, "0.000000001")).toBeNull(); // 9 decimals
    expect(buildPaymentUri(A, "43000000")).toBeNull(); // above the soft-cap bound
  });

  it("treats empty amount as bare address", () => {
    expect(buildPaymentUri(A, "  ")).toBe(`bitweb:${A}`);
  });
});

describe("parsePaymentUri", () => {
  it("roundtrips URI with amount", () => {
    const uri = buildPaymentUri(A, "42.75")!;
    expect(parsePaymentUri(uri)).toEqual({ address: A, amount: "42.75" });
  });

  it("roundtrips bare URI and bare address", () => {
    expect(parsePaymentUri(`bitweb:${A}`)).toEqual({ address: A, amount: undefined });
    expect(parsePaymentUri(A)).toEqual({ address: A, amount: undefined });
    expect(parsePaymentUri(`  ${A.toUpperCase()}  `)).toEqual({ address: A, amount: undefined });
  });

  it("accepts '&' separator and ignores unknown params", () => {
    expect(parsePaymentUri(`bitweb:${A}?label=shop&amount=3.25`)).toEqual({
      address: A,
      amount: "3.25",
    });
  });

  it("rejects tampered / malformed payloads", () => {
    expect(parsePaymentUri("")).toBeNull();
    expect(parsePaymentUri("hello world")).toBeNull();
    expect(parsePaymentUri(`bitcoin:${A}`)).toBeNull();
    expect(parsePaymentUri(`bitweb:${B.slice(0, -1)}x`)).toBeNull();
    expect(parsePaymentUri(`bitweb:${A}?amount=abc`)).toBeNull();
    expect(parsePaymentUri(`bitweb:${A}?amount=-5`)).toBeNull();
    expect(parsePaymentUri(`bitweb:${A}?amount=0`)).toBeNull();
    expect(parsePaymentUri(`bitweb:${A}?amount=%E0%A4%A`)).toBeNull(); // bad percent-encoding
    expect(parsePaymentUri(`bitweb:${A}?amount=1e3`)).toBeNull(); // scientific notation not allowed
    expect(parsePaymentUri(null as unknown as string)).toBeNull();
  });

  it("rejects a URI whose address has a flipped checksum", () => {
    // Flip one checksum character - checkAddress must catch it.
    const bad = A.slice(0, -1) + (A.endsWith("0") ? "1" : "0");
    expect(parsePaymentUri(`bitweb:${bad}`)).toBeNull();
  });
});

describe("QR image roundtrip (encode -> PNG -> camera-style decode)", () => {
  async function renderAndDecode(text: string): Promise<string | null> {
    const buf = await QRCode.toBuffer(text, {
      errorCorrectionLevel: "M",
      margin: 2,
      scale: 8,
      color: { dark: "#000000", light: "#ffffff" },
    });
    const png = PNG.sync.read(buf);
    const res = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
    return res ? res.data : null;
  }

  it("decodes a payment URI with amount from a rendered QR image", async () => {
    const uri = buildPaymentUri(A, "7.5")!;
    const decoded = await renderAndDecode(uri);
    expect(decoded).toBe(uri);
    expect(parsePaymentUri(decoded!)).toEqual({ address: A, amount: "7.5" });
  });

  it("decodes a bare address QR", async () => {
    const decoded = await renderAndDecode(A);
    expect(decoded).toBe(A);
    expect(parsePaymentUri(decoded!)).toEqual({ address: A, amount: undefined });
  });

  it("decodes at the max payload size (full URI + 8-decimal amount)", async () => {
    const uri = buildPaymentUri(B, "1999999.99999999")!;
    const decoded = await renderAndDecode(uri);
    expect(decoded).toBe(uri);
    expect(parsePaymentUri(decoded!)?.address).toBe(B);
  });
});

describe("address sanity", () => {
  it("generated wallet addresses pass checkAddress via protocol builder", () => {
    expect(A).toHaveLength(52);
    expect(A.startsWith("btw1")).toBe(true);
    // buildAddress is the canonical constructor - must agree with wallet gen.
    expect(buildAddress(A.slice(4, 44), dsha256Hex)).toBe(A);
  });
});
