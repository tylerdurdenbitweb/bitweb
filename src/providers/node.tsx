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
  useEffect(() => subscribeChainGate(setGate), []);
  return (
    <div className="flex min-h-screen items-center justify-center bg-black text-neutral-200">
      <div className="px-6 text-center font-term text-lg">
        SEALING GENESIS / OPENING NODE DATABASE ...<span className="blink">_</span>
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
      .then((n) => {
        if (cancelled) {
          n.stop(); // unmounted mid-boot (StrictMode dev double-mount) - no leak
          return;
        }
        handle = n;
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
