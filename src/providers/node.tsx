/**
 * Node provider - boots the in-browser full node ONCE, then hands the
 * handle to the whole tree through context. Replaces the server version's
 * tRPC provider: the "API" is the local chain, not an HTTP endpoint.
 *
 * Rendering is gated until the node is ready (storage opened, genesis
 * sealed, wallet hydrated, transports started) so hooks can read wallet
 * state synchronously from the first frame.
 */
import { useEffect, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { bootNode, type NodeHandle } from "@/node/client";
import { chainHooks } from "@/node/chain";
import { getChainGateState, subscribeChainGate, type ChainGateState } from "@/node/chain-gate";
import {
  getBootProgress,
  setBootPhase,
  setBootProgress,
  subscribeBootProgress,
  type BootProgressState,
} from "@/node/boot-progress";
import { TerminalProgressBar } from "@/components/term/ui";
import { notify } from "@/lib/notify";
import { resetLocalData } from "@/lib/reset";
import { NodeContext } from "./node-context";

const queryClient = new QueryClient();

/**
 * Boot splash with a live status line. The node boot holds the chain gate
 * ("starting up") until the first sync decision, so the splash can say what
 * is actually happening - waking the transports, then checking whether the
 * network has a longer chain - instead of sitting silent for seconds.
 */
function BootSplash() {
  const [gate, setGate] = useState<ChainGateState>(() => getChainGateState());
  const [boot, setBoot] = useState<BootProgressState>(() => getBootProgress());
  // local ticker: the bounded "checking for a longer chain" phase animates
  // start->end in the splash instead of looking like a frozen wait. The clock
  // is read in the rAF callback (never during render) and kept in state.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => subscribeChainGate(setGate), []);
  useEffect(() => subscribeBootProgress(setBoot), []);
  useEffect(() => {
    if (boot.windowStart === null || boot.windowEnd === null) return;
    let raf = 0;
    const tick = () => {
      setNow(Date.now());
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [boot.windowStart, boot.windowEnd]);

  // Bar numbers: measured phases report current/total directly; the bounded
  // sync window derives them from the clock.
  let cur = boot.current;
  let tot = boot.total;
  if (boot.windowStart !== null && boot.windowEnd !== null) {
    tot = boot.windowEnd - boot.windowStart;
    cur = now === null ? 0 : Math.min(Math.max(0, now - boot.windowStart), tot);
  }
  return (
    <div className="flex min-h-screen items-center justify-center bg-black text-neutral-200">
      <div className="w-full max-w-md px-6 text-center font-term text-lg">
        <p>
          STARTING UP<span className="blink">_</span>
        </p>
        <p
          data-testid="boot-splash-phase"
          className="mt-4 min-h-5 text-xs tracking-[0.18em] text-neutral-300"
        >
          {boot.phase ? boot.phase.toUpperCase() : "\u00a0"}
        </p>
        <TerminalProgressBar current={cur} total={tot} className="mt-3 text-sm" />
        {cur !== null && tot !== null && boot.windowStart === null ? (
          <p
            data-testid="boot-splash-counts"
            className="mt-1.5 text-[11px] tabular-nums tracking-[0.18em] text-neutral-500"
          >
            {cur.toLocaleString("en-US")} / {tot.toLocaleString("en-US")}
          </p>
        ) : null}
        {gate.active ? (
          <p
            data-testid="boot-splash-status"
            className="mt-4 text-xs tracking-[0.18em] text-neutral-400"
          >
            UPDATING: {gate.reason}
            {gate.detail ? ` - ${gate.detail}` : ""}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function NodeProvider({ children }: { children: ReactNode }) {
  const [node, setNode] = useState<NodeHandle | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let handle: NodeHandle | null = null;
    let knownPeerIds = new Set<string>();
    let peakPeers = 0;
    let meshAnnouncedAt = 0;
    // A whole-chain replacement (deep-fork repair adopting a proven-longer
    // remote chain) is what a history-rewrite attempt looks like from the
    // inside. Consensus must follow the longest valid chain - but the human
    // must HEAR about it: audible tier, with the heights, so an unexpected
    // big rewrite can never pass silently.
    const onReplaced = (tip: { height: number; hash: string }) => {
      void queryClient.invalidateQueries({ queryKey: ["info"] });
      void queryClient.invalidateQueries({ queryKey: ["health"] });
      notify(
        "error",
        `Chain replaced by a longer valid chain - new height #${tip.height.toLocaleString("en-US")} ` +
          `(tip ${tip.hash.slice(0, 12)}...). If you did not expect a big rewrite, check the network.`,
      );
    };
    chainHooks.onChainReplaced.push(onReplaced);
    // Peer roster changes refresh the info/health views instantly - the
    // NO PEERS banner reacts in milliseconds instead of at the next 5s poll.
    // Notifications are COALESCED: one quiet "mesh reached" entry when the
    // roster goes 0 -> N (throttled, silent tier) instead of a panel row
    // per peer - a busy room would otherwise bury real money events in
    // join spam. A COLLAPSE from a session peak still fires a system
    // notification (early warning, 60s-deduped).
    bootNode({
      onPeerChange: () => {
        void queryClient.invalidateQueries({ queryKey: ["info"] });
        void queryClient.invalidateQueries({ queryKey: ["health"] });
        const roster = handle?.peers() ?? [];
        const hadNone = knownPeerIds.size === 0;
        knownPeerIds = new Set(roster.map((p) => p.id));
        if (roster.length > 0 && hadNone && Date.now() - meshAnnouncedAt > 10 * 60_000) {
          meshAnnouncedAt = Date.now();
          notify(
            "peer_connected",
            `Connected to the BitWeb mesh - ${roster.length} peer${roster.length === 1 ? "" : "s"} online`,
          );
        }
        // A sudden drop below half the session peak is what an eclipse
        // attempt or a signaling outage looks like from the inside.
        peakPeers = Math.max(peakPeers, roster.length);
        if (peakPeers >= 4 && roster.length <= Math.floor(peakPeers / 2)) {
          notify(
            "system",
            `Peer count dropped sharply (${peakPeers} -> ${roster.length}) - check connectivity`,
          );
          peakPeers = roster.length; // re-arm at the new baseline
        }
      },
    })
      .then(async (n) => {
        if (cancelled) {
          n.stop(); // unmounted mid-boot (StrictMode dev double-mount) - no leak
          return;
        }
        handle = n;
        // Land the splash bar on 100% before it leaves. Boot phases end
        // early BY DESIGN (a sync decision can release the wait window
        // mid-animation), and an opening that never showed a full bar reads
        // as broken - "it opened before 100%". Snap to full, hold a beat so
        // the eye registers it, then open the terminal.
        setBootPhase("ready");
        setBootProgress(1, 1);
        await new Promise((r) => setTimeout(r, 300));
        if (cancelled) return; // cleanup stops the handle
        setNode(n);
        // dev-only introspection handle for live network debugging (e2e probes)
        if (import.meta.env.DEV) {
          (window as unknown as { __btwbNode?: NodeHandle }).__btwbNode = n;
        }
      })
      .catch((err) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        // One confusing message is worse than two clear ones: the double-bind
        // case means a live instance already owns the node in this page.
        setError(
          /already bound/i.test(msg)
            ? "ANOTHER TAB IS RUNNING THE NODE. Close it or use it."
            : msg,
        );
      });
    return () => {
      cancelled = true;
      const i = chainHooks.onChainReplaced.indexOf(onReplaced);
      if (i >= 0) chainHooks.onChainReplaced.splice(i, 1);
      handle?.stop();
    };
  }, []);

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-black p-6 text-neutral-200">
        <div className="max-w-lg border border-neutral-700 p-4 font-term text-sm leading-relaxed">
          <p className="mb-2 font-bold">NODE BOOT FAILURE</p>
          <p className="text-neutral-400">{error}</p>
          <p className="mt-3 text-xs text-neutral-600">
            If storage is blocked the node usually falls back to memory-only mode
            on its own - this screen means something else broke.
          </p>
          <button
            type="button"
            className="term-btn mt-4 px-3 py-1 text-xs"
            onClick={() => {
              if (
                window.confirm(
                  "Delete ALL BitWeb data on this device (chain copy, wallet keys, preferences) and reload? This cannot be undone.",
                )
              )
                void resetLocalData();
            }}
          >
            [ RESET LOCAL DATA ]
          </button>
        </div>
      </div>
    );
  }

  if (!node) {
    return <BootSplash />;
  }

  return (
    <NodeContext.Provider value={node}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </NodeContext.Provider>
  );
}
