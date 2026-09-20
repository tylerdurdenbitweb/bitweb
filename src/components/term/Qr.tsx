// QR display - renders a payload as a scannable QR image.
// Classic dark-on-light (inverted QRs confuse many phone scanners), framed
// in the terminal aesthetic: a white "punch card" on the black phosphor screen.
//
// Rendered as a data-URL <img>, NOT a canvas: qrcode's toCanvas stamps a
// fixed pixel size onto the element's inline style (silently defeating
// responsive CSS), and canvas sizing inside shrink-to-fit containers is a
// cyclic-percentage minefield Firefox and Chromium resolve differently -
// the QR rendered blank/overflowing for real users. An <img> has no
// scriptable surface to stomp and one universally supported sizing model.
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { cn } from "@/lib/utils";

export function Qr({
  payload,
  /** Bitmap pixel size. The element scales responsively via CSS. */
  size = 264,
  caption,
  className,
}: {
  payload: string;
  size?: number;
  caption?: string;
  className?: string;
}) {
  // One state slot per render attempt (keyed by payload+size): a stale
  // bitmap from a previous payload is never shown after a failed regen,
  // and no setState fires synchronously inside the effect.
  const [result, setResult] = useState<{ key: string; src: string | null; err: boolean }>({
    key: "",
    src: null,
    err: false,
  });

  const key = `${size}:${payload}`;
  useEffect(() => {
    let dead = false;
    const attempt = `${size}:${payload}`;
    QRCode.toDataURL(payload, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: size,
      color: { dark: "#000000", light: "#ffffff" },
    })
      .then((url) => {
        if (!dead) setResult({ key: attempt, src: url, err: false });
      })
      .catch(() => {
        if (!dead) setResult({ key: attempt, src: null, err: true });
      });
    return () => {
      dead = true;
    };
  }, [payload, size]);

  const current = result.key === key;
  const src = current ? result.src : null;
  const err = current && result.err;

  return (
    <figure className={cn("inline-block", className)}>
      {/*
       * The responsive cap lives on the WRAPPER as a definite width
       * (viewport-relative, never content-derived), so the image's
       * width:100% can never be a cyclic percentage.
       */}
      <div
        className="box-border border-2 border-neutral-200 bg-white p-2 shadow-[0_0_24px_rgba(255,255,255,0.12)]"
        style={{ width: "min(64vw, 280px)" }}
      >
        {err ? (
          <div
            className="flex items-center justify-center text-[11px] text-neutral-500"
            style={{ width: "100%", aspectRatio: "1 / 1" }}
          >
            [QR RENDER FAILED]
          </div>
        ) : src ? (
          <img
            src={src}
            width={size}
            height={size}
            className="block h-auto w-full"
            style={{ aspectRatio: "1 / 1", imageRendering: "pixelated" }}
            alt={caption ?? "QR code"}
            draggable={false}
          />
        ) : (
          <div className="w-full bg-white" style={{ aspectRatio: "1 / 1" }} aria-hidden="true" />
        )}
      </div>
      {caption ? (
        <figcaption className="mt-1.5 text-center text-[10px] uppercase tracking-[0.25em] text-neutral-500">
          {caption}
        </figcaption>
      ) : null}
    </figure>
  );
}
