/**
 * ===========================================================================
 *  BITWEB MAINNET - SEED NODE
 * ===========================================================================
 *  Keeps one fully-synced, always-mining browser node online 24/7, so the
 *  chain never sleeps and every new tab finds a live peer on its first
 *  dial wave. This is just a headless Chromium running the normal web app -
 *  the network has no privileged nodes; a seed is a tab that never closes.
 *
 *  Setup:
 *    npm i puppeteer-core          (this script's only dependency)
 *    export APP_URL=https://your-bitweb-host.example
 *    node seed-node.mjs
 *
 *  Environment:
 *    APP_URL        (required) the deployed BitWeb app URL
 *    SEED_PRIVKEY   (optional) 64-hex payout identity. On first run without
 *                   it a wallet is generated INSIDE the persistent browser
 *                   profile (.seed-profile/), which survives restarts - set
 *                   the printed key to keep the identity across reinstalls.
 *    CHROME_PATH    (optional) chromium executable; common paths are probed
 *    PROFILE_DIR    (optional) default ./.seed-profile
 *
 *  The loop auto-relaunches the browser on any crash with capped backoff.
 * ===========================================================================
 */
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";

const APP_URL = process.env.APP_URL;
if (!APP_URL) {
  console.error("APP_URL is required (the deployed BitWeb app URL)");
  process.exit(1);
}
const SEED_PRIVKEY = process.env.SEED_PRIVKEY ?? null;
if (SEED_PRIVKEY && !/^[0-9a-f]{64}$/i.test(SEED_PRIVKEY)) {
  console.error("SEED_PRIVKEY must be 64 hex characters");
  process.exit(1);
}
const PROFILE_DIR = process.env.PROFILE_DIR ?? new URL("./.seed-profile", import.meta.url).pathname;

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/nix/var/nix/profiles/default/bin/chromium",
].filter(Boolean);
const chromePath = CHROME_CANDIDATES.find((p) => existsSync(p));

let puppeteer;
try {
  puppeteer = await import("puppeteer-core");
} catch {
  console.error("missing dependency - run: npm i puppeteer-core");
  process.exit(1);
}
if (!chromePath) {
  console.error("no chromium found - set CHROME_PATH");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runOnce() {
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: "new",
    userDataDir: PROFILE_DIR, // chain + wallet survive restarts
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(120_000);
    page.on("pageerror", (e) => console.log("[seed] page error:", String(e).slice(0, 200)));

    await page.goto(`${APP_URL}/#/wallet`, { waitUntil: "domcontentloaded" });

    // identity: import the pinned key, else generate once (profile persists)
    if (SEED_PRIVKEY) {
      await page.waitForSelector("input[placeholder*='64 hex']");
      await page.type("input[placeholder*='64 hex']", SEED_PRIVKEY);
      await page.evaluate(() => {
        const b = [...document.querySelectorAll("button")].find(
          (x) => (x.textContent || "").trim() === "IMPORT",
        );
        b?.click();
      });
    } else {
      const generated = await page.evaluate(() => {
        const b = [...document.querySelectorAll("button")].find((x) =>
          /GENERATE WALLET/i.test(x.textContent || ""),
        );
        if (b) {
          b.click();
          return true;
        }
        return false; // wallet already exists in this profile
      });
      if (generated) {
        console.log("[seed] fresh wallet generated inside the profile;");
        console.log("[seed] to pin an identity across reinstalls, set SEED_PRIVKEY to any");
        console.log(`[seed] 64-hex secret, e.g. ${randomBytes(32).toString("hex")}`);
      }
    }

    // start mining
    await page.waitForFunction(() => {
      const b = [...document.querySelectorAll("button")].find(
        (x) => /START MINING/i.test(x.textContent || "") && !x.disabled,
      );
      if (b) {
        b.click();
        return true;
      }
      return false;
    });
    await page.waitForFunction(
      () => document.body.innerText.includes("ENGINE ONLINE"),
      { timeout: 60_000 },
    );
    console.log("[seed] engine online - mining for the network");

    // heartbeat: log chain height once a minute; throw if the page dies
    for (;;) {
      await sleep(60_000);
      const status = await page.evaluate(() => {
        const m = /CHAIN HEIGHT\s+#([\d,]+)/i.exec(document.body.innerText);
        return { height: m ? m[1] : "?", peersUp: document.body.innerText.includes("PEERS") };
      });
      console.log(`[seed] alive - chain height #${status.height} @ ${new Date().toISOString()}`);
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

let backoff = 5_000;
for (;;) {
  try {
    await runOnce();
  } catch (e) {
    console.log(`[seed] session ended: ${String(e).slice(0, 200)}`);
  }
  console.log(`[seed] relaunching in ${backoff / 1000}s`);
  await sleep(backoff);
  backoff = Math.min(backoff * 2, 60_000);
}
