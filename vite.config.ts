import path from "path";
const __dirname = import.meta.dirname;
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Pure static build - no dev-server middleware, no backend. `base: "./"`
// keeps asset URLs relative so the dist/ folder works from ANY web root:
// GitHub Pages project subpaths, Netlify, IPFS gateways, file mirrors.
export default defineConfig(({ command }) => ({
  base: "./",
  plugins: [react()],
  // dev pre-bundle cache: node_modules is not writable on every mount
  cacheDir: ".vite",
  // Dev serves public/ directly; build copies it via scripts/copy-public.mjs
  // instead (read/write copy - the copyfile syscall is not portable).
  publicDir: command === "serve" ? "public" : false,
  server: {
    port: 3000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@contracts": path.resolve(__dirname, "./contracts"),
    },
  },
  build: {
    outDir: path.resolve(__dirname, "dist"),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Split the heavy libraries out of the app chunk: the browser caches
        // vendor code across deploys, and the initial parse shrinks. peerjs
        // stays a lazy chunk on top of this (dynamic import in transport.ts).
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return undefined;
          // subpath imports ("@noble/hashes/sha2.js") need id matching, not
          // bare-package records
          if (id.includes("/@noble/")) return "vendor-crypto";
          if (id.includes("/qrcode/") || id.includes("/jsqr/")) return "vendor-qr";
          if (
            id.includes("/react/") ||
            id.includes("/react-dom/") ||
            id.includes("/react-router/") ||
            id.includes("/@tanstack/")
          ) {
            return "vendor-react";
          }
          return undefined;
        },
      },
    },
  },
}));
