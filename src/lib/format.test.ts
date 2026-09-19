/**
 * Topbar "BTWB: {value}" formatter contract - the exact figures from the
 * topbar spec, plus the abbreviation edges that keep the cell one line at
 * every width.
 */
import { describe, expect, it } from "vitest";
import { COIN } from "@contracts/protocol";
import { fmtBurnPct, fmtCompact } from "@/lib/format";

describe("fmtCompact - topbar balance figure", () => {
  it("matches the spec examples exactly", () => {
    expect(fmtCompact(0)).toBe("0"); // wallet with zero balance -> "BTWB: 0"
    expect(fmtCompact(12.5 * COIN)).toBe("12.5"); // 2 decimals, trimmed
    expect(fmtCompact(4550 * COIN)).toBe("4.55k"); // thousands abbreviate
    expect(fmtCompact(45_500 * COIN)).toBe("45.5k"); // thousands abbreviate
    expect(fmtCompact(42_000_000 * COIN)).toBe("42M"); // the soft cap itself
  });

  it("trims trailing zeros and rounds to at most 2 decimals", () => {
    expect(fmtCompact(1_000 * COIN)).toBe("1k");
    expect(fmtCompact(10_000 * COIN)).toBe("10k"); // not "10.0k"
    expect(fmtCompact(110_000 * COIN)).toBe("110k"); // not "11k" - integer zeros are kept
    expect(fmtCompact(180_000 * COIN)).toBe("180k"); // not "18k"
    expect(fmtCompact(100_000 * COIN)).toBe("100k");
    expect(fmtCompact(1_000_000 * COIN)).toBe("1M");
    expect(fmtCompact(1.5 * COIN)).toBe("1.5");
    expect(fmtCompact(1.234 * COIN)).toBe("1.23"); // capped at 2 decimals
    expect(fmtCompact(999.5 * COIN)).toBe("999.5");
    expect(fmtCompact(1_500_000_000 * COIN)).toBe("1.5B");
  });

  it("spills into the next suffix instead of printing 1000k", () => {
    expect(fmtCompact(999_999 * COIN)).toBe("1M");
    expect(fmtCompact(999_499 * COIN)).toBe("999k");
  });

  it("handles null/undefined as a dash placeholder", () => {
    expect(fmtCompact(null)).toBe("-");
    expect(fmtCompact(undefined)).toBe("-");
  });
});

describe("fmtBurnPct - the BURNED FOREVER percentage", () => {
  const CAP = 42_000_000 * COIN;
  it("zero / missing burn reads as a clean %0", () => {
    expect(fmtBurnPct(0, CAP)).toBe("%0");
    expect(fmtBurnPct(null, CAP)).toBe("%0");
    expect(fmtBurnPct(undefined, CAP)).toBe("%0");
    expect(fmtBurnPct(100, 0)).toBe("%0"); // degenerate cap never divides by zero
  });
  it("adaptive precision: tiny early burns stay visible instead of %0.00", () => {
    expect(fmtBurnPct(1 * COIN, CAP)).toBe("%<0.0001"); // 1 BTWB ~= 0.0000024%
    expect(fmtBurnPct(150 * COIN, CAP)).toBe("%0.0004"); // one solo bootstrap block
    expect(fmtBurnPct(4_199 * COIN, CAP)).toBe("%0.0100"); // just under 0.01 -> 4 decimals
    expect(fmtBurnPct(4_200 * COIN, CAP)).toBe("%0.01"); // boundary -> 2 decimals
    expect(fmtBurnPct(420_000 * COIN, CAP)).toBe("%1.00");
    expect(fmtBurnPct(4_200_000 * COIN, CAP)).toBe("%10.00");
  });
});
