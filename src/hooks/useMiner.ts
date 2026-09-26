import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNode } from "@/providers/node-context";
import type { MinerOutMsg } from "@/workers/miner.worker";
import { MINING_HASHRATE_CAP } from "@contracts/protocol";
import { isChainUpdating, subscribeChainGate } from "@/node/chain-gate";
import { getMiningIntent, setMiningIntent } from "@/lib/mining-intent";
import { setMiningWakeLock } from "@/lib/wake-lock";
import { prepareMiningStart, wireMiningGate } from "@/lib/mining-gate";
import { notify } from "@/lib/notify";
import { shortAddr } from "@/lib/format";

export interface MinerLogLine {
  id: number;
  time: string;
  text: string;
  level: "info" | "ok" | "err";
}

interface TemplateInfo {
  templateId: string;
  height: number;
  reward: number;
  txCount: number;
}

const REFRESH_MS = 30_000;
const MAX_LOG = 160;

// -- one miner per browser -----------------------------------------------------
// Primary gate: the Web Locks API (atomic, crash-proof - the browser releases
// the lock when a tab dies). Fallback for engines without Web Locks (older
// Safari): a BroadcastChannel claim protocol. A fresh claimant asks the
// channel for an active miner and broadcasts its own claim; an owner answers
// claims and heartbeats while it mines; simultaneous claims resolve by lowest
// ticket. Not atomic like a real lock, but it closes the double-mining hole
// on engines that lack one, and a crashed tab simply stops answering.
const MINING_LOCK_NAME = "bitweb-mining-lock";
const CLAIM_WAIT_MS = 350;
const CLAIM_HEARTBEAT_MS = 2_000;

type ClaimMsg = { type: "query" | "active" | "claim" | "release"; ticket?: string };

/**
 * Tries to become the browser-wide mining owner without the Web Locks API.
 * Resolves to a release function on success, or null when another tab owns
 * mining. When BroadcastChannel itself is missing there is no way to gate at
 * all - resolves to a no-op release and mining runs ungated.
 */
function acquireMiningClaim(): Promise<(() => void) | null> {
  const Factory = (
    globalThis as { BroadcastChannel?: typeof BroadcastChannel }
  ).BroadcastChannel;
  if (!Factory) return Promise.resolve(() => undefined);
  const bc = new Factory(MINING_LOCK_NAME);
  const myTicket = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  let owned = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const release = () => {
    if (heartbeat) clearInterval(heartbeat);
    if (owned) bc.postMessage({ type: "release", ticket: myTicket } satisfies ClaimMsg);
    bc.close();
  };

  return new Promise((resolve) => {
    const winTimer = setTimeout(() => {
      // No active owner and no stronger rival within the window: we own mining.
      owned = true;
      bc.onmessage = (e: MessageEvent<ClaimMsg>) => {
        const m = e.data;
        if (!m || typeof m !== "object" || m.ticket === myTicket) return;
        if (m.type === "query" || m.type === "claim") {
          bc.postMessage({ type: "active", ticket: myTicket } satisfies ClaimMsg);
        }
      };
      heartbeat = setInterval(() => {
        bc.postMessage({ type: "active", ticket: myTicket } satisfies ClaimMsg);
      }, CLAIM_HEARTBEAT_MS);
      resolve(release);
    }, CLAIM_WAIT_MS);

    bc.onmessage = (e: MessageEvent<ClaimMsg>) => {
      const m = e.data;
      if (!m || typeof m !== "object") return;
      // An active owner exists, or a simultaneous claim beats our ticket.
      if (
        m.type === "active" ||
        (m.type === "claim" && typeof m.ticket === "string" && m.ticket < myTicket)
      ) {
        clearTimeout(winTimer);
        bc.close();
        resolve(null);
      }
    };
    bc.postMessage({ type: "query" } satisfies ClaimMsg);
    bc.postMessage({ type: "claim", ticket: myTicket } satisfies ClaimMsg);
  });
}

/**
 * Mining controller: owns a pool of PoW workers, keeps a fresh block
 * template, submits winning nonces, and restarts on every new tip.
 * Mining runs only while the wallet page is open - by design.
 */
export function useMiner(address: string | null) {
  const node = useNode();
  const queryClient = useQueryClient();
  const [running, setRunning] = useState(false);
  const [threads, setThreads] = useState(2);
  const [hashrate, setHashrate] = useState(0);
  const [totalHashes, setTotalHashes] = useState(0);
  const [blocksFound, setBlocksFound] = useState(0);
  const [template, setTemplate] = useState<TemplateInfo | null>(null);
  const [log, setLog] = useState<MinerLogLine[]>([]);

  const workersRef = useRef<Worker[]>([]);
  const ratesRef = useRef<number[]>([]);
  const templateRef = useRef<(TemplateInfo & {
    prevHash: string;
    merkleRoot: string;
    target: string;
    minTimestamp: number;
  }) | null>(null);
  const runningRef = useRef(false);
  const submittingRef = useRef(false);
  const releaseLockRef = useRef<(() => void) | null>(null);
  const pendingStartRef = useRef(false);
  // Set while the pre-flight hold ("preparing to mine") runs. Kept separate
  // from pendingStartRef on purpose: the gate-pause wiring treats
  // pendingStart as "mining", so if the flag were up during our OWN hold the
  // hold would pause us, the release would resume us, and start() would loop
  // forever against itself. During prep we are NOT mining yet - a foreign
  // update is caught by the prep's depth check instead.
  const preppingRef = useRef(false);
  // Set when the chain-update gate force-paused us: on gate release WE owe
  // the resume. A manual stop() clears it - user intent outranks automation.
  const gatePausedRef = useRef(false);
  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const logIdRef = useRef(0);
  const addressRef = useRef(address);
  const threadsRef = useRef(threads);
  // Refs are written inside effects only (React Compiler rule) - the worker
  // callbacks below always read the freshest values through them.
  useEffect(() => {
    addressRef.current = address;
    threadsRef.current = threads;
  }, [address, threads]);
  const handleFoundRef = useRef<(timestamp: number, nonce: number, hash: string) => void>(
    () => undefined,
  );

  const pushLog = useCallback((text: string, level: MinerLogLine["level"] = "info") => {
    setLog((prev) => {
      const line: MinerLogLine = {
        id: ++logIdRef.current,
        time: new Date().toISOString().slice(11, 19),
        text,
        level,
      };
      return [...prev.slice(-(MAX_LOG - 1)), line];
    });
  }, []);

  const killWorkers = useCallback(() => {
    for (const w of workersRef.current) {
      try {
        w.postMessage({ type: "stop" });
        w.terminate();
      } catch {
        /* already dead */
      }
    }
    workersRef.current = [];
    ratesRef.current = [];
    setHashrate(0);
  }, []);

  const fetchTemplateAndSpin = useCallback(async () => {
    const addr = addressRef.current;
    if (!runningRef.current || !addr) return;
    // Defense in depth: never spin workers on a chain that is mid-mutation.
    // The gate subscription already paused us; this covers the race where a
    // template fetch was in flight exactly when the update began.
    if (isChainUpdating()) return;
    try {
      const tpl = await node.template(addr);
      if (!runningRef.current || addressRef.current !== addr) return;
      templateRef.current = tpl;
      setTemplate({
        templateId: tpl.templateId,
        height: tpl.height,
        reward: tpl.reward,
        txCount: tpl.txCount,
      });
      pushLog(
        `template #${tpl.height} - reward ${(tpl.reward / 1e8).toString()} BTWB - ${tpl.txCount} tx - target ${tpl.target.slice(0, 12)}...`,
      );

      killWorkers();
      const n = Math.max(1, Math.min(4, threadsRef.current));
      // The global cap is DIVIDED across workers: n threads never outrun a
      // single thread - they only let a slow device reach the same ceiling.
      const rateLimit = Math.max(1, Math.floor(MINING_HASHRATE_CAP / n));
      for (let i = 0; i < n; i++) {
        const w = new Worker(new URL("../workers/miner.worker.ts", import.meta.url), {
          type: "module",
        });
        w.onmessage = (e: MessageEvent<MinerOutMsg>) => {
          const msg = e.data;
          if (msg.type === "stats") {
            ratesRef.current[i] = (msg.hashes / msg.elapsedMs) * 1000;
            setTotalHashes((t) => t + msg.hashes);
            setHashrate(ratesRef.current.reduce((s, r) => s + r, 0));
          } else if (msg.type === "found") {
            // A win from a PREVIOUS template (queued before its worker died)
            // would be rejected by the node anyway - drop it quietly here.
            if (msg.templateId === templateRef.current?.templateId) {
              handleFoundRef.current(msg.timestamp, msg.nonce, msg.hash);
            }
          }
        };
        w.postMessage({
          type: "start",
          templateId: tpl.templateId,
          height: tpl.height,
          prevHash: tpl.prevHash,
          merkleRoot: tpl.merkleRoot,
          targetHex: tpl.target,
          minTimestamp: tpl.minTimestamp,
          stride: n,
          offset: i,
          rateLimit,
        });
        workersRef.current.push(w);
      }
    } catch (err) {
      pushLog(`template error: ${errMsg(err)}`, "err");
      notify("error", `Block template failed: ${errMsg(err)} - retrying automatically`);
    }
     
  }, [killWorkers, pushLog, node]);

  // Declared after fetchTemplateAndSpin - worker callbacks reach it through
  // handleFoundRef, so declaration order never matters at runtime.
  const handleFound = useCallback(
    async (timestamp: number, nonce: number, hash: string) => {
      const tpl = templateRef.current;
      if (!tpl || submittingRef.current) return;
      submittingRef.current = true;
      killWorkers();
      pushLog(`candidate found nonce=${nonce} hash=${hash.slice(0, 18)}... submitting`);
      try {
        const res = await node.submitBlock(tpl.templateId, timestamp, nonce);
        setBlocksFound((b) => b + 1);
        pushLog(
          `*** BLOCK #${res.height} ACCEPTED - reward ${(res.reward / 1e8).toString()} BTWB ***`,
          "ok",
        );
        void queryClient.invalidateQueries();
        notify(
          "block_found",
          `You mined block #${res.height.toLocaleString("en-US")}. Reward: ${(res.reward / 1e8).toString()} BTWB`,
        );
      } catch (err) {
        pushLog(`rejected: ${errMsg(err)}`, "err");
        notify("error", `Block rejected by the chain: ${errMsg(err)}`);
      } finally {
        submittingRef.current = false;
        if (runningRef.current) void fetchTemplateAndSpin();
      }
    },
    [killWorkers, pushLog, node, queryClient, fetchTemplateAndSpin],
  );
  useEffect(() => {
    handleFoundRef.current = (ts, nonce, hash) => void handleFound(ts, nonce, hash);
  }, [handleFound]);

  const beginMining = useCallback(
    (mode: "start" | "resume" = "start") => {
      runningRef.current = true;
      setRunning(true);
      // An actively mining phone must not be screen-lock-killed: hold the
      // wake lock for the whole run (released by stop/pause/unmount).
      setMiningWakeLock(true);
      if (mode === "resume") {
        pushLog("chain ready - mining resumed on the fresh tip");
        notify("mining_start", "Chain updated - mining resumed on the fresh tip");
      } else {
        pushLog(`mining engine online - payout -> ${addressRef.current}`);
        notify(
          "mining_start",
          `Engine online - payout to ${shortAddr(addressRef.current ?? "", 12, 6)}`,
        );
      }
      void fetchTemplateAndSpin();
      refreshTimerRef.current = setInterval(() => void fetchTemplateAndSpin(), REFRESH_MS);
    },
    [fetchTemplateAndSpin, pushLog],
  );

  const start = useCallback((opts?: { auto?: boolean }) => {
    // auto = boot / gate-close auto-resume: the stored intent drives it, it
    // never writes the intent itself, and it stays out of the notification
    // tray (the log alone records what happened). Manual START is the only
    // path that records the intent - and it records it even when this very
    // attempt is refused by a running update, so the auto-resume below can
    // pick mining up the moment the gate closes: no second press needed.
    const auto = opts?.auto === true;
    if (!auto) setMiningIntent(true);
    // The pending guard closes the double-click race: lock acquisition is
    // async, so without it two quick clicks would fire two acquisitions.
    if (runningRef.current || pendingStartRef.current || preppingRef.current || !addressRef.current) return;
    // Hard rule: while the chain is being updated - import, sync, rollback,
    // ANY path - mining cannot start until the state is fully applied.
    if (isChainUpdating()) {
      pushLog("refused: chain is updating - mining starts when the update finishes", "err");
      if (!auto) notify("error", "Chain is updating - mining can start when the update finishes");
      return;
    }
    preppingRef.current = true;
    const refuse = (text: string) => {
      pendingStartRef.current = false;
      pushLog(text, "err");
      if (!auto) notify("error", text);
    };
    const grant = (release: () => void) => {
      if (!pendingStartRef.current) {
        release(); // stop() landed while we were acquiring - do not mine
        return;
      }
      releaseLockRef.current = release;
      pendingStartRef.current = false;
      beginMining();
    };
    void (async () => {
      // Pre-flight hold: freeze the chain for a beat ("UPDATING - preparing
      // to mine") so an update that was ABOUT to land reveals itself, and
      // prove a template can be built on the settled tip. Only then may the
      // engine go online. Refusals here clear the pending flag and stop.
      const prep = await prepareMiningStart(() => node.template(addressRef.current!));
      preppingRef.current = false;
      if (!prep.ok) {
        if (prep.reason === "updating") {
          pushLog("refused: chain is updating - mining starts when the update finishes", "err");
          if (!auto) notify("error", "Chain is updating - mining can start when the update finishes");
        } else {
          pushLog("refused: could not prepare a mining template - try again", "err");
          if (!auto) notify("error", "Mining prep failed - the template could not be built, try again");
        }
        return;
      }
      // Prep passed: from here on the lock acquisition counts as "mining" for
      // the gate-pause wiring (a foreign update cancels it and owes a retry).
      pendingStartRef.current = true;
    // One miner per browser, enforced with the Web Locks API: the exclusive
    // lock "bitweb-mining-lock" is held for the whole session, so a second
    // tab (same browser, same origin) that tries to mine is refused instead
    // of doubling this device's hashpower past the cap.
    const locks = (navigator as Navigator & { locks?: LockManager }).locks;
    if (!locks) {
      // Fallback gate over BroadcastChannel (see acquireMiningClaim); when
      // even that is missing the gate cannot exist and mining runs ungated.
      acquireMiningClaim()
        .then((release) => {
          if (release === null) {
            refuse("mining already active in another tab - one miner per browser");
            return;
          }
          grant(release);
        })
        .catch((err: unknown) => refuse(`mining gate error: ${errMsg(err)}`));
      return;
    }
    locks
      .request(MINING_LOCK_NAME, { mode: "exclusive", ifAvailable: true }, (lock) => {
        if (lock === null) {
          refuse("mining already active in another tab - one miner per browser");
          return;
        }
        if (!pendingStartRef.current) return; // stopped while waiting - drop the lock
        pendingStartRef.current = false;
        beginMining();
        // Returning this promise holds the lock until stop() resolves it.
        return new Promise<void>((resolve) => {
          releaseLockRef.current = () => {
            releaseLockRef.current = null;
            resolve();
          };
        });
      })
      .catch((err: unknown) => refuse(`mining lock error: ${errMsg(err)}`));
    })();
  }, [beginMining, pushLog, node]);

  const stop = useCallback(() => {
    // Manual STOP is the only action that erases the stored intent: gate
    // pauses, reloads and unmounts must never clear it - only the user can.
    setMiningIntent(false);
    setMiningWakeLock(false);
    gatePausedRef.current = false; // manual stop cancels any owed auto-resume
    preppingRef.current = false;
    pendingStartRef.current = false;
    runningRef.current = false;
    setRunning(false);
    if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);
    refreshTimerRef.current = null;
    killWorkers();
    setTemplate(null);
    if (releaseLockRef.current) {
      releaseLockRef.current(); // release "bitweb-mining-lock" for other tabs
      releaseLockRef.current = null;
    }
    pushLog("mining halted - workers terminated");
    notify("mining_stop", "Mining halted - workers terminated");
  }, [killWorkers, pushLog]);

  // -- chain-update gate: immediate pause, automatic resume -----------------
  // The gate fires the moment ANY chain update begins (import, peer sync,
  // rollback, gossiped block, mined-block commit, prune). Workers die in
  // the same tick; the browser-wide mining lock is KEPT while paused so no
  // other tab can steal this device's mining slot mid-update.
  const pauseForGate = useCallback(() => {
    gatePausedRef.current = true;
    pendingStartRef.current = false; // cancels an in-flight lock acquisition
    runningRef.current = false;
    setRunning(false);
    // The mining hold drops while paused; the gate's own wake-lock hold
    // keeps the screen alive through the update.
    setMiningWakeLock(false);
    if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);
    refreshTimerRef.current = null;
    killWorkers();
    setTemplate(null);
    pushLog("chain updating - mining paused (update finishes, mining resumes)", "info");
    notify("mining_stop", "Chain updating - mining paused until the update finishes");
  }, [killWorkers, pushLog]);

  const resumeAfterGate = useCallback(() => {
    if (!gatePausedRef.current) return;
    gatePausedRef.current = false;
    if (!addressRef.current) return; // wallet ejected mid-update - stay parked
    if (releaseLockRef.current) {
      beginMining("resume"); // lock still ours: respin immediately
    } else {
      start(); // pause landed mid-acquisition: go through the lock again
    }
  }, [beginMining, start]);

  useEffect(() => {
    return wireMiningGate({
      isMining: () => runningRef.current || pendingStartRef.current,
      pause: pauseForGate,
      resume: resumeAfterGate,
    });
  }, [pauseForGate, resumeAfterGate]);

  // -- persistent intent: auto-resume ----------------------------------------
  // A manual START survives reloads, tab restores and app updates (the
  // intent lives in localStorage; every in-memory ref does not). Whenever
  // this page is up with the intent set, mining off and the gate idle, start
  // without waiting for another button press - and retry on every gate
  // close, which also covers a start refused by the boot sync. Manual STOP
  // erased the intent, so this never resurrects mining the user ended.
  useEffect(() => {
    if (!address) return;
    let disposed = false;
    const tryAutoStart = () => {
      if (disposed || !getMiningIntent()) return;
      if (runningRef.current || pendingStartRef.current || preppingRef.current) return;
      if (isChainUpdating()) return;
      start({ auto: true });
    };
    tryAutoStart();
    const unsub = subscribeChainGate((st) => {
      if (!st.active) tryAutoStart();
    });
    return () => {
      disposed = true;
      unsub();
    };
  }, [address, start]);

  // restart on thread-count change while running
  useEffect(() => {
    if (runningRef.current) void fetchTemplateAndSpin();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threads]);

  // full cleanup on unmount
  useEffect(() => {
    return () => {
      runningRef.current = false;
      setMiningWakeLock(false);
      if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);
      for (const w of workersRef.current) w.terminate();
      workersRef.current = [];
      if (releaseLockRef.current) {
        releaseLockRef.current();
        releaseLockRef.current = null;
      }
    };
  }, []);

  return {
    running,
    threads,
    setThreads,
    hashrate,
    totalHashes,
    blocksFound,
    template,
    log,
    start,
    stop,
  };
}

function errMsg(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}
