import { useRef, useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { useNode } from "@/providers/node-context";
import { ChainConflictError, ChainDowngradeError } from "@/node/client";
import { beginChainUpdate, setChainGateDetail } from "@/node/chain-gate";
import { useQueryClient } from "@tanstack/react-query";
import { Cursor, Divider, Panel, Stat, SupplyLogo } from "@/components/term/ui";
import { cn } from "@/lib/utils";
import {
  fmtBurnPct,
  fmtCoins,
  fmtCompact,
  fmtHashrate,
  fmtInt,
  shortAddr,
  shortHash,
  timeAgo,
} from "@/lib/format";
import {
  LEGAL_DISCLAIMER,
  MAX_TXS_PER_BLOCK,
  RETARGET_INTERVAL,
  SOFT_CAP_SUPPLY,
  TARGET_BLOCK_TIME,
} from "@contracts/protocol";

const FIXES: Array<[string, string, string]> = [
  ["BLOCK TIME", "600 s", `${TARGET_BLOCK_TIME} s - usable confirmations`],
  ["DIFFICULTY RETARGET", "2016 blocks", `${RETARGET_INTERVAL} blocks - tracks hashrate live`],
  ["TIMESTAMP DRIFT", "2 hours", "15 minutes - tighter consensus clock"],
  ["ADDRESS MODEL", "UTXO + change", "accounts + sequential nonces - replay-proof by default"],
  ["SCRIPT SURFACE", "100+ opcodes", "none - signatures only, minimal attack surface"],
  ["MINING ACCESS", "ASIC cartels", "any browser tab - one browser, one vote"],
  ["MINING SPEED", "fastest hardware wins", "70,000 H/s cap on every device - phone equals datacenter"],
  ["MINER STREAKS", "winner takes the next block too", "cooldown from block 2,000 - no two in a row"],
  ["MINING ARMS RACE", "rack more rigs", "one miner per browser - Web Locks API + channel fallback"],
  ["SYBIL FLOODS", "free fake identities", "handshake proof-of-work - CPU before data flows"],
  ["CHAIN PORTABILITY", "the chain dies with the site", "one-file export / validated import / opt-in pruning"],
  ["EMISSION", "cut in half every 210,000 blocks", "x10 bootstrap then exponential decay - one smooth curve"],
  ["SUPPLY CAP", "21M hard cap", "~42M soft cap - asymptotic, never enforced"],
  ["BLOCK REWARD", "100% subsidy + fees to the miner", "70/20/10 - miner, connected peers, burned"],
  ["PEER REWARDS", "nothing for keeping a node online", "20% pool paid to peers with signed attestations"],
  ["POP VERIFICATION", "trust the miner's word", "every attestation verified by every node - no faked lists"],
  ["TRANSACTION FEES", "paid to the miner", "100% burned - usage itself tightens supply"],
  ["CODEBASE", "~100k lines C++", "~9k lines TypeScript - read it in a weekend"],
];

export default function Terminal() {
  const node = useNode();
  const info = useQuery({ queryKey: ["info"], queryFn: () => node.info(), refetchInterval: 5000 });
  // Early-warning telemetry: all local/session-scoped (see node.health()).
  const health = useQuery({
    queryKey: ["health"],
    queryFn: () => node.health(),
    refetchInterval: 5000,
  });
  const blocks = useQuery({
    queryKey: ["recentBlocks", 12],
    queryFn: () => node.recentBlocks(12),
    refetchInterval: 5000,
  });
  const d = info.data;
  const [portMsg, setPortMsg] = useState("");
  const [portBusy, setPortBusy] = useState(false);
  const [lastExport, setLastExport] = useState<{ height: number; tip: string } | null>(null);
  const [conflict, setConflict] = useState<{
    kind: "fork" | "downgrade";
    local: { height: number; hash: string };
    incoming: { height: number; hash: string };
  } | null>(null);
  const pendingImportRef = useRef<unknown>(null);
  const chainFileRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  const doExport = async () => {
    setPortBusy(true);
    setPortMsg("");
    setConflict(null);
    try {
      const data = await node.exportChain();
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data)], { type: "application/json" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = `bitweb-chain-${data.height}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
      setLastExport({ height: data.height, tip: data.blocks[data.blocks.length - 1].hash });
      setPortMsg(`exported ${fmtInt(data.height + 1)} blocks - the chain fits in a file`);
    } catch (err) {
      setPortMsg(`export failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setPortBusy(false);
    }
  };

  const runImport = async (parsed: unknown, opts?: { replace?: boolean; allowDowngrade?: boolean }) => {
    const res = await node.importChain(parsed, opts);
    if (res.applied) {
      setPortMsg(`imported and validated ${fmtInt(res.height)} blocks - every hash recomputed, zero trust`);
      // the chain was rebuilt: every cached view (balances, history, info)
      // is stale - recompute all of it from the new single source of truth.
      // AWAITED, not kicked: the caller's gate (and with it the UPDATING
      // overlay and the mining pause) holds until the new numbers - the
      // coins - are actually rendered, not just stored.
      await queryClient.invalidateQueries();
    } else {
      setPortMsg("already up to date - the file's tip is exactly your local tip");
    }
    setLastExport(null);
    setConflict(null);
    await Promise.all([info.refetch(), blocks.refetch()]);
  };

  const doImport = async (f: File | undefined) => {
    if (!f) return;
    setPortBusy(true);
    setPortMsg("");
    setConflict(null);
    // The gate opens BEFORE the first byte is read: from file selection to
    // the final refetch the system is passive - mining cannot start and a
    // running miner is already parked (the gate paused it synchronously).
    const gateDone = beginChainUpdate("importing a chain file");
    setChainGateDetail("reading file");
    try {
      const parsed: unknown = JSON.parse(await f.text());
      pendingImportRef.current = parsed;
      await runImport(parsed);
    } catch (err) {
      if (err instanceof ChainDowngradeError) {
        // shorter chain: BLOCKED by default - the dangerous override must
        // show both heights AND both tip hashes before it can run
        setConflict({ kind: "downgrade", local: err.local, incoming: err.incoming });
      } else if (err instanceof ChainConflictError) {
        // equal-height fork: default keep-local, replace is opt-in
        setConflict({ kind: "fork", local: err.local, incoming: err.incoming });
      } else {
        setPortMsg(`import failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      gateDone();
      setPortBusy(false);
    }
  };

  const doImportReplace = async () => {
    if (!conflict || pendingImportRef.current === null) return;
    setPortBusy(true);
    setPortMsg("");
    // the user confirmed the dangerous override - the apply runs under the
    // gate exactly like the first attempt
    const gateDone = beginChainUpdate("importing a chain file");
    try {
      await runImport(pendingImportRef.current, {
        replace: true,
        allowDowngrade: conflict.kind === "downgrade",
      });
    } catch (err) {
      setPortMsg(`replace failed: ${err instanceof Error ? err.message : String(err)}`);
      setConflict(null);
    } finally {
      gateDone();
      setPortBusy(false);
    }
  };

  const doPrune = async () => {
    if (!d) return;
    const horizon = d.height - 2_048;
    if (horizon <= 0) {
      setPortMsg("chain too young to prune - nothing to gain yet");
      return;
    }
    if (
      !window.confirm(
        `Prune confirmed transaction history below block ${fmtInt(horizon)}? Block headers and ` +
          "balances stay; this terminal stops SERVING those old blocks to syncing peers. This cannot be undone.",
      )
    ) {
      return;
    }
    setPortBusy(true);
    setPortMsg("");
    try {
      const removed = await node.pruneBelow(horizon);
      setPortMsg(`pruned ${fmtInt(removed)} historical transaction rows below #${fmtInt(horizon)}`);
    } catch (err) {
      setPortMsg(`prune failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setPortBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="pt-2">
        <SupplyLogo supply={d?.totalSupply ?? 0} softCap={SOFT_CAP_SUPPLY} />
        <p className="glow-soft mt-2 text-center text-sm tracking-[0.3em] text-neutral-400">
          PEER-TO-PEER ELECTRONIC CASH FOR THE OPEN WEB
        </p>
        <p className="mt-1 text-center text-xs text-neutral-600">
          NO BANKS - NO PREMINE - NO PERMISSION - MINED BY BROWSERS <Cursor />
        </p>
        {/* the deflation heartbeat, always visible: share of the soft cap
            that can never be spent again, with the absolute figure beside it
            in the topbar's compact balance format */}
        <p className="mt-1 text-center text-[11px] tracking-[0.15em] text-neutral-600">
          BURNED FOREVER:{" "}
          <span data-testid="burned-forever" className="glow-soft text-neutral-400">
            {d ? fmtBurnPct(d.totalBurned, SOFT_CAP_SUPPLY) : "-"}
          </span>
          {d && d.totalBurned > 0 ? (
            <span className="text-neutral-600"> ({fmtCompact(d.totalBurned)} BTWB)</span>
          ) : null}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Stat label="Chain Height" value={d ? `#${fmtInt(d.height)}` : "SYNC..."} sub={d ? timeAgo(d.tipTimestamp) : ""} />
        <Stat label="Difficulty" value={d ? d.difficulty.toFixed(4) : "-"} sub={d ? `retarget in ${d.nextRetargetIn} blk` : ""} />
        <Stat label="Network Hashrate" value={d ? fmtHashrate(d.hashrate) : "-"} sub={d?.avgBlockTime ? `avg block ${d.avgBlockTime.toFixed(1)}s` : "awaiting blocks"} />
        <Stat
          label="Supply / ~42M soft cap"
          value={d ? fmtCoins(d.totalSupply) : "-"}
          sub="BTWB minted by PoW only"
        />
        <Stat
          label="Block Reward"
          value={d ? fmtCoins(d.blockReward) : "-"}
          sub={
            d
              ? d.bootstrapBlocksLeft > 0
                ? `bootstrap x10 - ${fmtInt(d.bootstrapBlocksLeft)} blk left`
                : `miner ${fmtCoins(d.rewardSplit.miner)} - peers ${fmtCoins(d.rewardSplit.perPeer)} x${d.rewardSplit.perPeer > 0 ? "N" : "0"} - burn ${fmtCoins(d.rewardSplit.burn)}`
              : ""
          }
        />
        <Stat label="Mempool" value={d ? `${d.mempoolSize}` : "-"} sub="pending transfers" />
        <Stat label="Holders" value={d ? fmtInt(d.activeAccounts) : "-"} sub="funded addresses" />
        <Stat label="Transactions" value={d ? fmtInt(d.txsTotal) : "-"} sub="confirmed on-chain" />
        <Stat label="P2P Peers" value={d ? fmtInt(d.peerCount) : "-"} sub="equal nodes, no center" />
        <Stat label="Protocol" value={d ? `v${d.protocolVersion}` : "-"} sub={d ? `${d.chainId} - open source` : "open source"} />
      </div>

      {/* early-warning strip: the network's vital signs, visible to everyone.
          A stale-block storm, a sync lag, a peer collapse or storage pressure
          shows up HERE before it becomes a failure. Session-scoped counters. */}
      <div className="border border-neutral-700 px-3 py-2" data-testid="network-health">
        <div className="mb-1 text-[10px] font-bold tracking-[0.25em] text-neutral-500">
          NETWORK HEALTH - EARLY WARNING
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] tabular-nums">
          <span>
            <span className="text-neutral-500">PEERS </span>
            <span className={cn("font-bold", (health.data?.peers ?? 0) === 0 ? "text-neutral-500" : "text-neutral-200")}>
              {health.data ? `${health.data.peers}/${health.data.peerCap}` : "-"}
            </span>
          </span>
          <span title="how far behind the best-known peer chain this node is">
            <span className="text-neutral-500">SYNC </span>
            <span className={cn("font-bold", (health.data?.syncLag ?? 0) > 0 ? "text-neutral-100 underline decoration-dotted" : "text-neutral-200")}>
              {health.data ? (health.data.syncLag > 0 ? `${health.data.syncLag} BEHIND` : "IN SYNC") : "-"}
            </span>
          </span>
          <span title="gossiped blocks that did not extend our tip (session)">
            <span className="text-neutral-500">STALE </span>
            <span className="font-bold text-neutral-200">{health.data?.gossipStale ?? "-"}</span>
          </span>
          <span title="invalid gossiped blocks rejected, strike-earning (session)">
            <span className="text-neutral-500">REJECTED </span>
            <span className={cn("font-bold", (health.data?.gossipRejected ?? 0) > 0 ? "text-neutral-100 underline decoration-dotted" : "text-neutral-200")}>
              {health.data?.gossipRejected ?? "-"}
            </span>
          </span>
          <span title="deep sync runs / blocks rolled back across forks (session)">
            <span className="text-neutral-500">SYNCS </span>
            <span className="font-bold text-neutral-200">
              {health.data ? `${health.data.syncs}/${health.data.syncRollbacks}RB` : "-"}
            </span>
          </span>
          <span title="peer links closed for any reason (session)">
            <span className="text-neutral-500">DROPS </span>
            <span className="font-bold text-neutral-200">{health.data?.peerDrops ?? "-"}</span>
          </span>
          <span>
            <span className="text-neutral-500">MEMPOOL </span>
            <span className="font-bold text-neutral-200">
              {health.data ? `${health.data.mempoolSize}/${health.data.mempoolCap}` : "-"}
            </span>
          </span>
          <span title={health.data?.storage.persisted === false ? "browser may evict this data under quota pressure - export a backup" : "local storage pressure"}>
            <span className="text-neutral-500">STORAGE </span>
            <span className={cn("font-bold", health.data?.storage.persisted === false ? "text-neutral-100 underline decoration-dotted" : "text-neutral-200")}>
              {!health.data
                ? "-"
                : health.data.storage.mode === "memory"
                  ? "MEMORY-ONLY"
                  : health.data.storage.usagePct !== null
                    ? `${health.data.storage.usagePct}%${health.data.storage.persisted === false ? " EVICTABLE" : ""}`
                    : "-"}
            </span>
          </span>
        </div>
      </div>

      <Panel title="Block Zero - the message in the genesis" className="border-neutral-600">
        <p className="glow-soft border-l-2 border-neutral-400 pl-3 text-[13px] italic leading-relaxed text-neutral-200">
          "{d?.genesisMessage ?? "..."}"
        </p>
        <p className="mt-1.5 text-right text-[11px] text-neutral-500">
          - Chuck Palahniuk, FIGHT CLUB (1996) - hidden in the coinbase, unspendable forever
        </p>
        <p className="text-[11px] text-neutral-600">
          genesis hash: <span className="break-all text-neutral-400">{d?.genesisHash ?? "..."}</span>
        </p>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-5">
        <Panel title="Latest Blocks" className="min-w-0 lg:col-span-3" bodyClassName="p-0 overflow-x-auto">
          <table className="term-table w-full text-xs sm:min-w-[520px]">
            <thead>
              <tr>
                <th>Height</th>
                <th className="hidden sm:table-cell">Hash</th>
                <th>Age</th>
                <th className="hidden sm:table-cell">TX</th>
                <th className="hidden sm:table-cell">Reward</th>
                <th className="hidden sm:table-cell">Miner</th>
              </tr>
            </thead>
            <tbody>
              {(blocks.data ?? []).map((b) => (
                <tr key={b.height}>
                  <td className="text-neutral-100">#{fmtInt(b.height)}</td>
                  <td className="hidden text-neutral-400 sm:table-cell">{shortHash(b.hash, 14)}</td>
                  <td className="text-neutral-500">{timeAgo(b.timestamp)}</td>
                  <td className="hidden sm:table-cell">{b.txCount}</td>
                  <td className="hidden sm:table-cell">{fmtCoins(b.reward)}</td>
                  <td className="hidden text-neutral-500 sm:table-cell" title={b.miner}>
                    {b.height === 0 ? "GENESIS" : shortAddr(b.miner, 8, 4)}
                  </td>
                </tr>
              ))}
              {!blocks.data?.length && (
                <tr>
                  <td colSpan={6} className="py-4 text-center text-neutral-600">
                    SYNCING<Cursor />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Panel>

        <div className="min-w-0 space-y-4 lg:col-span-2">
          <Panel title="Boot Sequence">
            <ol className="space-y-1.5 text-xs">
              <li>
                <span className="text-neutral-500">01&nbsp;</span>
                <Link className="link-term" to="/wallet">
                  GENERATE A WALLET
                </Link>
                <span className="text-neutral-500"> - secp256k1 keys, minted locally</span>
              </li>
              <li>
                <span className="text-neutral-500">02&nbsp;</span>
                <Link className="link-term" to="/wallet">
                  KEEP THE TAB OPEN &amp; MINE
                </Link>
                <span className="text-neutral-500"> - real SHA-256d proof-of-work</span>
              </li>
              <li>
                <span className="text-neutral-500">03&nbsp;</span>
                <Link className="link-term" to="/transfers">
                  TRANSFER BTWB
                </Link>
                <span className="text-neutral-500"> - signed in-browser, settled on-chain</span>
              </li>
              <li>
                <span className="text-neutral-500">04&nbsp;</span>
                <Link className="link-term" to="/manifesto">
                  READ THE MANIFESTO
                </Link>
                <span className="text-neutral-500"> - why this exists</span>
              </li>
            </ol>
          </Panel>

          <Panel title="Open Protocol">
            <p className="text-xs text-neutral-400">
              Every rule lives in one file - <span className="text-neutral-200">contracts/protocol.ts</span> - shared
              verbatim by node and browser. Fork it, audit it, run your own node.
            </p>
            <div className="mt-2 grid grid-cols-2 gap-x-3 text-[11px] text-neutral-500">
              <span>block time</span>
              <span className="text-right text-neutral-300">{TARGET_BLOCK_TIME}s</span>
              <span>retarget</span>
              <span className="text-right text-neutral-300">{RETARGET_INTERVAL} blk</span>
              <span>emission</span>
              <span className="text-right text-neutral-300">x10 boot then exp decay</span>
              <span>reward split</span>
              <span className="text-right text-neutral-300">70 / 20 / 10</span>
              <span>tx / block</span>
              <span className="text-right text-neutral-300">{MAX_TXS_PER_BLOCK}</span>
            </div>
            <a className="term-btn mt-3 w-full text-center" href="./bitweb-source.zip">
              v DOWNLOAD FULL SOURCE
            </a>
            <p className="mt-3 border-t border-neutral-800 pt-2 text-[10px] leading-relaxed text-neutral-600">
              {LEGAL_DISCLAIMER}
            </p>
          </Panel>
        </div>
      </div>

      <Panel title="Chain Portability - the chain outlives the site">
        <p className="mb-3 text-xs text-neutral-400">
          This terminal is a full node: the entire chain lives in your browser. Export it to a
          file, import it on a fresh node (every block is re-validated - an import is a sync,
          not a trust decision), or prune old history to shrink storage. If this site ever
          disappears, the chain file plus the source zip above are all the network needs.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button className="term-btn" disabled={portBusy || !d} onClick={() => void doExport()}>
            v EXPORT CHAIN
          </button>
          <button
            className="term-btn"
            disabled={portBusy || !d}
            title="import a chain file - fully validated; a conflicting local chain needs your explicit confirmation"
            onClick={() => chainFileRef.current?.click()}
          >
            ^ IMPORT CHAIN
          </button>
          <button className="term-btn" disabled={portBusy || !d} onClick={() => void doPrune()}>
            x PRUNE OLD HISTORY
          </button>
          <input
            ref={chainFileRef}
            type="file"
            accept=".json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = ""; // re-selecting the same file must fire again
              void doImport(f);
            }}
          />
          {portMsg ? <span className="text-[11px] text-neutral-500">{portMsg}</span> : null}
        </div>
        {lastExport ? (
          <p className="mt-2 border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-[11px] text-neutral-400">
            EXPORTED HEIGHT <span className="text-neutral-200">#{fmtInt(lastExport.height)}</span>
            {" - "}TIP{" "}
            <span className="break-all font-bold text-neutral-100">{lastExport.tip}</span>
            <br />
            <span className="text-neutral-500">
              verify this tip hash out-of-band before trusting the file on another node
            </span>
          </p>
        ) : null}
        {conflict ? (
          <div
            role="alert"
            data-testid="chain-conflict-panel"
            className="mt-2 space-y-2 border border-neutral-400 bg-neutral-900 px-3 py-2 text-[11px]"
          >
            <p className="font-bold tracking-[0.2em] text-neutral-100">
              {conflict.kind === "downgrade"
                ? "IMPORT BLOCKED - THE FILE IS SHORTER THAN YOUR CHAIN"
                : "CHAIN CONFLICT - VERIFY BEFORE REPLACING"}
            </p>
            {conflict.kind === "downgrade" ? (
              <p className="text-neutral-300">
                Imported chain is SHORTER (H:{fmtInt(conflict.incoming.height)}) than your local
                chain (H:{fmtInt(conflict.local.height)}). Importing would lose{" "}
                {fmtInt(conflict.local.height - conflict.incoming.height)} block(s). Blocked.
              </p>
            ) : null}
            <p className="text-neutral-400">
              LOCAL TIP <span className="text-neutral-200">#{fmtInt(conflict.local.height)}</span>
              <br />
              <span className="break-all text-neutral-100">{conflict.local.hash}</span>
            </p>
            <p className="text-neutral-400">
              FILE TIP <span className="text-neutral-200">#{fmtInt(conflict.incoming.height)}</span>
              <br />
              <span className="break-all text-neutral-100">{conflict.incoming.hash}</span>
            </p>
            <p className="leading-relaxed text-neutral-500">
              {conflict.kind === "downgrade"
                ? "Downgrading deletes confirmed history from this terminal - almost never what you want. The override below is logged and irreversible. Your wallet keys are not touched."
                : "The file was fully validated, but it is NOT your chain. Replacing wipes this terminal's chain copy and rebuilds it from the file - irreversible. Your wallet keys are not touched. Compare both tip hashes out-of-band before you proceed."}
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                className="term-btn"
                data-testid="confirm-replace-chain"
                disabled={portBusy}
                onClick={() => void doImportReplace()}
              >
                {conflict.kind === "downgrade"
                  ? "DANGER: IMPORT SHORTER CHAIN ANYWAY"
                  : "REPLACE MY CHAIN"}
              </button>
              <button
                className="term-btn term-btn-primary"
                disabled={portBusy}
                onClick={() => {
                  setConflict(null);
                  setPortMsg("import cancelled - local chain untouched");
                }}
              >
                KEEP MY CHAIN
              </button>
            </div>
          </div>
        ) : null}
      </Panel>

      <Divider label="Why BitWeb fixes Bitcoin" />
      <div className="overflow-x-auto border border-neutral-800">
        <table className="term-table w-full min-w-[560px] text-xs">
          <thead>
            <tr>
              <th className="w-40">Parameter</th>
              <th className="w-44">Bitcoin (2009)</th>
              <th>BitWeb (2026)</th>
            </tr>
          </thead>
          <tbody>
            {FIXES.map(([k, btc, btw]) => (
              <tr key={k}>
                <td className="text-neutral-500">{k}</td>
                <td className="text-neutral-400 line-through decoration-neutral-700">{btc}</td>
                <td className="text-neutral-100">{btw}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="pb-2 text-center text-[11px] text-neutral-600">
        EXPERIMENTAL NETWORK - EVERY FIGURE ON THIS PAGE IS READ LIVE FROM THE CHAIN - NOTHING IS
        SIMULATED <Cursor />
      </p>
    </div>
  );
}
