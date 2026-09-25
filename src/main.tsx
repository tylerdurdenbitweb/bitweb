import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router";
import "./index.css";
import { NodeProvider } from "@/providers/node";
import { clearStaleChunkGuardSoon, recoverStaleChunk } from "@/lib/chunk-recovery";
import App from "./App.tsx";

// Deploy-race recovery lives in chunk-recovery.ts (shared with the lazy
// route validator): one guarded hard reload onto the fresh shell, capped at
// a single attempt per tab session so a broken deploy cannot loop forever.
// Vite raises this dedicated event when a dynamic import's chunk 404s.
window.addEventListener("vite:preloadError", (e) => {
  e.preventDefault();
  recoverStaleChunk(e.payload);
});
// Safari words the same failure differently ("Importing a module script
// failed."); catch the rejection form too.
window.addEventListener("unhandledrejection", (e) => {
  const msg = String((e.reason as Error | undefined)?.message ?? e.reason ?? "");
  if (/dynamically imported module|importing a module script|module script failed/i.test(msg)) {
    recoverStaleChunk(e.reason);
  }
});
// And the classic <script>/<link> tag failure for the eager entry chunk.
window.addEventListener(
  "error",
  (e) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "SCRIPT" || t.tagName === "LINK")) recoverStaleChunk(t);
  },
  true,
);
// A healthy boot clears the guard after a settling window, so a deploy days
// later still gets its one recovery reload.
window.addEventListener("load", () => clearStaleChunkGuardSoon());

// HashRouter: this build deploys as pure static files (GitHub Pages /
// Netlify / any web root) - there is no server to rewrite deep links.
console.info(`[boot] bitweb build ${__BITWEB_BUILD__}`);
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <HashRouter>
      <NodeProvider>
        <App />
      </NodeProvider>
    </HashRouter>
  </StrictMode>,
);

// PWA: register the app-shell service worker (offline boot + installability).
// Registered after render so first paint never waits on it; failure here
// must never take the node down - the app works identically without a SW.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((err) => {
      console.warn("[pwa] service worker registration failed:", err);
    });
  });
}
