// QR display - renders a payload as a scannable QR on a canvas.
// Classic dark-on-light (inverted QRs confuse many phone scanners), framed
// in the terminal aesthetic: a white "punch card" on the black phosphor screen.
import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { cn } from "@/lib/utils";

export function Qr({
  payload,
  /** Canvas pixel size. The element scales responsively via CSS. */
  size = 264,
  caption,
  className,
}: {
  payload: string;
  size?: number;
  caption?: string;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let dead = false;
    QRCode.toCanvas(canvas, payload, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: size,
      color: { dark: "#000000", light: "#ffffff" },
    }).catch(() => {
      if (!dead) setErr(true);
    });
    return () => {
      dead = true;
    };
  }, [payload, size]);

  return (
    <figure className={cn("inline-block", className)}>
      {/*
       * The responsive cap lives on the WRAPPER as a definite width
       * (viewport-relative, never content-derived). Sizing the canvas
       * itself with w-full + max-w-[min(...)] inside a shrink-to-fit
       * inline-block is a cyclic percentage - Chrome happens to resolve
       * it against the canvas' intrinsic size, Firefox legitimately
       * collapses it and the QR vanishes. aspect-ratio is belt and
       * braces for replaced-element sizing quirks.
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
        ) : (
          <canvas
            ref={canvasRef}
            width={size}
            height={size}
            className="block h-auto w-full"
            style={{ aspectRatio: "1 / 1" }}
            role="img"
            aria-label={caption ?? "QR code"}
          />
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
