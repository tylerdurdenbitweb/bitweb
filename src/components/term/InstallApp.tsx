/**
 * PWA install affordance - one terminal-styled [ INSTALL ] button in the
 * footer that behaves correctly on every platform:
 *
 *   Chrome/Edge/Android : captures `beforeinstallprompt` (preventDefault so
 *     the browser's own mini-infobar stays out of the way), fires prompt()
 *     on click, awaits userChoice, and logs the outcome either way.
 *   appinstalled        : hides the button for good + posts a confirmation
 *     notification (with the soft "system" feedback sound).
 *   iOS Safari          : never fires beforeinstallprompt - the button opens
 *     an overlay walking through Share -> Add to Home Screen instead.
 *   Already installed   : (display-mode: standalone / navigator.standalone)
 *     the button simply does not render.
 */
import { useCallback, useEffect, useState } from "react";
import { notify } from "@/lib/notify";

/** The event Chrome fires when the app becomes installable. */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

function isStandaloneDisplay(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    // iOS Safari's proprietary flag
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

function isIosSafari(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  const appleMobile = /iPad|iPhone|iPod/.test(ua);
  // iPadOS 13+ reports as Macintosh - touch points give it away
  const touchMac = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  return appleMobile || touchMac;
}

export function InstallApp() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState<boolean>(() => isStandaloneDisplay());
  const [showIosHelp, setShowIosHelp] = useState(false);

  useEffect(() => {
    const onBeforeInstall = (e: Event) => {
      e.preventDefault(); // suppress the browser mini-infobar; we prompt ourselves
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
      setShowIosHelp(false);
      notify("system", "App installed - launch BitWeb from your home screen or app drawer.");
    };
    const mq = window.matchMedia?.("(display-mode: standalone)");
    const onModeChange = (e: MediaQueryListEvent) => {
      if (e.matches) onInstalled();
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    mq?.addEventListener?.("change", onModeChange);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
      mq?.removeEventListener?.("change", onModeChange);
    };
  }, []);

  const onInstallClick = useCallback(async () => {
    if (deferred) {
      try {
        await deferred.prompt();
        const choice = await deferred.userChoice;
        console.log(`[pwa] install prompt outcome: ${choice.outcome}`);
        // The event is single-use either way - Chrome will fire a fresh
        // beforeinstallprompt later if the user only dismissed.
        setDeferred(null);
      } catch (err) {
        console.warn("[pwa] install prompt failed:", err);
        setDeferred(null);
      }
      return;
    }
    if (isIosSafari()) setShowIosHelp(true);
  }, [deferred]);

  // Installed (or running standalone): no button at all.
  if (installed) return null;
  // Nothing to offer on this browser (desktop Firefox, already-prompted...)
  const ios = isIosSafari();
  if (!deferred && !ios) return null;

  return (
    <>
      <button
        type="button"
        data-testid="install-app"
        onClick={() => void onInstallClick()}
        className="shrink-0 cursor-pointer border border-neutral-500 px-2 py-0.5 font-term text-[11px] font-bold tracking-[0.15em] text-neutral-300 hover:bg-neutral-200 hover:text-black"
        title="Install BitWeb as an app - works offline, no app store"
      >
        [ INSTALL ]
      </button>

      {showIosHelp ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Install BitWeb on this device"
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/90 p-4"
          onClick={() => setShowIosHelp(false)}
        >
          <div
            className="w-full max-w-md border border-neutral-400 bg-black p-5 font-term text-sm leading-relaxed text-neutral-200"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 border-b border-neutral-700 pb-2 text-base font-bold tracking-[0.2em]">
              INSTALL BITWEB
            </div>
            <p className="mb-3 text-neutral-400">
              This browser keeps installs behind its own menu. Three taps:
            </p>
            <ol className="mb-4 list-none space-y-2">
              <li>
                <span className="text-neutral-500">1.</span> Tap the{" "}
                <span className="border border-neutral-500 px-1 font-bold">Share</span> button
                (square with an arrow, bottom toolbar).
              </li>
              <li>
                <span className="text-neutral-500">2.</span> Scroll down and tap{" "}
                <span className="border border-neutral-500 px-1 font-bold">
                  Add to Home Screen
                </span>
                .
              </li>
              <li>
                <span className="text-neutral-500">3.</span> Tap{" "}
                <span className="border border-neutral-500 px-1 font-bold">Add</span>. The node
                then boots offline, straight from your home screen.
              </li>
            </ol>
            <p className="mb-4 text-[11px] text-neutral-500">
              Keys and the chain live on this device either way - installing changes nothing
              about custody.
            </p>
            <button
              type="button"
              onClick={() => setShowIosHelp(false)}
              className="w-full cursor-pointer border border-neutral-400 py-1.5 font-bold tracking-[0.2em] hover:bg-neutral-200 hover:text-black"
            >
              [ CLOSE ]
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}
