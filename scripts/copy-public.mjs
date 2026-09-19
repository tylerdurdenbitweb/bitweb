#!/usr/bin/env node
/**
 * Copies public/ into dist/ after `vite build`. Vite's own publicDir copy
 * uses the copyfile(2) syscall, which some filesystems (network/FUSE
 * mounts, some CI volumes) reject with EPERM. This does the same job with
 * plain read/write, which works everywhere. Dev mode is unaffected - the
 * dev server serves publicDir directly. Enabled via `publicDir: false`
 * for build only in vite.config.ts.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const root = import.meta.dirname + "/..";
const SRC = path.resolve(root, "public");
const DST = path.resolve(root, "dist");

// The downloadable source bundle must always match the tree being built -
// repack it on every build so it can never silently go stale again.
execFileSync("bash", [path.resolve(root, "scripts/pack-source.sh")], {
  cwd: root,
  stdio: "inherit",
});

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDir(from, to);
    } else if (entry.isFile()) {
      fs.writeFileSync(to, fs.readFileSync(from));
    }
  }
}

if (!fs.existsSync(DST)) {
  console.error("copy-public: dist/ does not exist - run vite build first");
  process.exit(1);
}
copyDir(SRC, DST);

// Stamp the service worker with a content hash of this exact build: every
// deploy gets a fresh cache namespace, the old one is purged on activate,
// and a stale worker can never serve pre-update code after a release.
const hash = crypto.createHash("sha256");
for (const name of fs.readdirSync(path.join(DST, "assets")).sort()) {
  hash.update(name);
  hash.update(fs.readFileSync(path.join(DST, "assets", name)));
}
hash.update(fs.readFileSync(path.join(DST, "index.html")));
const buildId = hash.digest("hex").slice(0, 12);
const swPath = path.join(DST, "sw.js");
fs.writeFileSync(
  swPath,
  fs.readFileSync(swPath, "utf8").replaceAll("__BUILD_ID__", buildId),
);
console.log(`copied public/ -> dist/ (sw build ${buildId})`);
