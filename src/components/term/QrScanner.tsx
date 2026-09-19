// Camera QR scanner - getUserMedia + jsQR frame loop.
// Phone-to-phone flow: point the rear camera at the other device's Qr display.
// Hard requirements handled here:
//  - rear camera preferred (facingMode: environment), any camera as fallback
//  - every track stopped + rAF cancelled on close/unmount (no camera LED left on)
//  - explicit states: starting / scanning / unsupported (insecure origin or no API)
//    / denied / no-camera / error
//  - result delivered exactly once, then the camera shuts down
import { useCallback, useEffect, useRef, useState } from "react";
import jsQR from "jsqr";
import { cn } from "@/lib/utils";

export type ScannerState =
  | "starting"
  | "scanning"
  | "unsupported"
  | "denied"
  | "no-camera"
  | "error";

const STATE_LABEL: Record<ScannerState, string> = {
  starting: "REQUESTING CAMERA ACCESS...",
  scanning: "POINT CAMERA AT A BITWEB QR CODE",
  unsupported: "CAMERA UNAVAILABLE - SECURE CONTEXT (HTTPS) REQUIRED",
  denied: "CAMERA PERMISSION DENIED - ALLOW ACCESS IN BROWSER SETTINGS",
  "no-camera": "NO CAMERA FOUND ON THIS DEVICE",
  error: "CAMERA ERROR - CLOSE AND TRY AGAIN",
};

export function QrScanner({
  onResult,
  onClose,
  className,
}: {
  /** Fired exactly once with the decoded QR text. */
  onResult: (text: string) => void;
  onClose: () => void;
  className?: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  // Unsupported environments are known on the FIRST render - initialise
  // lazily instead of correcting with a setState inside the effect.
  const [state, setState] = useState<ScannerState>(() =>
    typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia
      ? "unsupported"
      : "starting",
  );
  // Mutable bag for everything the decode loop needs - avoids stale closures.
  // canvas/ctx are created ONCE and reused every frame: allocating a fresh
  // canvas + ImageData 60x/s would churn hundreds of MB/s of GC pressure.
  const run = useRef<{
    stream: MediaStream | null;
    raf: number;
    done: boolean;
    canvas: HTMLCanvasElement | null;
    ctx: CanvasRenderingContext2D | null;
  }>({ stream: null, raf: 0, done: false, canvas: null, ctx: null });

  const shutdown = useCallback(() => {
    run.current.done = true;
    cancelAnimationFrame(run.current.raf);
    for (const t of run.current.stream?.getTracks() ?? []) t.stop();
    run.current.stream = null;
    const v = videoRef.current;
    if (v) v.srcObject = null;
  }, []);

  const close = useCallback(() => {
    shutdown();
    onClose();
  }, [shutdown, onClose]);

  useEffect(() => {
    const bag = run.current;
    bag.done = false;

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      return shutdown; // initial state is already "unsupported"
    }

    let cancelled = false;

    const decodeLoop = () => {
      if (bag.done || cancelled) return;
      const video = videoRef.current;
      if (!video || video.readyState !== video.HAVE_ENOUGH_DATA) {
        bag.raf = requestAnimationFrame(decodeLoop);
        return;
      }
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (w === 0 || h === 0) {
        bag.raf = requestAnimationFrame(decodeLoop);
        return;
      }
      if (!bag.canvas || bag.canvas.width !== w || bag.canvas.height !== h) {
        bag.canvas = document.createElement("canvas");
        bag.canvas.width = w;
        bag.canvas.height = h;
        bag.ctx = null; // context is bound to the old size - recreate
      }
      if (!bag.ctx) {
        bag.ctx = bag.canvas.getContext("2d", { willReadFrequently: true });
      }
      const canvas = bag.canvas;
      const ctx = bag.ctx;
      if (!canvas || !ctx) {
        setState("error");
        return;
      }
      ctx.drawImage(video, 0, 0, w, h);
      let frame: ImageData;
      try {
        frame = ctx.getImageData(0, 0, w, h);
      } catch {
        bag.raf = requestAnimationFrame(decodeLoop);
        return;
      }
      const hit = jsQR(frame.data, w, h, { inversionAttempts: "attemptBoth" });
      if (hit && hit.data && !bag.done && !cancelled) {
        bag.done = true;
        cancelAnimationFrame(bag.raf);
        for (const t of bag.stream?.getTracks() ?? []) t.stop();
        bag.stream = null;
        onResult(hit.data);
        return;
      }
      bag.raf = requestAnimationFrame(decodeLoop);
    };

    const start = async () => {
      // Rear camera first (phones); fall back to any camera (laptops/desktops).
      const attempts: MediaStreamConstraints[] = [
        { video: { facingMode: { ideal: "environment" } }, audio: false },
        { video: true, audio: false },
      ];
      let stream: MediaStream | null = null;
      let lastErr: unknown = null;
      for (const c of attempts) {
        try {
          stream = await navigator.mediaDevices.getUserMedia(c);
          break;
        } catch (e) {
          lastErr = e;
          // Permission errors must not retry - the user said no.
          const name = e instanceof DOMException ? e.name : "";
          if (name === "NotAllowedError" || name === "SecurityError") break;
        }
      }
      if (cancelled || bag.done) {
        for (const t of stream?.getTracks() ?? []) t.stop();
        return;
      }
      if (!stream) {
        const name = lastErr instanceof DOMException ? lastErr.name : "";
        setState(
          name === "NotAllowedError" || name === "SecurityError"
            ? "denied"
            : name === "NotFoundError" || name === "OverconstrainedError"
              ? "no-camera"
              : "error",
        );
        return;
      }
      bag.stream = stream;
      const video = videoRef.current;
      if (!video) {
        for (const t of stream.getTracks()) t.stop();
        return;
      }
      video.srcObject = stream;
      video.setAttribute("playsinline", "true"); // iOS Safari - no fullscreen takeover
      try {
        await video.play();
      } catch {
        // Autoplay can reject until a gesture; the frames still flow once allowed.
      }
      setState("scanning");
      bag.raf = requestAnimationFrame(decodeLoop);
    };

    void start();
    return () => {
      cancelled = true;
      shutdown();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Esc closes the scanner (desktop / TV remotes send Escape or Backspace).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  return (
    <div className={cn("border border-neutral-600 bg-black", className)}>
      <div className="flex items-center justify-between border-b border-neutral-700 px-3 py-1.5">
        <span className="text-[10px] uppercase tracking-[0.25em] text-neutral-400">
          QR SCANNER
        </span>
        <button type="button" className="term-btn px-2 py-0.5 text-[11px]" onClick={close}>
          CLOSE [ESC]
        </button>
      </div>

      <div className="relative aspect-[4/3] w-full overflow-hidden bg-black">
        <video
          ref={videoRef}
          muted
          playsInline
          className={cn(
            "absolute inset-0 h-full w-full object-cover",
            state === "scanning" ? "opacity-100" : "opacity-0",
          )}
        />
        {/* viewfinder brackets */}
        {state === "scanning" ? (
          <div aria-hidden className="pointer-events-none absolute inset-0">
            <div className="absolute left-[15%] top-[15%] h-8 w-8 border-l-2 border-t-2 border-neutral-100" />
            <div className="absolute right-[15%] top-[15%] h-8 w-8 border-r-2 border-t-2 border-neutral-100" />
            <div className="absolute bottom-[15%] left-[15%] h-8 w-8 border-b-2 border-l-2 border-neutral-100" />
            <div className="absolute bottom-[15%] right-[15%] h-8 w-8 border-b-2 border-r-2 border-neutral-100" />
            <div className="scanline absolute inset-x-[15%] top-[15%] h-px bg-neutral-100/70" />
          </div>
        ) : null}
        {state !== "scanning" ? (
          <div className="absolute inset-0 flex items-center justify-center p-4 text-center">
            <span className="text-xs text-neutral-400">
              {STATE_LABEL[state]}
              {state === "starting" ? <span className="blink ml-1">_</span> : null}
            </span>
          </div>
        ) : null}
      </div>

      <div className="border-t border-neutral-700 px-3 py-1.5 text-[10px] uppercase tracking-[0.2em] text-neutral-500">
        {STATE_LABEL[state]}
      </div>
    </div>
  );
}
