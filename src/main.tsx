import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router";
import "./index.css";
import { NodeProvider } from "@/providers/node";
import App from "./App.tsx";

// Deploy-race recovery. Every release ships freshly hashed asset names, and
// a static host serves only the NEW set - a tab still holding the previous
// index.html 404s its chunks on the next load. That is exactly what iOS
// does all the time: Safari discards background tabs, and the discarded
// tab's reload hits asset names the deploy already deleted. The fix is one
// guarded hard reload onto the fresh shell; a sessionStorage flag caps it
// at a single attempt per tab session so a genuinely broken deploy cannot
// loop forever.
const RELOAD_FLAG = "btwb-stale-chunk-reload";
function recoverStaleChunk(reason: unknown): void {
  console.warn("[boot] asset 404 after deploy - reloading onto the fresh shell:", reason);
  try {
    if (sessionStorage.getItem(RELOAD_FLAG)) return;
    sessionStorage.setItem(RELOAD_FLAG, "1");
  } catch {
    // storage blocked (private mode): reload anyway - the flag is a loop
    // guard, not a requirement
  }
  location.reload();
}
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
window.addEventListener("load", () => {
  setTimeout(() => {
    try {
      sessionStorage.removeItem(RELOAD_FLAG);
    } catch {
      /* storage blocked - nothing to clear */
    }
  }, 20_000);
});

// HashRouter: this build deploys as pure static files (GitHub Pages /
// Netlify / any web root) - there is no server to rewrite deep links.
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
