import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router";
import "./index.css";
import { NodeProvider } from "@/providers/node";
import App from "./App.tsx";

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
