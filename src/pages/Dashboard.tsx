import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNode } from "@/providers/node-context";
import { Cursor, Divider, Panel, Stat } from "@/components/term/ui";
import { cn } from "@/lib/utils";
import {
  fmtCoins,
  fmtHashrate,
  fmtInt,
  shortAddr,
  shortHash,
  timeAgo,
} from "@/lib/format";
import {
  blockContentsAvailable,
  blockFeeTotals,
  linkHealth,
  sortPeers,
  txsByBlock,
} from "@/lib/dashboard";
import type { BlockRow } from "@/node/storage";

/**
 * NETWORK DASHBOARD - the whole chain on one screen: who is connected, how
 * hard the network is mining, what the latest blocks carry, and which
 * transfers are still waiting for a block. Everything is read locally from
 * THIS node (its storage, its engine, its mempool) and re-polled every few
 * seconds; react-query pauses the polling while the tab is hidden, so an
 * iOS screen lock costs zero battery and zero traffic.
 */

const POLL_MS = 4_000;
const BLOCK_WINDOW = 25;
const TX_WINDOW = 80;

function healthTone(h: "live" | "quiet" | "stale"): string {
  if (h === "live") return "text-emerald-300";
  if (h === "quiet") return "text-amber-300";
  return "text-red-400";
}

function PeersPanel() {
  const node = useNode();
  const peers = useQuery({
    queryKey: ["dashboard", "peers"],
    queryFn: async () => node.peers(),
    refetchInterval: POLL_MS,
  });
  // dataUpdatedAt is react-query's own timestamp for this snapshot - using
  // it (instead of a fresh Date.now()) keeps render pure AND ties the link
  // health reading to the moment the rows were actually observed.
  const now = peers.dataUpdatedAt;
  const rows = sortPeers(peers.data ?? []);

  return (
    <Panel
      title={`Connected Nodes (${rows.length})`}
      bodyClassName="p-0 overflow-x-auto"
    >
      <table className="term-table w-full text-xs min-[640px]:min-w-[560px]">
        <thead>
          <tr>
            <th>Node</th>
            <th className="hidden sm:table-cell">Transport</th>
            <th>Height</th>
            <th className="hidden md:table-cell">Agent</th>
            <th>Link</th>
            <th className="hidden sm:table-cell">Since</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const health = linkHealth(p, now);
            return (
              <tr key={`${p.transport}:${p.id}`}>
                <td className="text-neutral-100" title={p.id}>
                  {shortHash(p.id, 10, 4)}
                  {p.strikes > 0 && (
                    <span className="ml-1 text-amber-400" title={`${p.strikes} strike(s)`}>
                      !{p.strikes}
                    </span>
                  )}
                </td>
                <td className="hidden text-neutral-400 sm:table-cell">{p.transport}</td>
                <td>#{fmtInt(p.height)}</td>
                <td className="hidden max-w-[140px] truncate text-neutral-500 md:table-cell" title={p.agent}>
                  {p.agent}
                </td>
                <td className={healthTone(health)}>{health.toUpperCase()}</td>
                <td className="hidden text-neutral-500 sm:table-cell">
                  {timeAgo(Math.floor(p.connectedAt / 1000))}
                </td>
              </tr>
            );
          })}
          {!rows.length && (
            <tr>
              <td colSpan={6} className="py-4 text-center text-neutral-600">
                NO PEERS CONNECTED - discovery keeps retrying on every transport
                <Cursor />
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </Panel>
  );
}

function MiningPanel() {
  const node = useNode();
  const info = useQuery({
    queryKey: ["info"],
    queryFn: () => node.info(),
    refetchInterval: POLL_MS,
  });
  const d = info.data;

  return (
    <Panel title="Network Mining Power">
      <div className="space-y-2">
        <div className="glow font-term text-3xl text-neutral-100 sm:text-4xl">
          {d ? fmtHashrate(d.hashrate) : "-"}
        </div>
        <p className="text-[11px] text-neutral-500">
          estimated from the last 30 blocks of work vs. wall-clock time
        </p>
        <Divider />
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
          <dt className="text-neutral-500">Difficulty</dt>
          <dd className="text-right text-neutral-200">{d ? fmtInt(Math.round(d.difficulty)) : "-"}</dd>
          <dt className="text-neutral-500">Avg block time</dt>
          <dd className="text-right text-neutral-200">
            {d?.avgBlockTime ? `${d.avgBlockTime.toFixed(1)} s` : "-"}
          </dd>
          <dt className="text-neutral-500">Retarget in</dt>
          <dd className="text-right text-neutral-200">
            {d ? `${fmtInt(d.nextRetargetIn)} blocks` : "-"}
          </dd>
          <dt className="text-neutral-500">Block reward</dt>
          <dd className="text-right text-neutral-200">
            {d ? `${fmtCoins(d.blockReward)} BTWB` : "-"}
          </dd>
          <dt className="text-neutral-500">Active accounts</dt>
          <dd className="text-right text-neutral-200">{d ? fmtInt(d.activeAccounts) : "-"}</dd>
          <dt className="text-neutral-500">Total supply</dt>
          <dd className="text-right text-neutral-200">
            {d ? `${fmtCoins(d.totalSupply)} BTWB` : "-"}
          </dd>
        </dl>
      </div>
    </Panel>
  );
}

function BlockContents({ block }: { block: BlockRow }) {
  const node = useNode();
  const txs = useQuery({
    queryKey: ["dashboard", "recentTxs", TX_WINDOW],
    queryFn: () => node.recentTxs(TX_WINDOW),
    refetchInterval: POLL_MS,
  });
  const byBlock = txsByBlock(txs.data ?? []);
  const rows = byBlock.get(block.height) ?? [];

  if (!blockContentsAvailable(block, byBlock)) {
    return (
      <p className="px-3 py-2 text-[11px] text-neutral-600">
        contents sit outside the recent-transaction window - older blocks keep
        their hashes forever but may have tx detail pruned from this view
      </p>
    );
  }
  if (!rows.length) {
    return (
      <p className="px-3 py-2 text-[11px] text-neutral-600">
        empty block - coinbase only, no transfers included
      </p>
    );
  }
  const totals = blockFeeTotals(rows);
  return (
    <div className="px-3 py-2">
      <table className="term-table w-full text-[11px]">
        <tbody>
          {rows.map((t) => (
            <tr key={t.txid}>
              <td className="w-[72px] text-neutral-500">{t.type.toUpperCase()}</td>
              <td className="text-neutral-400" title={t.fromAddress ?? "coinbase"}>
                {t.fromAddress ? shortAddr(t.fromAddress, 8, 4) : "COINBASE"}
              </td>
              <td className="w-[20px] text-center text-neutral-600">&gt;</td>
              <td className="text-neutral-400" title={t.toAddress}>
                {shortAddr(t.toAddress, 8, 4)}
              </td>
              <td className="text-right text-neutral-100">{fmtCoins(t.amount)}</td>
              <td className="hidden text-right text-neutral-600 sm:table-cell">
                fee {fmtCoins(t.fee)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1.5 text-right text-[10px] text-neutral-600">
        {totals.transfers} transfer(s) - {fmtCoins(totals.fees)} BTWB burned in fees
        {block.message ? ` - block message: "${block.message}"` : ""}
      </p>
    </div>
  );
}

function BlocksPanel() {
  const node = useNode();
  const [open, setOpen] = useState<number | null>(null);
  const blocks = useQuery({
    queryKey: ["dashboard", "recentBlocks", BLOCK_WINDOW],
    queryFn: () => node.recentBlocks(BLOCK_WINDOW),
    refetchInterval: POLL_MS,
  });
  const rows = blocks.data ?? [];

  return (
    <Panel
      title={`Latest Blocks (last ${BLOCK_WINDOW}) - tap a row for contents`}
      bodyClassName="p-0 overflow-x-auto"
    >
      <table className="term-table w-full text-xs min-[640px]:min-w-[560px]">
        <thead>
          <tr>
            <th>Height</th>
            <th className="hidden sm:table-cell">Hash</th>
            <th>Age</th>
            <th>TX</th>
            <th className="hidden sm:table-cell">Reward</th>
            <th className="hidden md:table-cell">Miner</th>
            <th className="w-[24px]" />
          </tr>
        </thead>
        <tbody>
          {rows.map((b) => (
            <Fragment key={b.height}>
              <tr
                className="cursor-pointer hover:bg-neutral-900/60"
                onClick={() => setOpen(open === b.height ? null : b.height)}
              >
                <td className="text-neutral-100">#{fmtInt(b.height)}</td>
                <td className="hidden text-neutral-400 sm:table-cell">{shortHash(b.hash, 14)}</td>
                <td className="text-neutral-500">{timeAgo(b.timestamp)}</td>
                <td>{b.txCount}</td>
                <td className="hidden sm:table-cell">{fmtCoins(b.reward)}</td>
                <td className="hidden text-neutral-500 md:table-cell" title={b.miner}>
                  {b.height === 0 ? "GENESIS" : shortAddr(b.miner, 8, 4)}
                </td>
                <td className="text-neutral-600">{open === b.height ? "[-]" : "[+]"}</td>
              </tr>
              {open === b.height && (
                <tr>
                  <td colSpan={7} className="border-t border-neutral-800 bg-neutral-950/60 p-0">
                    <BlockContents block={b} />
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
          {!rows.length && (
            <tr>
              <td colSpan={7} className="py-4 text-center text-neutral-600">
                SYNCING<Cursor />
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </Panel>
  );
}

function TransactionsPanel() {
  const node = useNode();
  const mempool = useQuery({
    queryKey: ["dashboard", "mempool", 30],
    queryFn: () => node.mempool(30),
    refetchInterval: POLL_MS,
  });
  const txs = useQuery({
    queryKey: ["dashboard", "recentTxs", TX_WINDOW],
    queryFn: () => node.recentTxs(TX_WINDOW),
    refetchInterval: POLL_MS,
  });
  const pending = mempool.data ?? [];
  const confirmed = (txs.data ?? []).filter((t) => t.type === "transfer").slice(0, 25);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel title={`Pending Transfers (${pending.length})`} bodyClassName="p-0 overflow-x-auto">
        <table className="term-table w-full text-xs">
          <thead>
            <tr>
              <th>From</th>
              <th />
              <th>To</th>
              <th className="text-right">Amount</th>
              <th className="hidden text-right sm:table-cell">Fee</th>
            </tr>
          </thead>
          <tbody>
            {pending.map((t) => (
              <tr key={t.txid}>
                <td className="text-neutral-400" title={t.fromAddress}>
                  {shortAddr(t.fromAddress, 8, 4)}
                </td>
                <td className="w-[20px] text-center text-neutral-600">&gt;</td>
                <td className="text-neutral-400" title={t.toAddress}>
                  {shortAddr(t.toAddress, 8, 4)}
                </td>
                <td className="text-right text-neutral-100">{fmtCoins(t.amount)}</td>
                <td className="hidden text-right text-neutral-600 sm:table-cell">
                  {fmtCoins(t.fee)}
                </td>
              </tr>
            ))}
            {!pending.length && (
              <tr>
                <td colSpan={5} className="py-4 text-center text-neutral-600">
                  MEMPOOL EMPTY - no transfers waiting for a block
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Panel>

      <Panel title="Recent Transactions (confirmed)" bodyClassName="p-0 overflow-x-auto">
        <table className="term-table w-full text-xs">
          <thead>
            <tr>
              <th>Type</th>
              <th>From</th>
              <th />
              <th>To</th>
              <th className="text-right">Amount</th>
              <th className="hidden sm:table-cell">Block</th>
            </tr>
          </thead>
          <tbody>
            {confirmed.map((t) => (
              <tr key={t.txid}>
                <td className="w-[72px] text-neutral-500">{t.type.toUpperCase()}</td>
                <td className="text-neutral-400" title={t.fromAddress ?? ""}>
                  {t.fromAddress ? shortAddr(t.fromAddress, 8, 4) : "COINBASE"}
                </td>
                <td className="w-[20px] text-center text-neutral-600">&gt;</td>
                <td className="text-neutral-400" title={t.toAddress}>
                  {shortAddr(t.toAddress, 8, 4)}
                </td>
                <td className="text-right text-neutral-100">{fmtCoins(t.amount)}</td>
                <td className="hidden text-neutral-500 sm:table-cell">
                  #{fmtInt(t.blockHeight)}
                </td>
              </tr>
            ))}
            {!confirmed.length && (
              <tr>
                <td colSpan={6} className="py-4 text-center text-neutral-600">
                  NO CONFIRMED TRANSFERS YET<Cursor />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}

export default function Dashboard() {
  const node = useNode();
  const info = useQuery({
    queryKey: ["info"],
    queryFn: () => node.info(),
    refetchInterval: POLL_MS,
  });
  const d = info.data;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <Stat label="Chain Height" value={d ? `#${fmtInt(d.height)}` : "SYNC..."} sub={d ? timeAgo(d.tipTimestamp) : ""} />
        <Stat
          label="Network Hashrate"
          value={d ? fmtHashrate(d.hashrate) : "-"}
          sub={d?.avgBlockTime ? `avg block ${d.avgBlockTime.toFixed(1)}s` : "awaiting blocks"}
        />
        <Stat label="Difficulty" value={d ? fmtInt(Math.round(d.difficulty)) : "-"} sub={d ? `retarget in ${fmtInt(d.nextRetargetIn)}` : ""} />
        <Stat label="Peers" value={d ? fmtInt(d.peerCount) : "-"} sub="live links" />
        <Stat label="Mempool" value={d ? fmtInt(d.mempoolSize) : "-"} sub="pending transfers" />
        <Stat label="Transactions" value={d ? fmtInt(d.txsTotal) : "-"} sub="confirmed lifetime" />
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        <div className="min-w-0 space-y-4 lg:col-span-2">
          <MiningPanel />
        </div>
        <div className="min-w-0 lg:col-span-3">
          <PeersPanel />
        </div>
      </div>

      <BlocksPanel />
      <TransactionsPanel />

      <p className={cn("pb-2 text-center text-[10px] text-neutral-700")}>
        all figures are read locally from this node - refreshed every {POLL_MS / 1000}s,
        paused while the tab sleeps
      </p>
    </div>
  );
}
