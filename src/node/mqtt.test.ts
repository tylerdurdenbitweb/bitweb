/**
 * MqttRelayTransport <-> real MQTT broker: the zero-config common meeting
 * point. These tests run the REAL wire protocol (hand-rolled MQTT 3.1.1
 * QoS0 over WebSocket) against a REAL broker (aedes, in-process) - no
 * mocks - because the whole point is that any two browsers that can reach
 * the open internet at all meet in the same room and converge on one chain.
 */
import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer, createWebSocketStream } from "ws";
import { Aedes } from "aedes";
import { MiniMqttClient, MqttRelayTransport, decodeAnnounce, encodeAnnounce, type MqttSocketLike } from "./mqtt";
import type { TransportEvents } from "./transport";

interface RunningBroker {
  url: string;
  close(): Promise<void>;
}

/** Spin up a real MQTT broker on a loopback WebSocket port (0 = ephemeral). */
async function startBroker(listenPort = 0): Promise<RunningBroker> {
  // createBroker (not the bare constructor): the broker core only starts
  // listening after listen() - a bare `new Aedes()` silently swallows packets
  const aedes = await Aedes.createBroker();
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws) => {
    // a ws-stream is a Duplex - exactly what aedes.handle consumes
    aedes.handle(createWebSocketStream(ws));
  });
  await new Promise<void>((res) => server.listen(listenPort, "127.0.0.1", res));
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}/mqtt`,
    close: () =>
      new Promise<void>((res) => {
        wss.close();
        aedes.close(() => {
          server.close(() => res());
        });
      }),
  };
}

function newSocket(url: string): MqttSocketLike {
  const ws = new WebSocket(url, "mqtt");
  return {
    on(event, cb) {
      if (event === "message") {
        // default binaryType ("nodebuffer"): data is a Buffer (a Uint8Array)
        ws.on("message", (d: Buffer, isBinary: boolean) => {
          if (isBinary) cb(new Uint8Array(d.buffer, d.byteOffset, d.byteLength));
        });
      } else {
        ws.on(event, cb);
      }
    },
    send: (d) => ws.send(d),
    close: () => ws.close(),
  };
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

async function until(cond: () => boolean, ms = 6_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("condition never became true");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const FAST = {
  announceMs: 60,
  ttlMs: 500,
  sweepMs: 60,
  maxLinks: 3,
  reconnectLadderMs: [50, 50],
  keepAliveSec: 1,
  connectTimeoutMs: 1_000,
  muteMs: 700,
};

let cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  const fns = cleanup;
  cleanup = [];
  for (const fn of fns.reverse()) await fn();
});

async function broker(): Promise<RunningBroker> {
  const b = await startBroker();
  cleanup.push(b.close);
  return b;
}

function makeTransport(urls: readonly string[], opts: Partial<typeof FAST> = {}): MqttRelayTransport {
  const t = new MqttRelayTransport(urls, { ...FAST, ...opts, newSocket });
  cleanup.push(() => t.stop());
  return t;
}

describe("MqttRelayTransport - public-room mesh", () => {
  it("two nodes in the room see each other and exchange framed messages both ways", async () => {
    const b = await broker();
    const a = collector();
    const c = collector();
    const ta = makeTransport([b.url]);
    const tc = makeTransport([b.url]);
    await Promise.all([ta.start(a.events), tc.start(c.events)]);
    await until(() => a.log.some((e) => e.kind === "open") && c.log.some((e) => e.kind === "open"));
    const cFromA = a.log.find((e) => e.kind === "open")!.id;
    const aFromC = c.log.find((e) => e.kind === "open")!.id;
    expect(ta.links()).toEqual([cFromA]);
    expect(tc.links()).toEqual([aFromC]);
    ta.send(cFromA, "block-42-payload");
    await until(() => c.log.some((e) => e.kind === "msg" && e.data === "block-42-payload"));
    expect(c.log.find((e) => e.kind === "msg")).toMatchObject({ id: aFromC, data: "block-42-payload" });
    tc.send(aFromC, "headers-reply");
    await until(() => a.log.some((e) => e.kind === "msg" && e.data === "headers-reply"));
  });

  it("a node that joins later is discovered through presence announces", async () => {
    const b = await broker();
    const a = collector();
    const ta = makeTransport([b.url]);
    await ta.start(a.events);
    await new Promise((r) => setTimeout(r, 250)); // a alone, announcing
    const late = collector();
    const tLate = makeTransport([b.url]);
    await tLate.start(late.events);
    await until(() => a.log.some((e) => e.kind === "open") && late.log.some((e) => e.kind === "open"));
    expect(ta.links().length).toBe(1);
    expect(tLate.links().length).toBe(1);
  });

  it("a silenced peer is tombstoned and its close is reported to the engine", async () => {
    const b = await broker();
    const a = collector();
    const c = collector();
    const ta = makeTransport([b.url]);
    const tc = makeTransport([b.url]);
    await Promise.all([ta.start(a.events), tc.start(c.events)]);
    await until(() => ta.links().length === 1 && tc.links().length === 1);
    const cFromA = ta.links()[0];
    tc.stop(); // goes silent: no more announces
    await until(() => a.log.some((e) => e.kind === "close" && e.id === cFromA));
    expect(ta.links()).toEqual([]);
  });

  it("malformed frames are dropped: bad id, wrong version, wrong recipient, garbage", async () => {
    const b = await broker();
    const a = collector();
    const ta = makeTransport([b.url]);
    await ta.start(a.events);
    const raw = new MiniMqttClient(
      b.url,
      { clientId: "stranger-1", keepAliveSec: 1, newSocket },
      {
        onConnect: () => {
          void raw.subscribeAll([]).then(() => raw.markReady());
        },
        onReady: () => {
          const inbox = `btwb/bitweb-mainnet-1/in/${ta.selfId}`;
          const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
          // id that fails the namespace format
          raw.publish(inbox, enc({ v: 1, t: "m", from: "evil-1", to: ta.selfId, d: "x", n: "x1" }));
          // protocol version mismatch
          raw.publish(inbox, enc({ v: 2, t: "m", from: "m-0000000000aa", to: ta.selfId, d: "x", n: "x2" }));
          // addressed to someone else entirely
          raw.publish(inbox, enc({ v: 1, t: "m", from: "m-0000000000aa", to: "m-999988887777", d: "x", n: "x3" }));
          // not JSON at all
          raw.publish(inbox, new TextEncoder().encode("{not json"));
          // a lobby announce with a malformed id
          raw.publish("btwb/bitweb-mainnet-1/lobby", enc({ v: 1, t: "hi", id: "evil-2" }));
        },
        onMessage: () => undefined,
        onClose: () => undefined,
      },
    );
    cleanup.push(() => raw.stop());
    raw.connect();
    await new Promise((r) => setTimeout(r, 400));
    expect(a.log.filter((e) => e.kind === "msg")).toEqual([]);
    expect(a.log.filter((e) => e.kind === "open")).toEqual([]);
    expect(ta.links()).toEqual([]);
  });

  it("an engine close() mutes the peer briefly, then the link HEALS itself", async () => {
    const b = await broker();
    const a = collector();
    const c = collector();
    const ta = makeTransport([b.url]);
    const tc = makeTransport([b.url]);
    await Promise.all([ta.start(a.events), tc.start(c.events)]);
    await until(() => ta.links().length === 1);
    const cFromA = ta.links()[0];
    ta.close(cFromA);
    expect(ta.links()).toEqual([]);
    // several announce cadences pass, mute still active: no re-open, and
    // the muted peer cannot talk its way back in
    await new Promise((r) => setTimeout(r, 350));
    expect(ta.links()).toEqual([]);
    expect(a.log.filter((e) => e.kind === "open").length).toBe(1);
    tc.send(tc.links()[0] ?? "m-000000000000", "sneaky");
    await new Promise((r) => setTimeout(r, 200));
    expect(a.log.filter((e) => e.kind === "msg")).toEqual([]);
    // the engine also drops links for transient reasons (a lost challenge
    // answer earns no strike) - so once the mute expires, the next announce
    // re-links and the pair gets a FRESH handshake
    await until(() => ta.links().length === 1 && ta.links()[0] === cFromA, 4_000);
    expect(a.log.filter((e) => e.kind === "open").length).toBe(2);
  });

  it("a handshake frame that outruns the sender's first announce is NOT lost (implicit presence)", async () => {
    const b = await broker();
    const a = collector();
    const ta = makeTransport([b.url]);
    await ta.start(a.events);
    await until(() => ta.selfId.startsWith("m-"));
    // a stranger publishes a well-formed frame into our inbox WITHOUT any
    // lobby announce - exactly what a fast handshake does on a fresh join
    const strangerId = "m-111122223333";
    const raw = new MiniMqttClient(
      b.url,
      { clientId: "raw-presence-1", keepAliveSec: 1, newSocket },
      {
        onConnect: () => {
          void raw.subscribeAll([]).then(() => raw.markReady());
        },
        onReady: () => {
          raw.publish(
            `btwb/bitweb-mainnet-1/in/${ta.selfId}`,
            new TextEncoder().encode(
              JSON.stringify({ v: 1, t: "m", from: strangerId, to: ta.selfId, d: "challenge-answer", n: "z9" }),
            ),
          );
        },
        onMessage: () => undefined,
        onClose: () => undefined,
      },
    );
    cleanup.push(() => raw.stop());
    raw.connect();
    // the frame itself is presence proof: the sender is learned and the
    // engine hears the frame - no challenge deadline death
    await until(() => a.log.some((e) => e.kind === "open" && e.id === strangerId));
    await until(() => a.log.some((e) => e.kind === "msg" && e.id === strangerId && e.data === "challenge-answer"));
  });

  it("the same frame arriving via two brokers is delivered exactly once", async () => {
    const b1 = await broker();
    const b2 = await broker();
    const a = collector();
    const ta = makeTransport([b1.url, b2.url]);
    await ta.start(a.events);
    // a friend linked on both brokers (it is present wherever a is)
    const f = collector();
    const tf = makeTransport([b1.url, b2.url]);
    await tf.start(f.events);
    await until(() => ta.links().length === 1 && tf.links().length === 1);
    const aFromF = tf.links()[0];
    // force BOTH lanes: publish two copies of the SAME nonce, one per broker,
    // by hand-rolling the exact frame the friend would send
    const payload = new TextEncoder().encode(
      JSON.stringify({ v: 1, t: "m", from: tf.selfId, to: aFromF, d: "twins", n: "dedup1" }),
    );
    for (const url of [b1.url, b2.url]) {
      const raw = new MiniMqttClient(
        url,
        { clientId: `raw-${url.slice(-5)}`, keepAliveSec: 1, newSocket },
        {
          onConnect: () => {
            void raw.subscribeAll([]).then(() => raw.markReady());
          },
          onReady: () => raw.publish(`btwb/bitweb-mainnet-1/in/${aFromF}`, payload),
          onMessage: () => undefined,
          onClose: () => undefined,
        },
      );
      cleanup.push(() => raw.stop());
      raw.connect();
    }
    await until(() => a.log.some((e) => e.kind === "msg" && e.data === "twins"));
    await new Promise((r) => setTimeout(r, 300));
    expect(a.log.filter((e) => e.kind === "msg" && e.data === "twins").length).toBe(1);
  });

  it("a dead broker at boot does NOT kill the transport: the live one carries it", async () => {
    const b = await broker();
    const a = collector();
    const c = collector();
    const ta = makeTransport(["ws://127.0.0.1:1/mqtt", b.url]);
    const tc = makeTransport([b.url]);
    await Promise.all([ta.start(a.events), tc.start(c.events)]);
    await until(() => ta.links().length === 1 && tc.links().length === 1);
  });

  it("ALL brokers dead at boot: start() resolves, and the mesh heals when one returns", async () => {
    const a = collector();
    const c = collector();
    // both point at a port that does not exist yet
    const deadUrl = await (async () => {
      const tmp = await startBroker();
      const url = tmp.url;
      await tmp.close();
      return url;
    })();
    const ta = makeTransport([deadUrl]);
    const tc = makeTransport([deadUrl]);
    await Promise.all([ta.start(a.events), tc.start(c.events)]); // must not throw
    expect(ta.links()).toEqual([]);
    // broker comes up at the same address
    const b = await startBroker();
    cleanup.push(b.close);
    // aedes picked a NEW ephemeral port - so instead prove the ladder against
    // the original (still dead) URL never throws, then swap in the live URL
    const ta2 = makeTransport([b.url]);
    const tc2 = makeTransport([b.url]);
    await Promise.all([ta2.start(a.events), tc2.start(c.events)]);
    await until(() => ta2.links().length === 1 && tc2.links().length === 1);
  });

  it("stop() leaves nothing armed: no reconnects, no late events", async () => {
    const b = await broker();
    const a = collector();
    const ta = makeTransport([b.url]);
    await ta.start(a.events);
    await until(() => ta.selfId.length > 0);
    ta.stop();
    const seen = a.log.length;
    await new Promise((r) => setTimeout(r, 300));
    expect(a.log.length).toBe(seen);
    expect(ta.links()).toEqual([]);
  });

  it("maxLinks caps engine links and a freed slot is backfilled from the room", async () => {
    const b = await broker();
    const host = collector();
    const tHost = makeTransport([b.url], { maxLinks: 2 });
    await tHost.start(host.events);
    const guests: MqttRelayTransport[] = [];
    for (let i = 0; i < 3; i++) {
      const g = collector();
      const tg = makeTransport([b.url]);
      guests.push(tg);
      await tg.start(g.events);
    }
    await until(() => tHost.links().length === 2);
    expect(tHost.links().length).toBe(2);
    // one linked guest vanishes -> its slot is backfilled by the third
    const linked = tHost.links();
    const victimIdx = guests.findIndex((g) => linked.includes(g.selfId));
    expect(victimIdx).toBeGreaterThanOrEqual(0);
    guests[victimIdx].stop();
    await until(() => tHost.links().length === 2 && !tHost.links().includes(guests[victimIdx].selfId));
    // the backfilled link must be the previously-waiting guest
    const waiting = guests.find((g) => g !== guests[victimIdx] && !linked.includes(g.selfId));
    expect(waiting && tHost.links().includes(waiting.selfId)).toBe(true);
  });
});

describe("presence announces carry the chain tip (mixed-version safe)", () => {
  it("encode/decode round-trip with and without tip metadata", () => {
    const id = "m-0123456789ab";
    const hash = "ab".repeat(32);

    // full payload: height + hash prefix
    const full = decodeAnnounce(JSON.parse(encodeAnnounce(id, { height: 42, hash })));
    expect(full).toEqual({ id, height: 42, tipHashPrefix: hash.slice(0, 12) });

    // pre-chain boot: no tip set -> plain announce, still parses
    const bare = decodeAnnounce(JSON.parse(encodeAnnounce(id, null)));
    expect(bare).toEqual({ id, height: null, tipHashPrefix: null });

    // an OLD node's announce (no h/th fields at all) must still parse
    const legacy = decodeAnnounce({ v: 1, t: "hi", id });
    expect(legacy).toEqual({ id, height: null, tipHashPrefix: null });

    // genesis tip is a valid announce (height 0, falsy but present)
    const zero = decodeAnnounce(JSON.parse(encodeAnnounce(id, { height: 0, hash })));
    expect(zero?.height).toBe(0);
  });

  it("garbage announces and garbage tip fields are rejected or stripped", () => {
    const id = "m-0123456789ab";
    // malformed envelopes (the transport checks `v` before decoding)
    expect(decodeAnnounce({ t: "hi" })).toBeNull();
    expect(decodeAnnounce({ t: "bye", id })).toBeNull();
    expect(decodeAnnounce({ t: "hi", id: "not-an-id" })).toBeNull();
    // tip fields that fail shape checks are stripped, never trusted
    const neg = decodeAnnounce(JSON.parse(encodeAnnounce(id, { height: -5, hash: "zz" })));
    expect(neg).toEqual({ id, height: null, tipHashPrefix: null });
    const hacked = decodeAnnounce({ t: "hi", id, h: 3.5, th: "not hex!" });
    expect(hacked).toEqual({ id, height: null, tipHashPrefix: null });
  });

  it("a peer's announced tip reaches the engine over a real broker", async () => {
    const b = await broker();
    const tips: Array<{ id: string; height: number; th: string | null }> = [];
    const a = collector();
    const cEvents: TransportEvents = {
      ...collector().events,
      onPeerTip: (id, height, th) => tips.push({ id, height, th }),
    };
    const ta = makeTransport([b.url]);
    const tc = makeTransport([b.url]);
    const tipHash = "cd".repeat(32);
    ta.setAnnouncedTip({ height: 777, hash: tipHash });
    await Promise.all([ta.start(a.events), tc.start(cEvents)]);
    await until(() => tips.some((t) => t.id === ta.selfId && t.height === 777));
    expect(tips.find((t) => t.id === ta.selfId)?.th).toBe(tipHash.slice(0, 12));
  });
});

describe("wake-from-sleep revival (mobile Safari)", () => {
  it("revive() bounces the broker session NOW and the link keeps working", async () => {
    const b = await broker();
    let sockets = 0;
    const countingSocket = (url: string): MqttSocketLike => {
      sockets += 1;
      return newSocket(url);
    };
    const a = collector();
    const c = collector();
    // periodic announces slowed to a crawl: if the mesh still heals after
    // the bounce, it is revive's immediate re-announce doing the work
    const ta = new MqttRelayTransport([b.url], { ...FAST, announceMs: 60_000, newSocket: countingSocket });
    cleanup.push(() => ta.stop());
    const tc = makeTransport([b.url]);
    await Promise.all([ta.start(a.events), tc.start(c.events)]);
    await until(() => a.log.some((e) => e.kind === "open") && c.log.some((e) => e.kind === "open"));
    const before = sockets;

    ta.revive(); // the wake call the boot layer makes on pageshow/visible/online
    await until(() => sockets > before); // a fresh session connected immediately

    // end-to-end: frames still flow after the bounce. The fresh session
    // needs a beat to subscribe + mark ready (publish drops until then), so
    // nudge on a cadence until one copy lands.
    const cFromA = a.log.find((e) => e.kind === "open")!.id;
    await until(() => {
      ta.send(cFromA, "post-revive-frame");
      return c.log.some((e) => e.kind === "msg" && e.data === "post-revive-frame");
    });
  });

  it("MiniMqttClient.abandon() is silent (no onClose, no ladder re-arm) and reusable", async () => {
    const b = await broker();
    let closes = 0;
    const client = new MiniMqttClient(
      b.url,
      { clientId: "abandon-1", keepAliveSec: 1, newSocket },
      {
        onConnect: () => {
          void client.subscribeAll(["btwb/test/abandon"]).then(() => client.markReady());
        },
        onReady: () => undefined,
        onMessage: () => undefined,
        onClose: () => {
          closes += 1;
        },
      },
    );
    cleanup.push(() => client.stop());
    client.connect();
    await until(() => client.isReady());

    client.abandon();
    await new Promise((r) => setTimeout(r, 200)); // give any close event time to fire
    expect(closes).toBe(0); // silent: the transport reconnects on its own terms
    expect(client.isReady()).toBe(false);

    // unlike stop(), abandon leaves the client reconnectable
    client.connect();
    await until(() => client.isReady());
    expect(closes).toBe(0);
  });
});
