import { useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNode } from "@/providers/node-context";
import { isChainUpdating } from "@/node/chain-gate";
import { useWallet } from "@/hooks/useWallet";
import { checkAddress, signTransfer, verifyOwnSignature } from "@/lib/bitweb";
import { buildPaymentUri, parsePaymentUri } from "@/lib/qr";
import { CopyBtn, Divider, Panel, StatusLine } from "@/components/term/ui";
import { Qr } from "@/components/term/Qr";
import { QrScanner } from "@/components/term/QrScanner";
import { fmtCoins, fmtInt, shortAddr, shortHash, timeAgo } from "@/lib/format";
import { MIN_TX_FEE, parseCoins } from "@contracts/protocol";
import { cn } from "@/lib/utils";
import { soundEngine } from "@/lib/sound";
import { notify, trackPendingTx } from "@/lib/notify";

export default function Transfers() {
  const { wallet } = useWallet();
  const node = useNode();
  const queryClient = useQueryClient();

  const addr = wallet?.address ?? null;
  const acct = useQuery({
    queryKey: ["address", addr],
    queryFn: () => node.address(addr!),
    enabled: !!addr,
    refetchInterval: 4000,
  });
  const mempool = useQuery({
    queryKey: ["mempool", 30],
    queryFn: () => node.mempool(30),
    refetchInterval: 4000,
  });

  const [to, setTo] = useState("");
  const [amountStr, setAmountStr] = useState("");
  const [feeStr, setFeeStr] = useState((MIN_TX_FEE / 1e8).toString());
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [lookup, setLookup] = useState("");
  const [scanning, setScanning] = useState(false);
  const [showMyQr, setShowMyQr] = useState(false);
  const [reqAmount, setReqAmount] = useState("");
  const unsignedAmountRef = useRef(0);

  const amountUnits = useMemo(() => parseCoins(amountStr || "0"), [amountStr]);
  const feeUnits = useMemo(() => parseCoins(feeStr || "0"), [feeStr]);
  const a = acct.data;

  const formProblems: string[] = [];
  if (!wallet) formProblems.push("no wallet on this terminal");
  if (to && !checkAddress(to)) formProblems.push("recipient address fails checksum");
  if (amountStr && amountUnits == null) formProblems.push("amount is not a valid BTWB figure");
  if (feeStr && feeUnits == null) formProblems.push("fee is not a valid BTWB figure");
  if (amountUnits != null && amountUnits < 1) formProblems.push("amount too small");
  if (feeUnits != null && feeUnits < MIN_TX_FEE)
    formProblems.push(`fee below relay minimum (${MIN_TX_FEE} units)`);
  if (a && amountUnits != null && feeUnits != null && amountUnits + feeUnits > a.available)
    formProblems.push("amount + fee exceeds spendable balance");

  const sendTx = useMutation({
    mutationFn: node.sendTx,
    onSuccess: ({ txid }) => {
      // Honesty about confirmation: a transfer confirms when ANY miner
      // includes it - the sender never has to mine. With zero peers the
      // mesh cannot see it yet, so say exactly what happens next: it is
      // re-gossiped automatically the moment a peer connects.
      const peerless = node.peers().length === 0;
      setStatus({
        ok: true,
        text: peerless
          ? `accepted - txid ${txid}. No peers right now: it will be relayed to miners automatically as soon as a peer connects.`
          : `broadcast accepted - txid ${txid}`,
      });
      trackPendingTx(txid, unsignedAmountRef.current);
      soundEngine.feedback("transaction_sent"); // panel entry arrives on confirmation
      setAmountStr("");
      setTo("");
      void queryClient.invalidateQueries({ queryKey: ["address"] });
      void queryClient.invalidateQueries({ queryKey: ["mempool"] });
    },
    onError: (e) => {
      setStatus({ ok: false, text: e.message });
      notify("error", `Broadcast failed: ${e.message}`);
    },
  });

  function broadcast() {
    if (!wallet || !a || amountUnits == null || feeUnits == null) return;
    // Same hard rule as mining: never sign against a chain that is mid-update
    // - the nonce/balance read could already be stale. The overlay blocks
    // human clicks during updates; this guards the keyboard/queued paths.
    if (isChainUpdating()) {
      setStatus({ ok: false, text: "chain is updating - try again when the update finishes" });
      notify("error", "Chain is updating - transfers can be sent when the update finishes");
      return;
    }
    setStatus(null);
    const unsigned = {
      from: wallet.address,
      to,
      amount: amountUnits,
      fee: feeUnits,
      nonce: a.nextNonce,
    };
    const signature = signTransfer(wallet.privHex, unsigned);
    if (!verifyOwnSignature(unsigned, wallet.pubHex, signature)) {
      setStatus({ ok: false, text: "local self-verification failed - aborting broadcast" });
      notify("error", "Transfer aborted - the local signature self-check failed. Nothing was broadcast; try again.");
      return;
    }
    unsignedAmountRef.current = amountUnits;
    sendTx.mutate({ ...unsigned, pubkey: wallet.pubHex, signature });
  }

  const lookupValid = checkAddress(lookup);

  // Receive QR - the payload another phone scans to pay THIS wallet.
  // Includes the requested amount only when one is typed and valid.
  const myQrUri = useMemo(() => {
    if (!wallet) return null;
    const trimmed = reqAmount.trim();
    const uri = buildPaymentUri(wallet.address, trimmed === "" ? undefined : trimmed);
    return uri ?? buildPaymentUri(wallet.address);
  }, [wallet, reqAmount]);

  function handleScan(text: string) {
    setScanning(false);
    const parsed = parsePaymentUri(text);
    if (!parsed) {
      setStatus({ ok: false, text: "scanned code is not a bitweb payment QR" });
      notify("error", "Scanned code is not a bitweb payment QR - ask the recipient for their receive code.");
      return;
    }
    setTo(parsed.address);
    if (parsed.amount !== undefined) setAmountStr(parsed.amount);
    setStatus({
      ok: true,
      text: `QR decoded - recipient ${shortAddr(parsed.address, 12, 6)} filled in` +
        (parsed.amount !== undefined ? ` with amount ${parsed.amount} BTWB` : ""),
    });
  }

  return (
    <div className="space-y-4">
      {scanning ? (
        <div
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/90 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="QR scanner"
        >
          <QrScanner
            className="w-full max-w-md"
            onResult={handleScan}
            onClose={() => setScanning(false)}
          />
        </div>
      ) : null}
      <Panel
        title="New Transfer"
        right={<span>{wallet ? shortAddr(wallet.address, 12, 6) : "NO WALLET"}</span>}
      >
        {!wallet ? (
          <p className="text-xs text-neutral-400">
            No wallet detected on this terminal.{" "}
            <Link className="link-term" to="/wallet">
              Generate one in the WALLET module
            </Link>{" "}
            - it takes one click and zero registration.
          </p>
        ) : (
          <div className="space-y-2">
            <div className="grid gap-2 sm:grid-cols-[1fr_150px_150px_auto]">
              <label className="block">
                <span className="mb-0.5 block text-[10px] uppercase tracking-[0.2em] text-neutral-500">
                  Recipient (btw1...)
                </span>
                <input
                  className="term-input"
                  placeholder="btw1..."
                  value={to}
                  onChange={(e) => setTo(e.target.value.trim())}
                  spellCheck={false}
                />
              </label>
              <label className="block">
                <span className="mb-0.5 block text-[10px] uppercase tracking-[0.2em] text-neutral-500">
                  Amount BTWB
                </span>
                <input
                  className="term-input"
                  placeholder="0.0"
                  inputMode="decimal"
                  value={amountStr}
                  onChange={(e) => setAmountStr(e.target.value)}
                />
              </label>
              <label className="block">
                <span className="mb-0.5 block text-[10px] uppercase tracking-[0.2em] text-neutral-500">
                  Fee BTWB
                </span>
                <input
                  className="term-input"
                  inputMode="decimal"
                  value={feeStr}
                  onChange={(e) => setFeeStr(e.target.value)}
                />
              </label>
              <div className="flex items-end">
                <button
                  className="term-btn term-btn-primary w-full px-5 py-2"
                  disabled={!a || formProblems.length > 0 || sendTx.isPending}
                  onClick={broadcast}
                >
                  {sendTx.isPending ? "SIGNING..." : "SIGN & BROADCAST"}
                </button>
              </div>
            </div>
            <div className="flex flex-wrap gap-x-4 text-[11px] text-neutral-500">
              <span>
                spendable:{" "}
                <span className="text-neutral-300">{a ? `${fmtCoins(a.available)} BTWB` : "-"}</span>
              </span>
              <span>
                nonce: <span className="text-neutral-300">{a ? a.nextNonce : "-"}</span>
              </span>
              <span>
                signature: <span className="text-neutral-300">ECDSA/secp256k1, signed locally</span>
              </span>
              <button
                className="link-term"
                onClick={() => a && setAmountStr(fmtCoins(Math.max(0, a.available - (feeUnits ?? 0))))}
              >
                [SEND MAX]
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="term-btn px-3 py-2 text-xs"
                onClick={() => {
                  setShowMyQr(false);
                  setScanning(true);
                }}
              >
                SCAN QR - PAY ANOTHER TERMINAL
              </button>
              <button
                type="button"
                className={cn("term-btn px-3 py-2 text-xs", showMyQr && "term-btn-primary")}
                onClick={() => setShowMyQr((s) => !s)}
              >
                {showMyQr ? "[-] MY QR - RECEIVE" : "[+] MY QR - RECEIVE"}
              </button>
            </div>
            {showMyQr && myQrUri ? (
              <div className="flex flex-col items-start gap-3 border border-neutral-700 bg-neutral-900/30 p-3 sm:flex-row sm:items-center">
                <Qr payload={myQrUri} caption="SCAN TO PAY THIS TERMINAL" />
                <div className="w-full min-w-0 space-y-2 text-xs">
                  <p className="text-neutral-400">
                    Show this to the sender's camera. The code carries your btw1 address
                    {reqAmount.trim() ? " and the requested amount" : ""} - nothing else.
                  </p>
                  <label className="block max-w-56">
                    <span className="mb-0.5 block text-[10px] uppercase tracking-[0.2em] text-neutral-500">
                      Request amount BTWB (optional)
                    </span>
                    <input
                      className="term-input"
                      placeholder="e.g. 12.5"
                      inputMode="decimal"
                      value={reqAmount}
                      onChange={(e) => setReqAmount(e.target.value)}
                    />
                  </label>
                  <div className="flex flex-wrap items-center gap-2 break-all text-[11px] text-neutral-500">
                    <span>{myQrUri}</span>
                    <CopyBtn text={myQrUri} label="COPY URI" />
                  </div>
                </div>
              </div>
            ) : null}
            {formProblems.length > 0 && (to || amountStr) ? (
              <StatusLine ok={false}>{formProblems.join(" - ")}</StatusLine>
            ) : null}
            {status ? <StatusLine ok={status.ok}>{status.text}</StatusLine> : null}
          </div>
        )}
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Mempool - Pending" className="min-w-0" bodyClassName="p-0 overflow-x-auto">
          <table className="term-table w-full min-w-[380px] text-xs">
            <thead>
              <tr>
                <th>TxID</th>
                <th>From -&gt; To</th>
                <th>Amount</th>
                <th>Fee</th>
              </tr>
            </thead>
            <tbody>
              {(mempool.data ?? []).map((t) => (
                <tr key={t.txid} className={cn(t.fromAddress === addr && "bg-neutral-900/60")}>
                  <td title={t.txid}>{shortHash(t.txid, 10)}</td>
                  <td className="text-neutral-500">
                    {shortAddr(t.fromAddress ?? "", 7, 3)}{" -> "}{shortAddr(t.toAddress, 7, 3)}
                  </td>
                  <td>{fmtCoins(t.amount)}</td>
                  <td className="text-neutral-500">{fmtCoins(t.fee)}</td>
                </tr>
              ))}
              {!mempool.data?.length && (
                <tr>
                  <td colSpan={4} className="py-4 text-center text-neutral-600">
                    MEMPOOL EMPTY - NETWORK IDLE
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Panel>

        <Panel title="Address Lookup" className="min-w-0">
          <div className="flex gap-2">
            <input
              className="term-input flex-1"
              placeholder="btw1... inspect any address"
              value={lookup}
              onChange={(e) => setLookup(e.target.value.trim())}
              spellCheck={false}
            />
          </div>
          {lookup && !lookupValid ? (
            <p className="mt-2 text-xs text-neutral-500">[ERR] address fails checksum</p>
          ) : lookupValid ? (
            <LookupView address={lookup} />
          ) : (
            <p className="mt-2 text-[11px] text-neutral-600">
              Paste any btw1 address to read its live balance and ledger from the chain.
            </p>
          )}
        </Panel>
      </div>

      {wallet && a ? (
        <>
          <Divider label="Your ledger" />
          <Panel title="Transfer History" bodyClassName="p-0 overflow-x-auto">
            <table className="term-table w-full min-w-[620px] text-xs">
              <thead>
                <tr>
                  <th>TxID</th>
                  <th>Dir</th>
                  <th>Amount</th>
                  <th>Fee</th>
                  <th>Counterparty</th>
                  <th>Status</th>
                  <th>Age</th>
                </tr>
              </thead>
              <tbody>
                {a.history.map((t) => {
                  const incoming = t.toAddress === wallet.address;
                  const pendingTx = t.blockHeight == null;
                  return (
                    <tr key={t.txid}>
                      <td title={t.txid} className="text-neutral-500">
                        {shortHash(t.txid, 10)}
                      </td>
                      <td className="font-bold">{incoming ? "v IN" : "^ OUT"}</td>
                      <td className="text-neutral-100">
                        {incoming ? "+" : "-"}
                        {fmtCoins(t.amount)}
                      </td>
                      <td className="text-neutral-500">{t.type === "transfer" ? fmtCoins(t.fee) : "-"}</td>
                      <td className="text-neutral-500">
                        {t.type === "coinbase"
                          ? "COINBASE"
                          : shortAddr((incoming ? t.fromAddress : t.toAddress) ?? "", 9, 4)}
                      </td>
                      <td>
                        {pendingTx ? (
                          <span className="blink">PENDING</span>
                        ) : (
                          <span className="text-neutral-400">
                            {a.tipHeight - t.blockHeight! + 1} CONF
                          </span>
                        )}
                      </td>
                      <td className="text-neutral-500">{timeAgo(t.timestamp)}</td>
                    </tr>
                  );
                })}
                {a.history.length === 0 && (
                  <tr>
                    <td colSpan={7} className="py-4 text-center text-neutral-600">
                      NO TRANSFERS YET
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </Panel>
        </>
      ) : null}
    </div>
  );
}

function LookupView({ address }: { address: string }) {
  const node = useNode();
  const q = useQuery({
    queryKey: ["address", address],
    queryFn: () => node.address(address),
    refetchInterval: 5000,
  });
  if (q.isLoading) return <p className="mt-2 text-xs text-neutral-500">QUERYING CHAIN...</p>;
  if (q.error) return <p className="mt-2 text-xs text-neutral-500">[ERR] {q.error.message}</p>;
  const d = q.data!;
  return (
    <div className="mt-2 space-y-1 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-neutral-500">balance</span>
        <span className="glow-soft font-term text-xl text-neutral-100">{fmtCoins(d.balance)} BTWB</span>
        <CopyBtn text={address} />
      </div>
      <div className="text-neutral-500">
        nonce {d.nonce} - blocks mined {fmtInt(d.blocksMined)} - {d.history.length} ledger entries
      </div>
      <div className="max-h-44 overflow-y-auto pt-1">
        {d.history.slice(0, 12).map((t) => {
          const incoming = t.toAddress === address;
          return (
            <div key={t.txid} className="flex justify-between gap-2 text-[11px]">
              <span className="text-neutral-500">
                {incoming ? "v" : "^"} {t.type} - {timeAgo(t.timestamp)}
              </span>
              <span className={incoming ? "text-neutral-100" : "text-neutral-400"}>
                {incoming ? "+" : "-"}
                {fmtCoins(t.amount)}
              </span>
            </div>
          );
        })}
        {d.history.length === 0 && <p className="text-[11px] text-neutral-600">no activity</p>}
      </div>
    </div>
  );
}
