/**
 * Source hygiene - the anonymity and language mandates as a regression net.
 * Every scan the release checklist demands, executable on every commit:
 *   - zero Turkish-specific characters anywhere in authored sources
 *   - zero country / regulator references
 *   - zero banned tokenomics vocabulary (emission halves smoothly, there is
 *     no fixed-cap vocabulary and no legacy supply number)
 *   - pure ASCII everywhere, with ONE grandfathered exception: the block-art
 *     logo on the home page (explicitly requested art, not text)
 *   - package authorship stays exactly "Tyler Durden" - no location, no email
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "dev-smoke"]);
const SKIP_FILES = new Set(["package-lock.json", "bitweb-source.zip"]);
const EXTENSIONS = [".ts", ".tsx", ".js", ".json", ".md", ".html", ".css"];
const EXTRA_FILES = ["public/_headers", "README.md", "network.config.ts", "index.html"];

function authoredFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name) || SKIP_FILES.has(name)) continue;
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (EXTENSIONS.some((e) => name.endsWith(e))) out.push(p);
    }
  };
  for (const top of ["src", "contracts", "public"]) walk(join(ROOT, top));
  for (const f of EXTRA_FILES) out.push(join(ROOT, f));
  return out.filter((f) => !f.endsWith(SCANNER));
}

// The one place non-ASCII art is allowed: the ASCII_LOGO template literal in
// ui.tsx. Strip that constant before the ASCII scan of that one file.
function stripLogo(source: string): string {
  return source.replace(
    /const ASCII_LOGO = (?:String\.raw)?`[\s\S]*?`;/,
    'const ASCII_LOGO = "";',
  );
}

// This scanner file contains the banned patterns AS PATTERNS (that is its
// job) - it is the single file exempt from being scanned.
const SCANNER = join("src", "hygiene.test.ts");

const TURKISH = /[şğüöçıŞĞÜÖÇİ]/;
const COUNTRIES =
  /\b(turkey|turkish|türkiye|turkiye|germany|german|france|french|spain|italy|china|chinese|russia|russian|japan|india|brazil|argentina|netherlands|switzerland|sweden|norway|poland|ukraine|united states|united kingdom|great britain|canada|australia|istanbul|ankara|izmir|berlin|paris|london|madrid|rome|moscow|beijing|tokyo|washington)\b/i;
const REGULATORS = /\b(MiCA|BaFin|CFTC|FINMA|MASAC|AMF)\b|\b(SEC|FCA|MAS)\b/;
const BANNED_TOKENOMICS = /\bhalving\b|21[,.]?000[,.]?000|\b21 million\b|\bMAX_SUPPLY\b/i;
const LEGACY_NETWORK = /\btestnets?\b/i;
// contracts/protocol.ts is FROZEN by decree (consensus): its comments are
// part of the mainnet birth record and stay as historical documentation.
const FROZEN_CONSENSUS = join("contracts", "protocol.ts");

describe("source hygiene", () => {
  const files = authoredFiles();
  it("the scan covers the whole authored tree", () => {
    expect(files.length).toBeGreaterThan(40);
  });

  it("zero Turkish-specific characters in any authored file", () => {
    const offenders = files.filter((f) => TURKISH.test(readFileSync(f, "utf8")));
    expect(offenders.map((f) => relative(ROOT, f))).toEqual([]);
  });

  it("zero country, city or regulator references", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const s = readFileSync(f, "utf8");
      if (COUNTRIES.test(s) || REGULATORS.test(s)) offenders.push(relative(ROOT, f));
    }
    expect(offenders).toEqual([]);
  });

  it("zero banned tokenomics vocabulary", () => {
    const offenders = files.filter((f) =>
      BANNED_TOKENOMICS.test(readFileSync(f, "utf8")),
    );
    expect(offenders.map((f) => relative(ROOT, f))).toEqual([]);
  });

  it("zero legacy-network vocabulary outside the frozen consensus file", () => {
    const offenders = files.filter(
      (f) => !f.endsWith(FROZEN_CONSENSUS) && LEGACY_NETWORK.test(readFileSync(f, "utf8")),
    );
    expect(offenders.map((f) => relative(ROOT, f))).toEqual([]);
  });

  it("pure ASCII everywhere except the grandfathered logo art", () => {
    const offenders: string[] = [];
    for (const f of files) {
      let s = readFileSync(f, "utf8");
      if (f.endsWith(join("src", "components", "term", "ui.tsx"))) s = stripLogo(s);
      for (const ch of s) {
        if (ch.codePointAt(0)! > 0x7e) {
          offenders.push(relative(ROOT, f));
          break;
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("authorship is exactly Tyler Durden - no location, no email", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      author?: string;
      email?: string;
    };
    expect(pkg.author).toBe("Tyler Durden");
    expect(pkg.email).toBeUndefined();
    // and no email address anywhere in authored sources
    const emailish =
      /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|mailto:/i;
    const offenders = files.filter((f) => emailish.test(readFileSync(f, "utf8")));
    expect(offenders.map((f) => relative(ROOT, f))).toEqual([]);
  });
});
