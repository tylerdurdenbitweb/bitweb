import { describe, expect, it } from "vitest";
import {
  blockContentsAvailable,
  blockFeeTotals,
  linkHealth,
  sortPeers,
  txsByBlock,
} from "./dashboard";
import type { PeerView } from "@/node/p2p";
import type { BlockRow, TxRow } from "@/node/storage";

function tx(partial: Partial<TxRow> & { txid: string; blockHeight: number }): TxRow {
  return {
    type: "transfer",
    fromAddress: "btw1aaa",
    toAddress: "btw1bbb",
    amount: 100,
    fee: 1,
    nonce: 0,
    txIndex: 0,
    pubkey: null,
    signature: null,
    timestamp: 1_700_000_000,
    ...partial,
  };
}

function peer(partial: Partial<PeerView> & { id: string }): PeerView {
  return {
    transport: "mqtt",
    height: 10,
    agent: "bitweb/1",
    strikes: 0,
    connectedAt: 1_000,
    lastSeen: 5_000,
    ...partial,
  };
}

describe("txsByBlock", () => {
  it("groups by height and keeps canonical txIndex order", () => {
    const map = txsByBlock([
      tx({ txid: "c", blockHeight: 7, txIndex: 2 }),
      tx({ txid: "a", blockHeight: 7, txIndex: 0 }),
      tx({ txid: "b", blockHeight: 7, txIndex: 1 }),
      tx({ txid: "z", blockHeight: 8 }),
    ]);
    expect(map.get(7)!.map((t) => t.txid)).toEqual(["a", "b", "c"]);
    expect(map.get(8)!.map((t) => t.txid)).toEqual(["z"]);
    expect(map.has(9)).toBe(false);
  });

  it("returns an empty map for no txs", () => {
    expect(txsByBlock([]).size).toBe(0);
  });
});

describe("sortPeers", () => {
  it("orders by freshest lastSeen, then longest-lived connection", () => {
    const rows = sortPeers([
      peer({ id: "old", lastSeen: 1_000 }),
      peer({ id: "fresh-flappy", lastSeen: 9_000, connectedAt: 8_000 }),
      peer({ id: "fresh-stable", lastSeen: 9_000, connectedAt: 2_000 }),
    ]);
    expect(rows.map((p) => p.id)).toEqual(["fresh-stable", "fresh-flappy", "old"]);
  });

  it("never mutates the input array", () => {
    const input = [peer({ id: "b", lastSeen: 1 }), peer({ id: "a", lastSeen: 2 })];
    sortPeers(input);
    expect(input.map((p) => p.id)).toEqual(["b", "a"]);
  });
});

describe("linkHealth", () => {
  const base = peer({ id: "x", lastSeen: 100_000 });
  it("classifies by lastSeen lag", () => {
    expect(linkHealth(base, 100_000)).toBe("live");
    expect(linkHealth(base, 145_000)).toBe("live");
    expect(linkHealth(base, 146_000)).toBe("quiet");
    expect(linkHealth(base, 220_000)).toBe("quiet");
    expect(linkHealth(base, 221_000)).toBe("stale");
  });
});

describe("blockFeeTotals", () => {
  it("sums fees and counts only transfers", () => {
    const { fees, transfers } = blockFeeTotals([
      tx({ txid: "t1", blockHeight: 3, fee: 5 }),
      tx({ txid: "t2", blockHeight: 3, fee: 7 }),
      tx({ txid: "cb", blockHeight: 3, type: "coinbase", fee: 0 }),
      tx({ txid: "pp", blockHeight: 3, type: "pop", fee: 0 }),
    ]);
    expect(fees).toBe(12);
    expect(transfers).toBe(2);
  });
});

describe("blockContentsAvailable", () => {
  const block = { txCount: 2 } as BlockRow;
  it("is true for empty blocks even without rows", () => {
    expect(blockContentsAvailable({ txCount: 0 } as BlockRow, new Map())).toBe(true);
  });
  it("is true only when the window covers the height", () => {
    expect(blockContentsAvailable(block, new Map([[5, []]]))).toBe(false);
    expect(blockContentsAvailable({ ...block, height: 5 }, new Map([[5, []]]))).toBe(true);
  });
});
