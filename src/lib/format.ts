import { COIN, unitsToCoins } from "@contracts/protocol";

/** "12.5" style coin string from base units. */
export function fmtCoins(units: number | null | undefined): string {
  if (units == null) return "0";
  return unitsToCoins(units);
}

/**
 * Topbar-compact coin figure ("BTWB: {value}" cell): always short enough to
 * fit one line, never grouped (a comma reads as a layout shift in a
 * monospace cell).
 *   < 1,000 coins   -> up to 2 decimals, trailing zeros trimmed ("0", "12.5", "999.5")
 *   >= 1,000        -> one-suffix abbreviation ("1k", "110k", "45.5k", "42M");
 *                      a value that would round up to the next magnitude
 *                      spills into the next suffix instead of printing "1000k"
 */
export function fmtCompact(units: number | null | undefined): string {
  if (units == null) return "-";
  const coins = units / COIN;
  const neg = coins < 0 ? "-" : "";
  const abs = Math.abs(coins);
  if (abs < 1000) {
    const s = abs.toFixed(2).replace(/\.?0+$/, "");
    return `${neg}${s}`;
  }
  const suffixes: Array<[number, string]> = [
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "k"],
  ];
  for (const [div, suf] of suffixes) {
    const v = abs / div;
    // pick the first suffix whose value fits [0.9995, 999.5): below the
    // floor this suffix is premature, at/above the ceiling it would print
    // as "1000x" - so a rounding spill lands on the NEXT suffix as "1X"
    if (v < 0.9995 || v >= 999.5) continue;
    const s = v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
    // trim trailing zeros ONLY in the fractional part - stripping them from
    // an integer ("110" -> "11") silently divides the figure by ten
    const trimmed = s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
    return `${neg}${trimmed}${suf}`;
  }
  return `${neg}${Math.floor(abs)}`;
}

/** 1_234_567 */
export function fmtInt(n: number | null | undefined): string {
  if (n == null) return "-";
  return Math.floor(n).toLocaleString("en");
}

/**
 * Burned-forever counter: the share of the soft cap that is gone for good,
 * as a percent string ("%0", "%0.0036", "%1.25"). Adaptive precision - an
 * early chain burns so little that fixed 2-decimal rounding would pin the
 * counter at "%0.00" for months, which reads as broken instead of tiny.
 */
export function fmtBurnPct(burnedUnits: number | null | undefined, softCapUnits: number): string {
  if (burnedUnits == null || softCapUnits <= 0 || burnedUnits <= 0) return "%0";
  const pct = (burnedUnits / softCapUnits) * 100;
  if (pct < 0.0001) return "%<0.0001";
  if (pct < 0.01) return `%${pct.toFixed(4)}`;
  return `%${pct.toFixed(2)}`;
}

/** Human hashrate: 1.4 MH/s */
export function fmtHashrate(hps: number | null | undefined): string {
  if (!hps || hps <= 0) return "0 H/s";
  const units = ["H/s", "kH/s", "MH/s", "GH/s", "TH/s"];
  let v = hps;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${units[i]}`;
}

/** btw1abcd...wxyz */
export function shortAddr(addr: string, head = 10, tail = 6): string {
  if (addr.length <= head + tail + 1) return addr;
  return `${addr.slice(0, head)}...${addr.slice(-tail)}`;
}

export function shortHash(hash: string, head = 12, tail = 0): string {
  if (!tail) return `${hash.slice(0, head)}...`;
  return `${hash.slice(0, head)}...${hash.slice(-tail)}`;
}

/** unix seconds -> "HH:MM:SS" UTC clock */
export function fmtTime(unixSec: number): string {
  return new Date(unixSec * 1000).toISOString().slice(11, 19);
}

/** "42s ago" / "3m ago" / "2h ago" */
export function timeAgo(unixSec: number): string {
  const d = Math.max(0, Math.floor(Date.now() / 1000) - unixSec);
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

export function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

/** Duration in blocks -> rough wall-clock text at 60s/block. */
export function blocksToTime(blocks: number): string {
  const secs = blocks * 60;
  if (secs < 3600) return `~${Math.round(secs / 60)} min`;
  if (secs < 86400) return `~${(secs / 3600).toFixed(1)} h`;
  return `~${(secs / 86400).toFixed(1)} days`;
}
// probe 1787841226
