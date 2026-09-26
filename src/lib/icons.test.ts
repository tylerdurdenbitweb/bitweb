/**
 * Icon inventory invariant: every icon the app references (index.html,
 * manifest.webmanifest) must exist in public/ with the exact dimensions it
 * advertises. The PNG IHDR carries width/height at a fixed offset, so this
 * needs no image dependency. Guards against a regeneration dropping or
 * mis-sizing one of the five files.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const PUB = resolve(__dirname, "../../public");

const ICONS: Record<string, number> = {
  "favicon-16.png": 16,
  "favicon-32.png": 32,
  "apple-touch-icon.png": 180,
  "icon-192.png": 192,
  "icon-512.png": 512,
};

function pngSize(name: string): { width: number; height: number } {
  const buf = readFileSync(resolve(PUB, name));
  if (buf.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error(`${name}: not a PNG`);
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe("app icons", () => {
  for (const [name, px] of Object.entries(ICONS)) {
    it(`${name} exists at ${px}x${px}`, () => {
      const { width, height } = pngSize(name);
      expect(width).toBe(px);
      expect(height).toBe(px);
    });
  }

  it("no icon is blank (the glyph must survive every regeneration)", () => {
    for (const name of Object.keys(ICONS)) {
      const buf = readFileSync(resolve(PUB, name));
      // a solid-black PNG of these sizes compresses to a few hundred bytes;
      // anything carrying the wordmark glyph is comfortably above that
      expect(buf.length).toBeGreaterThan(280);
    }
  });
});
