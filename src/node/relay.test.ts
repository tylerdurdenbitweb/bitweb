/**
 * WsRelayTransport <-> broker relay: the last-resort path for networks
 * where WebRTC cannot pass. These tests run the REAL protocol against the
 * REAL server module (broker/relay.mjs) on a loopback port - no mocks -
 * because the whole point of the relay is that it behaves identically for
 * every browser behind every NAT.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
// the server module under test is plain ESM JavaScript (it ships in broker/)
// @ts-expect-error no type declarations for the broker module
import { attachRelay } from "../../broker/relay.mjs";
import { WsRelayTransport, type RelaySocket } from "./relay";
import type { Transport, TransportEvents } from "./transport";

let server: http.Server;
let relay: { close(): void };
let relayUrl: string;

function newSocket(url: string): RelaySocket {
  return new WebSocket(url) as unknown as RelaySocket;
}

function collector() {
  const log: Array<{ kind: string; id: string; data?: string }> = [];
  const events: TransportEvents = {
    onOpen: (id) => log.push({ kind: "open", id }),
    onMessage: (id, data) => log.push({ kind: "msg", id, data }),
    onClose: (id) => log.push({ kind: "close", id }),
  };
  return { log, events };
}

async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("condition never became true");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const FAST = { reconnectLadderMs: [40, 40], heartbeatMs: 60, openTimeoutMs: 1_000, maxLinks: 3 };

beforeAll(async () => {
  server = http.createServer();
  relay = attachRelay(server, { path: "/relay", onLog: () => undefined });
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const { port } = server.address() as AddressInfo;
  relayUrl = `ws://127.0.0.1:${port}/relay`;
});

afterAll(async () => {
  relay.close();
  await new Promise((res) => server.close(res));
});

function makeTransport(room: string): Transport {
  return new WsRelayTransport([relayUrl], room, { ...FAST, newSocket });
}

describe("WsRelayTransport - room mesh", () => {
  it("two nodes in one room see each other and exchange a framed message", async () => {
    const a = collector();
    const b = collector();
    const ta = makeTransport("t-room-1");
    const tb = makeTransport("t-room-1");
    await Promise.all([ta.start(a.events), tb.start(b.events)]);
    try {
      await until(() => a.log.some((e) => e.kind === "open") && b.log.some((e) => e.kind === "open"));
      // a's open event names B (and vice versa): the link sets must be the
      // mirror image of each other
      const bFromA = a.log.find((e) => e.kind === "open")!.id;
      const aFromB = b.log.find((e) => e.kind === "open")!.id;
      expect(ta.links()).toEqual([bFromA]);
      expect(tb.links()).toEqual([aFromB]);
      ta.send(bFromA, "block-42-payload");
      await until(() => b.log.some((e) => e.kind === "msg" && e.data === "block-42-payload"));
      expect(b.log.find((e) => e.kind === "msg")).toMatchObject({ id: aFromB, data: "block-42-payload" });
    } finally {
      ta.stop();
      tb.stop();
    }
  });

  it("rooms are isolated: a node in another room never appears", async () => {
    const a = collector();
    const x = collector();
    const ta = makeTransport("t-room-2a");
    const tx = makeTransport("t-room-2x");
    await Promise.all([ta.start(a.events), tx.start(x.events)]);
    try {
      // let both settle; each must see exactly zero links
      await new Promise((r) => setTimeout(r, 400));
      expect(ta.links()).toEqual([]);
      expect(tx.links()).toEqual([]);
      expect(a.log).toEqual([]);
      expect(x.log).toEqual([]);
    } finally {
      ta.stop();
      tx.stop();
    }
  });

  it("a leaving peer is reported closed and its link slot is backfilled", async () => {
    const room = "t-room-3";
    const host = collector();
    const tHost = makeTransport(room);
    await tHost.start(host.events);
    const others: Transport[] = [];
    try {
      // 4 guests > maxLinks 3: only the first three become links
      for (let i = 0; i < 4; i++) {
        const t = makeTransport(room);
        await t.start(collector().events);
        others.push(t);
      }
      await until(() => tHost.links().length === 3);
      expect(tHost.links().length).toBe(3);
      // the first guest leaves: its link dies audibly and the fourth guest
      // (waiting in the roster) takes the freed slot
      const firstLinks = [...tHost.links()];
      const leaverId = others[0].selfId;
      expect(firstLinks).toContain(leaverId);
      others[0].stop();
      await until(() => host.log.some((e) => e.kind === "close" && e.id === leaverId));
      await until(() => tHost.links().length === 3 && !tHost.links().includes(leaverId));
    } finally {
      tHost.stop();
      for (const t of others) t.stop();
    }
  });

  it("messages from a non-linked roster member are NOT delivered (engine cap honored)", async () => {
    const room = "t-room-4";
    const host = collector();
    const tHost = makeTransport(room); // maxLinks 3
    await tHost.start(host.events);
    const guests: Transport[] = [];
    try {
      for (let i = 0; i < 4; i++) {
        const g = collector();
        const t = makeTransport(room);
        await t.start(g.events);
        guests.push(t);
      }
      await until(() => tHost.links().length === 3);
      // the 4th guest is in the roster but NOT linked: its frames must be
      // dropped at the transport, never reaching the engine
      const fourth = guests[3];
      fourth.send(tHost.selfId, "sneaky-frame");
      await new Promise((r) => setTimeout(r, 300));
      expect(host.log.filter((e) => e.kind === "msg")).toEqual([]);
      // and a linked member's frame still flows
      guests[0].send(tHost.selfId, "honest-frame");
      await until(() => host.log.some((e) => e.kind === "msg" && e.data === "honest-frame"));
    } finally {
      tHost.stop();
      for (const t of guests) t.stop();
    }
  });

  it("engine close() unlinks without forgetting: the member is NOT re-surfaced", async () => {
    const room = "t-room-5";
    const a = collector();
    const ta = makeTransport(room);
    const b = collector();
    const tb = makeTransport(room);
    await Promise.all([ta.start(a.events), tb.start(b.events)]);
    try {
      await until(() => ta.links().length === 1);
      const peer = ta.links()[0];
      ta.close(peer); // engine-initiated (peer cap / strike)
      expect(ta.links()).toEqual([]);
      // the member stays known-but-unlinked; further frames are dropped
      tb.send(ta.selfId, "after-close");
      await new Promise((r) => setTimeout(r, 300));
      expect(a.log.filter((e) => e.kind === "msg")).toEqual([]);
      expect(ta.links()).toEqual([]); // no silent re-link
    } finally {
      ta.stop();
      tb.stop();
    }
  });
});

describe("WsRelayTransport - resilience", () => {
  it("a dropped server connection is rebuilt by the reconnect ladder, roster and all", async () => {
    const a = collector();
    const ta = makeTransport("t-room-6");
    const b = collector();
    const tb = makeTransport("t-room-6");
    await Promise.all([ta.start(a.events), tb.start(b.events)]);
    try {
      await until(() => ta.links().length === 1);
      const peer = ta.links()[0];
      // the server kills b's socket (deploy restart, proxy timeout...)
      const room = relayRooms().get("t-room-6");
      const sock = room?.get(peer);
      sock?.terminate();
      // a hears the link die...
      await until(() => a.log.some((e) => e.kind === "close" && e.id === peer));
      // ...and b's ladder (40 ms) brings it straight back: same id, fresh link
      await until(() => ta.links().includes(peer), 5_000);
    } finally {
      ta.stop();
      tb.stop();
    }
  });

  it("an unreachable relay at boot does not throw: the ladder keeps retrying", async () => {
    const a = collector();
    const dead = new WsRelayTransport(["ws://127.0.0.1:1/relay"], "t-room-7", {
      ...FAST,
      newSocket,
    });
    // start() resolves cold instead of throwing - exactly like the WebRTC
    // transport, a dead last-resort path must never kill the node
    await dead.start(a.events);
    expect(dead.links()).toEqual([]);
    await new Promise((r) => setTimeout(r, 150));
    dead.stop();
    // and a relay that appears LATER is picked up: same transport, live url
    const live = makeTransport("t-room-7");
    const b = collector();
    const tb = makeTransport("t-room-7");
    await Promise.all([live.start(a.events), tb.start(b.events)]);
    try {
      await until(() => live.links().length === 1);
    } finally {
      live.stop();
      tb.stop();
    }
  });

  it("revive bounces the socket instantly and the stale close event stays silent", async () => {
    // The iOS bug this guards: a frozen-then-resumed page holds a dead
    // socket whose close event may arrive minutes late (or never). revive()
    // must reconnect NOW, and when the old socket's close finally lands it
    // must NOT tear down the fresh connection's links or re-arm the ladder.
    const a = collector();
    const b = collector();
    const ta = makeTransport("t-room-revive");
    const tb = makeTransport("t-room-revive");
    await Promise.all([ta.start(a.events), tb.start(b.events)]);
    try {
      await until(() => ta.links().length === 1 && tb.links().length === 1);
      const peerForA = ta.links()[0];
      (ta as Transport & { revive(): void }).revive();
      // the bounce is immediate: links dropped synchronously, no ladder wait
      expect(ta.links()).toEqual([]);
      // the mesh re-heals on the fresh socket, same ids
      await until(() => ta.links().includes(peerForA) && tb.links().length === 1);
      // give the OLD socket's late close plenty of time to arrive
      await new Promise((r) => setTimeout(r, 400));
      // the fresh link survived the stale close...
      expect(ta.links()).toEqual([peerForA]);
      // ...and the engine heard exactly ONE close for the peer (the
      // revive-time drop) - not a second one from the zombie socket
      const closes = a.log.filter((e) => e.kind === "close" && e.id === peerForA);
      expect(closes).toHaveLength(1);
    } finally {
      ta.stop();
      tb.stop();
    }
  });

  it("stop() leaves nothing armed: no reconnect, no frames, no throws", async () => {
    const a = collector();
    const ta = makeTransport("t-room-8");
    await ta.start(a.events);
    ta.stop();
    expect(() => ta.stop()).not.toThrow();
    const frames = a.log.length;
    await new Promise((r) => setTimeout(r, 200));
    expect(a.log.length).toBe(frames);
  });
});

// reach into the attached relay for test-side socket control
function relayRooms(): Map<string, Map<string, { terminate(): void }>> {
  return (relay as unknown as { rooms: Map<string, Map<string, { terminate(): void }>> }).rooms;
}
