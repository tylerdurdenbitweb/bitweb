import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNode } from "@/providers/node-context";
import { useWallet } from "@/hooks/useWallet";
import { useMiner } from "@/hooks/useMiner";
import { buildPaymentUri } from "@/lib/qr";
import { lastBackupAt, markBackedUp } from "@/lib/backup";
import { CopyBtn, Cursor, Divider, Panel, Stat } from "@/components/term/ui";
import { Qr } from "@/components/term/Qr";
import { fmtCoins, fmtHashrate, fmtInt, shortAddr, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Downloads the private key as a portable .bitweb wallet file (JSON envelope). */
function downloadWalletFile(privHex: string): void {
  const payload = JSON.stringify({ format: "bitweb-wallet-1", privHex }, null, 2) + "\n";
  const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "bitweb-wallet.bitweb";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/**
 * Extracts a private key hex string from a wallet file: either the JSON
 * envelope produced by downloadWalletFile or a raw hex key (the 0x prefix,
 * case and whitespace are normalized later by walletFromPrivHex).
 */
function parseWalletFile(text: string): string | null {
  const t = text.trim();
  if (!t.startsWith("{")) return t.length > 0 ? t : null;
  try {
    const j: unknown = JSON.parse(t);
    if (j && typeof j === "object" && "privHex" in j) {
      const k = (j as { privHex: unknown }).privHex;
      return typeof k === "string" ? k : null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * One-line, always-visible backup freshness readout. The clock advances via
 * effect+state (render stays pure); a successful export flips the line to
 * "today" within one tick.
 */
function BackupStatusLine({ address }: { address: string }) {
  const [snap, setSnap] = useState<{ at: number | null; now: number } | null>(null);
  useEffect(() => {
    const tick = () => setSnap({ at: lastBackupAt(address), now: Date.now() });
    tick();
    const t = setInterval(tick, 4_000);
    return () => clearInterval(t);
  }, [address]);
  if (!snap) return null;
  const at = snap.at; // const alias: narrowing survives the closure below
  const text =
    at === null
      ? "NEVER EXPORTED"
      : (() => {
          const days = Math.floor((snap.now - at) / 86_400_000);
          return days <= 0 ? "EXPORTED TODAY" : `EXPORTED ${days} DAY${days === 1 ? "" : "S"} AGO`;
        })();
  return (
    <p className="text-[11px] text-neutral-600">
      <span className="text-neutral-500">KEY BACKUP: </span>
      <span className={cn("font-bold", at === null ? "text-neutral-300" : "text-neutral-400")}>
        {text}
      </span>
    </p>
  );
}

export default function Wallet() {
  const { wallet, create, importKey, destroy } = useWallet();
  const [importHex, setImportHex] = useState("");
  const [importErr, setImportErr] = useState("");
  const [showKey, setShowKey] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const addr = wallet?.address ?? null;
  const node = useNode();
  const acct = useQuery({
    queryKey: ["address", addr],
    queryFn: () => node.address(addr!),
    enabled: !!addr,
    refetchInterval: 4000,
  });

  const miner = useMiner(addr);
  const minerRef = useRef(miner);
  useEffect(() => {
    minerRef.current = miner;
  });

  // Ctrl+M (global shortcut) toggles the engine: directly when this page is
  // mounted, or via a pending flag left by the Layout when it navigated here.
  useEffect(() => {
    const toggle = () => {
      const m = minerRef.current;
      if (m.running) m.stop();
      else m.start();
    };
    window.addEventListener("btwb.toggle-mining", toggle);
    if (sessionStorage.getItem("btwb.pendingMineToggle") === "1") {
      sessionStorage.removeItem("btwb.pendingMineToggle");
      toggle();
    }
    return () => window.removeEventListener("btwb.toggle-mining", toggle);
  }, []);

  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [miner.log.length]);

  if (!wallet) {
    return (
      <div className="mx-auto max-w-2xl space-y-4 pt-4">
        <p className="glow text-center font-term text-3xl">NO WALLET DETECTED ON THIS TERMINAL</p>
        <p className="text-center text-xs text-neutral-500">
          A wallet is a secp256k1 keypair. It is generated here, in your browser, and never
          transmitted anywhere.
        </p>
        <Panel title="Generate New Wallet">
          <p className="mb-3 text-xs text-neutral-400">
            One click mints a fresh private key and derives your{" "}
            <span className="text-neutral-200">btw1...</span> address.
          </p>
          <button
            className="term-btn term-btn-primary w-full py-3 text-base"
            onClick={() => {
              create();
              void node.refreshPayout();
            }}
          >
            &gt; GENERATE WALLET
          </button>
        </Panel>
        <Panel title="Import Existing Private Key">
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              className="term-input flex-1"
              placeholder="64 hex characters (0-9a-f)"
              value={importHex}
              onChange={(e) => {
                setImportErr("");
                setImportHex(e.target.value);
              }}
              spellCheck={false}
              autoComplete="off"
            />
            <button
              className="term-btn"
              onClick={() => {
                const w = importKey(importHex);
                if (!w) setImportErr("not a valid private key");
                else void node.refreshPayout();
              }}
            >
              IMPORT
            </button>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <button className="term-btn" onClick={() => fileRef.current?.click()}>
              IMPORT .BITWEB FILE
            </button>
            <span className="text-[11px] text-neutral-600">
              a wallet file exported from another terminal (or a raw hex key in a text file)
            </span>
            <input
              ref={fileRef}
              type="file"
              accept=".bitweb,.json,.txt"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = ""; // re-selecting the same file must fire again
                void (async () => {
                  if (!f) return;
                  const hex = parseWalletFile(await f.text());
                  const w = hex ? importKey(hex) : null;
                  if (!w) setImportErr("not a valid wallet file or private key");
                  else {
                    setImportErr("");
                    void node.refreshPayout();
                  }
                })();
              }}
            />
          </div>
          {importErr ? <p className="mt-2 text-xs text-neutral-400">[ERR] {importErr}</p> : null}
        </Panel>
        <p className="text-center text-[11px] text-neutral-600">
          HOT STORAGE WARNING - keys live in this browser's IndexedDB on this device. Export and back up your
          key. Lose it, and the coins are gone forever. There is no password reset. There is no
          support line. That is the point.
        </p>
      </div>
    );
  }

  const a = acct.data;
  // Plain computation, NOT a hook - this line sits below the !wallet early return.
  const receiveUri = buildPaymentUri(wallet.address);

  return (
    <div className="space-y-4">
      <Panel
        title="Wallet Identity"
        right={
          <button
            className="link-term text-[11px]"
            onClick={() => {
              if (window.confirm("Remove this wallet from the terminal? Make sure the private key is backed up.")) {
                miner.stop();
                destroy();
                void node.refreshPayout();
              }
            }}
          >
            [ EJECT WALLET ]
          </button>
        }
      >
        <div className="grid gap-4 md:grid-cols-[1fr_auto]">
          <div className="min-w-0 space-y-2 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <span className="w-24 shrink-0 text-neutral-500">ADDRESS</span>
              <span className="glow-soft break-all text-neutral-100">{wallet.address}</span>
              <CopyBtn text={wallet.address} />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="w-24 shrink-0 text-neutral-500">PUBLIC KEY</span>
              <span className="break-all text-neutral-400">{wallet.pubHex}</span>
              <CopyBtn text={wallet.pubHex} />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="w-24 shrink-0 text-neutral-500">PRIVATE KEY</span>
              <span className="break-all text-neutral-400">
                {showKey ? wallet.privHex : "-".repeat(64)}
              </span>
              <button
                className="term-btn px-2 py-0.5 text-[11px]"
                onClick={() => {
                  if (
                    !showKey &&
                    !window.confirm(
                      "Reveal the private key on screen? Anyone who sees it controls every coin on this address.",
                    )
                  )
                    return;
                  setShowKey((s) => !s);
                }}
              >
                {showKey ? "HIDE" : "REVEAL"}
              </button>
              {showKey ? <CopyBtn text={wallet.privHex} label="COPY KEY" /> : null}
              <button
                className="term-btn px-2 py-0.5 text-[11px]"
                title="Download a portable .bitweb wallet file for another terminal"
                onClick={() => {
                  if (
                    window.confirm(
                      "Export the private key to a file? Store it offline - anyone holding the file owns the coins.",
                    )
                  ) {
                    downloadWalletFile(wallet.privHex);
                    // A successful export IS the backup - the reminder
                    // countdown (lib/backup.ts) restarts from here.
                    markBackedUp(wallet.address);
                  }
                }}
              >
                EXPORT FILE
              </button>
            </div>
            <p className="border border-neutral-700 bg-neutral-900/40 px-2 py-1 text-[11px] text-neutral-500">
              ! BACK UP THE PRIVATE KEY. IT IS THE ONLY PROOF OF OWNERSHIP. IT NEVER LEAVES THIS
              BROWSER - LOSING IT MEANS LOSING THE COINS.
            </p>
            <BackupStatusLine address={wallet.address} />
          </div>
          {receiveUri ? (
            <div className="flex flex-col items-center justify-center gap-1 md:px-2">
              <Qr payload={receiveUri} caption="RECEIVE - SCAN TO PAY ME" />
              <p className="max-w-56 text-center text-[10px] leading-relaxed text-neutral-600">
                The QR carries your address only. Keys never leave this browser.
              </p>
            </div>
          ) : null}
        </div>
      </Panel>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Balance" value={a ? `${fmtCoins(a.balance)}` : "-"} sub="BTWB confirmed" />
        <Stat
          label="Spendable Now"
          value={a ? `${fmtCoins(a.available)}` : "-"}
          sub={a && a.pending.length > 0 ? `${a.pending.length} pending` : "no pending locks"}
        />
        <Stat label="Blocks Mined" value={a ? fmtInt(a.blocksMined) : "0"} sub="lifetime, this address" />
        <Stat label="Tx Nonce" value={a ? `${a.nonce}` : "0"} sub={a ? `next: ${a.nextNonce}` : ""} />
      </div>

      <Panel
        title="Mining Console"
        right={<span>{miner.running ? "ENGINE ONLINE" : "ENGINE OFFLINE"}</span>}
      >
        <div className="grid gap-3 lg:grid-cols-3">
          <div className="min-w-0 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              {miner.running ? (
                <button className="term-btn px-6 py-2" onClick={miner.stop}>
                  [x] STOP MINING
                </button>
              ) : (
                <button className="term-btn term-btn-primary px-6 py-2" onClick={miner.start}>
                  [&gt;] START MINING
                </button>
              )}
              <label className="flex items-center gap-1 text-xs text-neutral-500">
                THREADS
                <select
                  className="term-input w-auto px-2 py-1"
                  value={miner.threads}
                  onChange={(e) => miner.setThreads(Number(e.target.value))}
                >
                  {[1, 2, 3, 4].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Stat label="Hashrate" value={fmtHashrate(miner.hashrate)} sub="this terminal" />
              <Stat label="Hashes" value={fmtInt(miner.totalHashes)} sub="this session" />
              <Stat label="Blocks Found" value={`${miner.blocksFound}`} sub="this session" />
              <Stat
                label="Template"
                value={miner.template ? `#${fmtInt(miner.template.height)}` : "-"}
                sub={
                  miner.template
                    ? `${miner.template.txCount} tx - ${fmtCoins(miner.template.reward)} BTWB reward`
                    : "idle"
                }
              />
            </div>
            <p className="text-[11px] leading-relaxed text-neutral-500">
              Mining is REAL SHA-256d proof-of-work executed by web workers in this tab. Rewards go
              to <span className="text-neutral-300">{shortAddr(wallet.address, 12, 6)}</span> and are
              confirmed by the chain - keep this page open to keep mining. Close it and the workers
              die with it. No tab, no hashes. No hashes, no coins.
            </p>
          </div>
          <div className="min-w-0 lg:col-span-2">
            <div
              ref={logRef}
              className={cn(
                "h-64 overflow-y-auto overflow-x-hidden break-all border border-neutral-800 bg-black p-2 text-[11px] leading-relaxed",
                "shadow-[inset_0_0_24px_rgba(255,255,255,0.04)]",
              )}
            >
              {miner.log.length === 0 ? (
                <p className="text-neutral-600">
                  mining log idle - press START MINING to begin hashing <Cursor />
                </p>
              ) : (
                miner.log.map((l) => (
                  <div key={l.id}>
                    <span className="text-neutral-600">{l.time} </span>
                    <span
                      className={cn(
                        l.level === "ok" && "glow font-bold text-white",
                        l.level === "err" && "text-neutral-500",
                        l.level === "info" && "text-neutral-300",
                      )}
                    >
                      {l.text}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </Panel>

      <Divider label="Recent activity" />
      <Panel title="Wallet Ledger" bodyClassName="p-0 overflow-x-auto">
        <table className="term-table w-full min-w-[560px] text-xs">
          <thead>
            <tr>
              <th>Dir</th>
              <th>Type</th>
              <th>Amount</th>
              <th>Counterparty</th>
              <th>Status</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>
            {(a?.history ?? []).slice(0, 15).map((t) => {
              const incoming = t.toAddress === wallet.address;
              const pendingTx = t.blockHeight == null;
              return (
                <tr key={t.txid}>
                  <td className="font-bold">{incoming ? "v IN" : "^ OUT"}</td>
                  <td className="text-neutral-400">{t.type}</td>
                  <td className={cn("text-neutral-100", !incoming && "text-neutral-400")}>
                    {incoming ? "+" : "-"}
                    {fmtCoins(t.amount)}
                  </td>
                  <td className="text-neutral-500">
                    {t.type === "coinbase"
                      ? "COINBASE (NEW COINS)"
                      : shortAddr((incoming ? t.fromAddress : t.toAddress) ?? "", 10, 5)}
                  </td>
                  <td>
                    {pendingTx ? (
                      <span className="blink text-neutral-300">PENDING</span>
                    ) : (
                      <span className="text-neutral-400">
                        #{fmtInt(t.blockHeight!)} ({a!.tipHeight - t.blockHeight! + 1} conf)
                      </span>
                    )}
                  </td>
                  <td className="text-neutral-500">{timeAgo(t.timestamp)}</td>
                </tr>
              );
            })}
            {a && a.history.length === 0 && (
              <tr>
                <td colSpan={6} className="py-4 text-center text-neutral-600">
                  NO ACTIVITY - MINE A BLOCK OR RECEIVE A TRANSFER
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}
