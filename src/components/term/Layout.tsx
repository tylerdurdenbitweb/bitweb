import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { useNode } from "@/providers/node-context";
import {
  getChainGateState,
  subscribeChainGate,
  type ChainGateState,
} from "@/node/chain-gate";
import { useFeedbackWatcher } from "@/hooks/useFeedbackWatcher";
import { useStorageWarning } from "@/hooks/useStorageWarning";
import { useWallet } from "@/hooks/useWallet";
import { setChainWakeLock } from "@/lib/wake-lock";
import { NotificationBell } from "@/components/term/NotificationBell";
import { InstallApp } from "@/components/term/InstallApp";
import { TerminalProgressBar } from "@/components/term/ui";
import { fmtCompact } from "@/lib/format";
import { cn } from "@/lib/utils";

const NAV = [
  { key: "1", to: "/", label: "TERMINAL" },
  { key: "2", to: "/wallet", label: "WALLET" },
  { key: "3", to: "/transfers", label: "TRANSFERS" },
  { key: "4", to: "/dashboard", label: "DASHBOARD" },
  { key: "5", to: "/manifesto", label: "MANIFESTO" },
];

/* -- boot sequence -------------------------------------------------------- */
const BOOT_LINES = [
  "BITWEB/OS v1.0 - PHOSPHOR TERMINAL EMULATION",
  "(C) 2026 BITWEB COLLECTIVE - NO RIGHTS RESERVED",
  "38911 BASIC BYTES FREE - 64K RAM SYSTEM",
  "LOADING PROTOCOL ............ OK",
  "SECP256K1 FIELD ............. OK",
  "SHA-256D ENGINE ............. OK",
  "CONNECTING TO BITWEB-MAINNET-1 . OK",
  "READY.",
];

function BootOverlay({ onDone }: { onDone: () => void }) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const t = setInterval(() => {
      setShown((s) => {
        if (s >= BOOT_LINES.length) {
          clearInterval(t);
          setTimeout(onDone, 500);
          return s;
        }
        return s + 1;
      });
    }, 130);
    const dismiss = () => {
      clearInterval(t);
      onDone();
    };
    window.addEventListener("keydown", dismiss);
    window.addEventListener("pointerdown", dismiss);
    return () => {
      clearInterval(t);
      window.removeEventListener("keydown", dismiss);
      window.removeEventListener("pointerdown", dismiss);
    };
  }, [onDone]);

  return (
    <div className="fixed inset-0 z-[100] bg-black p-6 sm:p-10" data-testid="boot-overlay">
      <div className="font-term text-lg leading-relaxed text-neutral-200 sm:text-2xl">
        {BOOT_LINES.slice(0, shown).map((l, i) => (
          <div key={i} style={{ animation: "boot-line 0.05s both" }}>
            {l}
          </div>
        ))}
        <span className="blink">_</span>
      </div>
    </div>
  );
}

/* -- chain update overlay --------------------------------------------------- */
// While the chain mutates through ANY path (file import, peer sync, fork
// rollback, prune) the system goes passive behind this centered window. It
// cannot be dismissed - it closes itself when every block is applied and
// the balances are recomputed. Two timing rules keep it honest: it only
// APPEARS after 250ms (a single gossiped block lands in milliseconds and
// must not flash a modal), and it lingers 150ms before closing so
// back-to-back operations read as one calm update, not a strobe.
// Show threshold: a single gossiped block applies in a few hundred ms on a
// phone, so a 250ms threshold flashed the full-screen UPDATING overlay on
// EVERY block - and each flash force-pauses mining. 1200ms keeps the
// overlay for genuinely long work (sync bursts, imports, heals) while
// routine one-block updates pass silently through the header indicator.
const CHAIN_OVERLAY_SHOW_MS = 1_200;
const CHAIN_OVERLAY_HIDE_MS = 150;

function ChainUpdateOverlay() {
  const [state, setState] = useState<ChainGateState>(() => getChainGateState());
  const [visible, setVisible] = useState(false);
  // Ticking clock for the liveness line: during a long heal (zombie storage
  // reopening, a slow peer) the detail text can sit unchanged for seconds -
  // an unmoving window reads as a crash. The elapsed counter proves the
  // event loop - and the update - is alive.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => subscribeChainGate(setState), []);

  // An untouched iPhone auto-locks mid-update and the sleep kills every
  // socket and zombifies IndexedDB (the "frozen at attempt 2" loop). Hold
  // the screen awake for exactly the gate's lifetime.
  useEffect(() => {
    setChainWakeLock(state.active);
  }, [state.active]);

  useEffect(() => {
    if (!visible) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [visible]);

  useEffect(() => {
    if (state.active && !visible) {
      const t = setTimeout(() => setVisible(true), CHAIN_OVERLAY_SHOW_MS);
      return () => clearTimeout(t);
    }
    if (!state.active && visible) {
      const t = setTimeout(() => setVisible(false), CHAIN_OVERLAY_HIDE_MS);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [state.active, visible]);

  if (!visible) return null;
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label="Chain update in progress"
      data-testid="chain-update-overlay"
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/85 p-4"
    >
      <div className="w-full max-w-md border border-neutral-600 bg-black px-5 py-6 font-term shadow-[0_0_50px_rgba(255,255,255,0.10)]">
        <p className="text-center text-xl font-bold tracking-[0.3em] text-white [text-shadow:0_0_10px_rgba(255,255,255,0.5)] sm:text-2xl">
          UPDATING<span className="blink">...</span>
        </p>
        <p className="mt-4 text-center text-xs tracking-[0.18em] text-neutral-300">
          {state.reason ?? "chain update in progress"}
        </p>
        {state.detail ? (
          <p
            data-testid="chain-update-detail"
            className="mt-1.5 text-center text-[11px] tabular-nums tracking-[0.18em] text-neutral-400"
          >
            {state.detail}
          </p>
        ) : null}
        {/* the wait must never look frozen: a determinate bar when the
            operation measures itself (sync/import blocks), a pulsing frame
            when it cannot */}
        <TerminalProgressBar
          current={state.progress?.current ?? null}
          total={state.progress?.total ?? null}
          className="mt-4"
        />
        {state.progress ? (
          <p
            data-testid="chain-update-counts"
            className="mt-1.5 text-center text-[11px] tabular-nums tracking-[0.18em] text-neutral-500"
          >
            {state.progress.current.toLocaleString("en-US")} /{" "}
            {state.progress.total.toLocaleString("en-US")}
          </p>
        ) : null}
        {state.startedAt ? (
          <p
            data-testid="chain-update-elapsed"
            className="mt-1 text-center text-[10px] tabular-nums tracking-[0.18em] text-neutral-600"
          >
            ELAPSED {Math.max(0, Math.floor((now - state.startedAt) / 1000))}S
          </p>
        ) : null}
        <div className="mt-5 border-t border-neutral-800 pt-3 text-center text-[10px] leading-relaxed tracking-[0.14em] text-neutral-500">
          SYSTEM PASSIVE - MINING PARKED - NO CLICKS
          <br />
          COINS SETTLE WHEN THIS WINDOW CLOSES<span className="blink">_</span>
        </div>
      </div>
    </div>
  );
}

/* -- layout --------------------------------------------------------------- */
export function Layout({ children }: { children: ReactNode }) {
  // Global incoming-payment cue: watches the wallet balance for increases.
  useFeedbackWatcher();
  useStorageWarning();
  const navigate = useNavigate();
  const location = useLocation();
  const [booted, setBooted] = useState(
    () => sessionStorage.getItem("btwb.booted") === "1",
  );
  const node = useNode();
  const info = useQuery({
    queryKey: ["info"],
    queryFn: () => node.info(),
    refetchInterval: 5000,
    retry: 1,
  });

  // Topbar balance: the SAME query key the Wallet/Transfers pages poll, so
  // the topbar, wallet page and transfer page can never disagree - one
  // cache, one source of truth (the chain's derived account state).
  const { wallet } = useWallet();
  const addr = wallet?.address ?? null;
  const acct = useQuery({
    queryKey: ["address", addr],
    queryFn: () => node.address(addr!),
    enabled: !!addr,
    refetchInterval: 4000,
  });
  const balanceText = addr ? fmtCompact(acct.data?.balance ?? 0) : null;

  // Browser online/offline events + query health drive the outage banner.
  const [onLine, setOnLine] = useState(() => navigator.onLine);
  useEffect(() => {
    const up = () => setOnLine(true);
    const down = () => setOnLine(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);
  // No server to lose - but a full node with zero peers is alone on the
  // network. Two distinct banners: browser offline vs. no peers connected.
  const noPeers = (info.data?.peerCount ?? 0) === 0;
  // Storage blocked (private mode?) - the node runs session-only, say so.
  const memoryOnly = node.storageMode === "memory";
  // Clickjacking backstop: _headers carries X-Frame-Options on hosts that
  // support it, but static hosts like GitHub Pages ignore it - so when the
  // app detects it is inside a frame, it says so itself. (Reference compare
  // only - never dereferences .top, so cross-origin frames stay safe.)
  const embedded = typeof window !== "undefined" && window.self !== window.top;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")
      )
        return;
      // Ctrl/Cmd+M toggles mining. The miner lives on the Wallet page, so
      // from anywhere else we leave a pending flag and navigate there.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "m") {
        e.preventDefault();
        if (location.pathname === "/wallet") {
          window.dispatchEvent(new CustomEvent("btwb.toggle-mining"));
        } else {
          sessionStorage.setItem("btwb.pendingMineToggle", "1");
          navigate("/wallet");
        }
        return;
      }
      const item = NAV.find((n) => n.key === e.key);
      if (item) navigate(item.to);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, location.pathname]);

  return (
    <div className="flex min-h-screen min-h-dvh flex-col bg-black text-neutral-200">
      {!booted ? (
        <BootOverlay
          onDone={() => {
            sessionStorage.setItem("btwb.booted", "1");
            setBooted(true);
            // fresh boot only: the Terminal wordmark sweeps 0->100%->real now
            window.dispatchEvent(new CustomEvent("btwb.booted"));
          }}
        />
      ) : null}

      {/* top status bar - ONE line at every width 320-1920px: nowrap flex,
          the nav collapses into an invisible-scrollbar strip, and every
          ticking value sits in a fixed-width monospace cell so updates never
          shift, wrap or reflow the bar */}
      <header className="sticky top-0 z-40 border-b border-neutral-700 bg-black/95 relative">
        <div className="mx-auto flex max-w-[1200px] flex-nowrap items-center gap-x-1.5 overflow-hidden px-2 py-2 min-[480px]:gap-x-3 min-[480px]:px-3">
          <Link
            to="/"
            className="font-term glow shrink-0 whitespace-nowrap text-base leading-none hover:bg-neutral-200 hover:text-black min-[480px]:text-xl sm:text-2xl"
          >
            BITWEB
          </Link>
          <nav className="no-scrollbar flex min-w-0 flex-1 flex-nowrap items-center gap-0.5 overflow-x-auto whitespace-nowrap min-[480px]:gap-1">
            {NAV.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.to === "/"}
                className={({ isActive }) =>
                  cn(
                    "shrink-0 px-1.5 py-0.5 text-xs tracking-[0.1em] min-[480px]:px-2 min-[480px]:tracking-[0.15em]",
                    isActive
                      ? "bg-neutral-200 font-bold text-black"
                      : "text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100",
                  )
                }
              >
                [{n.key}]<span className="hidden min-[480px]:inline"> {n.label}</span>
              </NavLink>
            ))}
          </nav>
          {/* confirmed balance in "BTWB: {value}" form, BEFORE the bell -
              dim label + bright value; the 5ch floor + tabular figures mean
              same-length ticks never shift anything, and the bell, anchored
              absolute at the far right, can never be pushed off-screen */}
          <div className="flex shrink-0 items-baseline whitespace-nowrap text-xs text-neutral-500">
            <span title={addr ? "confirmed balance (BTWB)" : "no wallet on this terminal"}>
              {/* the text label costs ~50px - on narrow phones the four nav
                  keys need it more than the value does */}
              <span className="hidden tracking-[0.15em] min-[480px]:inline">BTWB: </span>
              <span
                data-testid="topbar-balance"
                className={cn(
                  "inline-block min-w-[5ch] tracking-[0.15em] tabular-nums",
                  balanceText === null ? "text-neutral-600" : "text-neutral-200",
                )}
              >
                {balanceText ?? "--"}
              </span>
            </span>
          </div>
          {/* reserves the top-right corner for the bell */}
          <div className="w-7 shrink-0 min-[480px]:w-9" aria-hidden="true" />
          {/* the bell is the ONLY button in this corner. Anchored absolute so
              the header can never push it off-screen - and its dropdown,
              being right-aligned to the bell, can never overflow the left
              edge. */}
          <div className="absolute right-2 top-2 min-[480px]:right-3 sm:right-4">
            <NotificationBell />
          </div>
        </div>
      </header>

      {/* embedded-view warning - persistent while framed (clickjacking backstop) */}
      {embedded ? (
        <div
          role="alert"
          data-testid="embedded-banner"
          className="border-b border-neutral-400 bg-neutral-200 px-3 py-1 text-center text-[11px] font-bold tracking-[0.2em] text-black"
        >
          EMBEDDED VIEW DETECTED - VERIFY THE URL BEFORE ENTERING KEYS
        </div>
      ) : null}

      {/* storage fallback banner - persistent while memory-only */}
      {memoryOnly ? (
        <div
          role="alert"
          data-testid="memory-only-banner"
          className="border-b border-neutral-400 bg-neutral-200 px-3 py-1 text-center text-[11px] font-bold tracking-[0.2em] text-black"
        >
          STORAGE BLOCKED - RUNNING IN MEMORY-ONLY MODE - DATA WILL NOT SURVIVE RELOAD
        </div>
      ) : null}

      {/* network banners - the chain keeps running either way */}
      {!onLine || noPeers ? (
        <div
          role="alert"
          className="border-b border-neutral-400 bg-neutral-200 px-3 py-1 text-center text-[11px] font-bold tracking-[0.2em] text-black"
        >
          {!onLine
            ? "YOU ARE OFFLINE - RECONNECTING AUTOMATICALLY - KEYS NEVER LEAVE THIS DEVICE"
            : "NO PEERS CONNECTED - WAITING FOR NETWORK - THIS TAB IS A FULL NODE - KEYS NEVER LEAVE THIS DEVICE"}
        </div>
      ) : null}

      <main className="mx-auto w-full max-w-[1200px] flex-1 px-4 pb-10 pt-4 sm:px-3 sm:pb-4">{children}</main>

      {/* passive-mode window: up whenever the chain is being updated through
          any path, down only when every block and coin has settled */}
      <ChainUpdateOverlay />

      <footer className="border-t border-neutral-800 px-3 py-3 text-[11px] text-neutral-600">
        <div className="mx-auto flex max-w-[1200px] flex-wrap items-center gap-x-4 gap-y-1">
          <span>
            {(info.data?.chainId ?? "bitweb-mainnet-1").toUpperCase()} - PEER-TO-PEER ELECTRONIC CASH
          </span>
          <span className="hidden sm:inline">-</span>
          <span>
            DIFFICULTY{" "}
            {info.data ? info.data.difficulty.toFixed(4) : "-"}
          </span>
          <span className="hidden sm:inline">-</span>
          <span>MEMPOOL {info.data ? `${info.data.mempoolSize} TX` : "-"}</span>
          <span className="hidden sm:inline">-</span>
          <span title="build stamp - check this after every deploy to know which release this tab runs">
            BUILD {__BITWEB_BUILD__}
          </span>
          <span className="hidden md:inline">-</span>
          <span className="hidden md:inline">NO COOKIES - NO TRACKERS - NO STORED IPS</span>
          <InstallApp />
          <span className={cn("ml-auto", location.pathname === "/" && "blink")}>_</span>
        </div>
      </footer>

      {/* CRT layers */}
      <div className="crt-overlay" />
      <div className="crt-vignette" />
      <div className="crt-flicker" />
    </div>
  );
}
