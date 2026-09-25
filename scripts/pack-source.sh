#!/usr/bin/env bash
# Packs the full BitWeb browser-node source tree into public/bitweb-source.zip
# — the file the Terminal page SOURCE link serves. Runs automatically on EVERY
# build (scripts/copy-public.mjs execs this before copying public/ -> dist/),
# so the downloadable snapshot can never lag behind the shipped code.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="public/bitweb-source.zip"
# zip replaces archives via temp-file + rename(2), which some filesystems
# (network/FUSE mounts) reject. Build in /tmp, then plain-copy into place.
TMP="$(mktemp /tmp/bitweb-source.XXXXXX.zip)"
rm -f "$TMP" # zip cannot replace an existing archive on every filesystem
MARKER_DIR="$(mktemp -d /tmp/bitweb-marker.XXXXXX)"
MARKER="$MARKER_DIR/BUILD-INFO.txt" # fixed basename: zip -j keeps it at the archive root
trap 'rm -f "$TMP"; rm -rf "$MARKER_DIR"' EXIT

# Build marker baked into every snapshot: proves WHICH build the zip came
# from. Regenerated on every run, so two builds can never ship the same zip.
VERSION="$(node -p "require('./package.json').version" 2>/dev/null || echo "0.0.0")"
{
  echo "BITWEB SOURCE SNAPSHOT"
  echo "built_at_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "version: ${VERSION}"
  echo "chain: bitweb-mainnet-1"
} > "$MARKER"

# .github rides along: the Pages deploy workflow must travel WITH the
# sources, or a fresh repo receiving this zip has no workflow to unpack it.
zip -r "$TMP" \
  src contracts public scripts .github \
  index.html network.config.ts \
  package.json package-lock.json \
  tsconfig.json tsconfig.app.json tsconfig.node.json \
  vite.config.ts vitest.config.ts \
  tailwind.config.js postcss.config.js components.json eslint.config.js \
  README.md LICENSE \
  -x "public/bitweb-source.zip" \
  -x "src/node-dist/*" \
  -x "node_modules/*" \
  -x "dist/*" \
  -x ".git/*" \
  > /dev/null

# Marker sits at the archive root, next to README.md.
zip -j "$TMP" "$MARKER" > /dev/null

rm -f "$OUT"
cp "$TMP" "$OUT"

echo "packed $(du -h "$OUT" | cut -f1) → $OUT"
