// Payment-URI payload spec for QR codes (BIP-21 style).
//   bitweb:btw1<48hex>?amount=<coins>
// A bare btw1 address is also accepted when scanning (many wallets scan plain addresses).
// Shared by the Qr display component (encode) and the QrScanner (decode).
import { checkAddress } from "./bitweb";
import { parseCoins, unitsToCoins } from "@contracts/protocol";

export const PAYMENT_URI_SCHEME = "bitweb";

export interface PaymentRequest {
  address: string;
  /** Decimal coin string, e.g. "12.5". Undefined when the QR carries no amount. */
  amount?: string;
}

/**
 * Build a payment URI for QR display.
 * `amountCoins` may be a human decimal string ("12.5") - validated via parseCoins -
 * or omitted entirely for a bare address QR.
 * Returns null when the address or amount is invalid.
 */
export function buildPaymentUri(address: string, amountCoins?: string): string | null {
  const addr = address.trim().toLowerCase();
  if (!checkAddress(addr)) return null;
  const base = `${PAYMENT_URI_SCHEME}:${addr}`;
  if (amountCoins === undefined || amountCoins.trim() === "") return base;
  const units = parseCoins(amountCoins.trim());
  if (units === null || units < 1) return null;
  // Normalise through units so "12.50000000" and "12.5" encode identically.
  return `${base}?amount=${encodeURIComponent(unitsToCoins(units))}`;
}

/**
 * Parse scanned QR text into a payment request.
 * Accepts:
 *   bitweb:btw1...
 *   bitweb:btw1...?amount=12.5   (also &amount= or extra unknown params - unknown params are ignored)
 *   btw1...                     (bare address, case-insensitive)
 * Returns null on anything invalid. Never throws.
 */
export function parsePaymentUri(text: string): PaymentRequest | null {
  if (typeof text !== "string") return null;
  let raw = text.trim();
  if (raw.length === 0 || raw.length > 256) return null;

  let amount: string | undefined;

  if (raw.toLowerCase().startsWith(`${PAYMENT_URI_SCHEME}:`)) {
    const rest = raw.slice(PAYMENT_URI_SCHEME.length + 1);
    const q = rest.indexOf("?");
    const addr = (q === -1 ? rest : rest.slice(0, q)).trim().toLowerCase();
    if (!checkAddress(addr)) return null;
    if (q !== -1) {
      const params = rest.slice(q + 1).split("&");
      for (const p of params) {
        const eq = p.indexOf("=");
        if (eq === -1) continue;
        const key = p.slice(0, eq).trim().toLowerCase();
        if (key !== "amount") continue;
        let decoded: string;
        try {
          decoded = decodeURIComponent(p.slice(eq + 1));
        } catch {
          return null;
        }
        const units = parseCoins(decoded.trim());
        if (units === null || units < 1) return null;
        amount = unitsToCoins(units);
      }
    }
    return { address: addr, amount };
  }

  // Bare address fallback.
  raw = raw.toLowerCase();
  if (checkAddress(raw)) return { address: raw };
  return null;
}
