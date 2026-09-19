/**
 * Chain watcher - turns ledger changes into notifications:
 *
 *   BTWB RECEIVED      a new confirmed transfer TO this wallet appears in
 *                      the address history (diffed by txid, so amounts and
 *                      senders are exact; coinbase rows are excluded by
 *                      type - block_found already fired its own cue)
 *   POP REWARD         a participation payout (type "pop" row) to this
 *                      wallet confirms - the 20% peer-pool share for
 *                      keeping the node online
 *   TRANSFER CONFIRMED a txid registered by the Transfers page via
 *                      trackPendingTx() lands in a block
 *   BACKUP REMINDER    the confirmed balance crosses BACKUP_MIN_BALANCE while
 *                      the key was never exported (or the export is stale) -
 *                      throttled by BACKUP_REMIND_COOLDOWN_MS (lib/backup.ts)
 *
 * The query reuses the shared ["address", addr] cache the Wallet and
 * Transfers pages poll, so this hook adds no extra chain reads.
 */
import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNode } from "@/providers/node-context";
import { useWallet } from "@/hooks/useWallet";
import { getPendingTxs, notify, untrackPendingTx } from "@/lib/notify";
import {
  evaluateBackupReminder,
  lastBackupAt,
  lastRemindedAt,
  markReminded,
} from "@/lib/backup";
import { fmtCoins, shortAddr } from "@/lib/format";
import type { TxRow } from "@/node/storage";

/**
 * The pure diff decision behind the watcher (unit-tested directly - the
 * hook is a thin react-query wrapper around this). Given the freshly
 * polled history and the txids seen last poll, classify rows that deserve
 * a notification:
 *   "received" - a confirmed transfer TO this wallet from someone else
 *   "pop"      - a confirmed peer-pool participation credit to this wallet
 * Coinbase rows never classify: a coinbase to this wallet can only come
 * from a block THIS node mined, and useMiner already fired block_found.
 */
export function classifyIncoming(
  addr: string,
  history: readonly TxRow[],
  seen: ReadonlySet<string>,
): Array<{ kind: "received" | "pop"; tx: TxRow }> {
  const out: Array<{ kind: "received" | "pop"; tx: TxRow }> = [];
  for (const tx of history) {
    if (seen.has(tx.txid)) continue;
    if (tx.type === "transfer" && tx.toAddress === addr && tx.fromAddress !== addr) {
      out.push({ kind: "received", tx });
    } else if (tx.type === "pop" && tx.toAddress === addr) {
      out.push({ kind: "pop", tx });
    }
  }
  return out;
}

export function useFeedbackWatcher(): void {
  const node = useNode();
  const { wallet } = useWallet();
  const addr = wallet?.address ?? null;

  const acct = useQuery({
    queryKey: ["address", addr],
    queryFn: () => node.address(addr!),
    enabled: !!addr,
    refetchInterval: 4000,
  });

  // txids present in the previous poll - the diff baseline
  const seenRef = useRef<Set<string> | null>(null);
  const history = acct.data?.history ?? null;

  useEffect(() => {
    if (!history || !addr) return;
    const seen = seenRef.current;
    const current = new Set(history.map((t) => t.txid));
    seenRef.current = current;
    // First observation establishes the baseline - never announces old news.
    if (seen === null) return;

    // Incoming transfers and PoP participation credits confirmed since
    // the last poll (the decision itself lives in classifyIncoming).
    for (const { kind, tx } of classifyIncoming(addr, history, seen)) {
      if (kind === "received") {
        notify(
          "transaction_received",
          `Received ${fmtCoins(tx.amount)} BTWB from ${
            tx.fromAddress ? shortAddr(tx.fromAddress, 12, 6) : "unknown"
          }. Block #${tx.blockHeight.toLocaleString("en-US")}`,
        );
      } else {
        notify(
          "pop_reward",
          `Participation reward: ${fmtCoins(tx.amount)} BTWB for keeping your node online. Block #${tx.blockHeight.toLocaleString("en-US")}`,
        );
      }
    }

    // Our own broadcasts that just confirmed
    for (const pending of getPendingTxs()) {
      const row = history.find((t) => t.txid === pending.txid);
      if (row) {
        notify(
          "transfer_confirmed",
          `Sent ${fmtCoins(pending.amount)} BTWB. Block #${row.blockHeight.toLocaleString("en-US")}`,
        );
        untrackPendingTx(pending.txid);
      }
    }
  }, [history, addr]);

  // Wallet switch (import of a different key file) resets the baseline.
  useEffect(() => {
    seenRef.current = null;
  }, [addr]);

  // Backup reminder: the chain is replicated by every node, but THIS key
  // exists nowhere else. Remind only when the balance justifies the nag and
  // never more than once per cooldown (policy lives in lib/backup.ts).
  const balance = acct.data?.balance ?? null;
  useEffect(() => {
    if (!addr || balance === null) return;
    const now = Date.now();
    const verdict = evaluateBackupReminder({
      balance,
      backedUpAt: lastBackupAt(addr),
      remindedAt: lastRemindedAt(addr),
      now,
    });
    if (!verdict.remind) return;
    notify(
      "backup_reminder",
      verdict.reason === "never_backed_up"
        ? `Balance is ${fmtCoins(balance)} BTWB and this key has NEVER been backed up. Export it from the Wallet page - lose the key, lose the coins.`
        : `This key's backup is ${verdict.backupAgeDays} days old and the balance is ${fmtCoins(balance)} BTWB. Re-export it from the Wallet page.`,
    );
    // Cooldown starts even when the notification center deduped the entry:
    // an identical reminder is already sitting unread in the panel.
    markReminded(addr, now);
  }, [balance, addr]);
}
