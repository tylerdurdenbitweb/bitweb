/**
 * Feedback diff policy tests - the pure decision behind useFeedbackWatcher
 * (classifyIncoming). Covers the regression that earned coins arrived
 * silently: PoP peer-pool credits (type "pop") were never classified, so
 * no notification entry and no sound ever fired for them.
 */
import { describe, expect, it } from "vitest";
import { classifyIncoming } from "./useFeedbackWatcher";
import type { TxRow } from "@/node/storage";

const ME = "btwb1me";
const OTHER = "btwb1other";

function row(partial: Partial<TxRow> & { txid: string }): TxRow {
  return {
    blockHeight: 7,
    type: "transfer",
    fromAddress: OTHER,
    toAddress: ME,
    amount: 100_0000_0000,
    fee: 0,
    nonce: 1,
    txIndex: 1,
    pubkey: null,
    signature: null,
    timestamp: 1_787_443_201,
    ...partial,
  };
}

describe("classifyIncoming", () => {
  it("classifies an incoming transfer from someone else as received", () => {
    const out = classifyIncoming(ME, [row({ txid: "a" })], new Set());
    expect(out).toEqual([{ kind: "received", tx: expect.objectContaining({ txid: "a" }) }]);
  });

  it("classifies a PoP participation credit as pop (the silent-earnings bug)", () => {
    const out = classifyIncoming(
      ME,
      [row({ txid: "p1", type: "pop", fromAddress: null, amount: 20_0000_0000 })],
      new Set(),
    );
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("pop");
    expect(out[0].tx.amount).toBe(20_0000_0000);
  });

  it("skips coinbase rows: own mined blocks already fired block_found", () => {
    const out = classifyIncoming(
      ME,
      [row({ txid: "cb", type: "coinbase", fromAddress: null, txIndex: 0 })],
      new Set(),
    );
    expect(out).toEqual([]);
  });

  it("ignores rows already seen in a previous poll", () => {
    const history = [row({ txid: "a" }), row({ txid: "p1", type: "pop", fromAddress: null })];
    expect(classifyIncoming(ME, history, new Set(["a", "p1"]))).toEqual([]);
    expect(classifyIncoming(ME, history, new Set(["a"]))).toHaveLength(1);
  });

  it("ignores outgoing rows: our own sends and pop credits to others", () => {
    const out = classifyIncoming(
      ME,
      [
        row({ txid: "s", fromAddress: ME, toAddress: OTHER }), // we sent it
        row({ txid: "p2", type: "pop", fromAddress: null, toAddress: OTHER }), // not ours
        row({ txid: "r", fromAddress: ME, toAddress: ME }), // self-transfer
      ],
      new Set(),
    );
    expect(out).toEqual([]);
  });

  it("keeps poll order when several rows classify at once", () => {
    const out = classifyIncoming(
      ME,
      [
        row({ txid: "p1", type: "pop", fromAddress: null }),
        row({ txid: "a" }),
        row({ txid: "cb", type: "coinbase", fromAddress: null, txIndex: 0 }),
      ],
      new Set(),
    );
    expect(out.map((o) => o.kind)).toEqual(["pop", "received"]);
  });
});
