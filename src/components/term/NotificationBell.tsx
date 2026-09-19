/**
 * Notification bell - "[!]" button in the header with an unread badge,
 * opening the notification panel. Terminal aesthetic: bordered dropdown,
 * uppercase titles, ASCII type icons, relative timestamps.
 *
 * Behavior:
 *   - click toggles the panel; Escape or clicking outside closes it
 *   - clicking a notification marks it read
 *   - MARK ALL READ / CLEAR ALL (clear asks for confirmation)
 *   - the panel renders at most PAGE_SIZE entries at a time with a
 *     "SHOW ALL" expander - 200 rows stay cheap
 *   - one 30s ticker refreshes every "x ago" label at once
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  clearNotifications,
  getNotifications,
  getUnreadCount,
  ICONS,
  markAllRead,
  markRead,
  subscribeNotifications,
  type AppNotification,
} from "@/lib/notify";
import { soundEngine } from "@/lib/sound";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 50;

// One quantized external clock drives every "x ago" label. The snapshot is
// stable inside a 10s window, so useSyncExternalStore never loops, and the
// interval only exists while the panel is open.
const CLOCK_QUANTUM_MS = 10_000;
function subscribeClock(fn: () => void): () => void {
  const t = setInterval(fn, CLOCK_QUANTUM_MS);
  return () => clearInterval(t);
}
function subscribeIdle(): () => void {
  return () => {};
}
function getNowQuantum(): number {
  return Math.floor(Date.now() / CLOCK_QUANTUM_MS) * CLOCK_QUANTUM_MS;
}

function ago(ms: number, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - ms) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function Row({ n, nowMs }: { n: AppNotification; nowMs: number }) {
  return (
    <button
      type="button"
      onClick={() => markRead(n.id)}
      className={cn(
        "block w-full border-b border-neutral-800 px-3 py-2 text-left hover:bg-neutral-900",
        !n.read && "bg-neutral-900/40",
      )}
    >
      <span className="flex items-baseline gap-2">
        <span
          className="shrink-0 font-bold text-neutral-300"
        >
          {ICONS[n.type]}
        </span>
        <span
          className={cn(
            "flex-1 truncate text-[11px] tracking-[0.12em]",
            n.read ? "text-neutral-500" : "glow-soft font-bold text-neutral-100",
          )}
        >
          {n.title}
        </span>
        <span className="shrink-0 text-[10px] text-neutral-600">{ago(n.at, nowMs)}</span>
        {!n.read ? (
          <span
            className="h-1.5 w-1.5 shrink-0 bg-neutral-200"
            aria-label="unread"
            title="unread"
          />
        ) : null}
      </span>
      <span
        className={cn(
          "mt-0.5 block break-words pl-8 text-[11px] leading-snug",
          n.read ? "text-neutral-600" : "text-neutral-400",
        )}
      >
        {n.message}
      </span>
    </button>
  );
}

/** Sounds on/off switch - persists via the sound engine (localStorage). */
function SoundsSwitch() {
  const [enabled, setEnabled] = useState(() => soundEngine.isSoundEnabled());
  const toggle = () => {
    soundEngine.setSoundEnabled(!enabled);
    setEnabled(soundEngine.isSoundEnabled());
  };
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={enabled ? "Sounds on - click to mute" : "Sounds off - click to unmute"}
      data-testid="sounds-switch"
      onClick={toggle}
      className="flex shrink-0 items-center gap-1.5 text-[10px] tracking-[0.15em] text-neutral-500 hover:text-neutral-200"
    >
      SOUNDS
      <span
        aria-hidden="true"
        className={cn(
          "relative h-3 w-6 border",
          enabled ? "border-neutral-300 bg-neutral-200" : "border-neutral-600 bg-black",
        )}
      >
        <span
          className={cn(
            "absolute top-0 h-full w-2.5",
            enabled ? "right-0 bg-black" : "left-0 bg-neutral-600",
          )}
        />
      </span>
      <span className={enabled ? "font-bold text-neutral-200" : "text-neutral-600"}>
        {enabled ? "ON" : "OFF"}
      </span>
    </button>
  );
}

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const items = useSyncExternalStore(subscribeNotifications, getNotifications);
  const unread = useSyncExternalStore(subscribeNotifications, getUnreadCount);

  // relative-time clock: subscribed (one shared interval) only while open
  const nowMs = useSyncExternalStore(open ? subscribeClock : subscribeIdle, getNowQuantum);

  // Escape closes; clicks outside close
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  const shown = showAll ? items : items.slice(-PAGE_SIZE);
  const reversed = [...shown].reverse(); // newest first, store order kept

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => {
          setOpen((o) => !o);
          setConfirmClear(false);
          setShowAll(false);
        }}
        className={cn(
          "relative px-2 py-0.5 text-xs tracking-[0.15em]",
          open ? "bg-neutral-200 font-bold text-black" : "text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100",
        )}
      >
        [!]
        {unread > 0 ? (
          // Pale muted green - the ONE color exception in an otherwise
          // strictly monochrome UI. key={unread} remounts the badge on every
          // new arrival, replaying the pop animation.
          <span
            key={unread}
            data-testid="notif-badge"
            className="badge-pop absolute -right-1.5 -top-1.5 min-w-4 border border-black bg-[#7A9A7A] px-0.5 text-center text-[9px] font-bold leading-3 text-white"
          >
            {unread > 99 ? "99+" : unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Notifications"
          className="absolute right-0 top-full z-50 mt-1 flex max-h-[400px] w-[calc(100vw-24px)] max-w-[360px] flex-col border border-neutral-600 bg-black shadow-[0_0_24px_rgba(255,255,255,0.08)]"
        >
          <div className="flex items-center justify-between gap-2 border-b border-neutral-700 px-3 py-1.5">
            <span className="term-panel-title">NOTIFICATIONS</span>
            <SoundsSwitch />
            <span className="text-[10px] text-neutral-600">
              {items.length}/{200} {unread > 0 ? `- ${unread} NEW` : ""}
            </span>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {items.length === 0 ? (
              <p className="px-3 py-6 text-center text-[11px] leading-relaxed text-neutral-600">
                NOTHING YET - mined blocks, incoming transfers, sent
                confirmations, peers and errors will show up here while you
                are away.
              </p>
            ) : (
              reversed.map((n) => <Row key={n.id} n={n} nowMs={nowMs} />)
            )}
            {!showAll && items.length > PAGE_SIZE ? (
              <button
                type="button"
                className="link-term block w-full px-3 py-2 text-center text-[11px]"
                onClick={() => setShowAll(true)}
              >
                [SHOW ALL {items.length}]
              </button>
            ) : null}
          </div>

          {items.length > 0 ? (
            <div className="flex items-center justify-between gap-2 border-t border-neutral-700 px-3 py-1.5 text-[11px]">
              <button
                type="button"
                className="link-term disabled:opacity-40"
                disabled={unread === 0}
                onClick={markAllRead}
              >
                [MARK ALL READ]
              </button>
              {confirmClear ? (
                <span className="flex items-center gap-2">
                  <span className="text-neutral-500">delete all?</span>
                  <button
                    type="button"
                    className="link-term font-bold text-neutral-100"
                    onClick={() => {
                      clearNotifications();
                      setConfirmClear(false);
                    }}
                  >
                    [YES, CLEAR]
                  </button>
                  <button
                    type="button"
                    className="link-term"
                    onClick={() => setConfirmClear(false)}
                  >
                    [KEEP]
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="link-term"
                  onClick={() => setConfirmClear(true)}
                >
                  [CLEAR ALL]
                </button>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
