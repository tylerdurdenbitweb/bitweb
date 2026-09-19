/**
 * LIVE public-broker proof - skipped unless LIVE_MQTT=1 is set.
 *
 * The hermetic suite (mqtt.test.ts) runs the real protocol against an
 * in-process broker. This file goes one step further: two transports meet
 * in the REAL public rooms (the exact brokers in network.config.ts), the
 * same way two phones on two carriers will. It is excluded from CI
 * because it depends on the open internet; run it on demand:
 *
 *   LIVE_MQTT=1 npx vitest run src/node/mqtt.live.test.ts
 */
import { describe, it } from "vitest";
import WebSocket from "ws";
import { MqttRelayTransport, type MqttSocketLike } from "./mqtt";
import type { TransportEvents } from "./transport";

const LIVE = process.env.LIVE_MQTT === "1";

function newSocket(url: string): MqttSocketLike {
  // family:4 - some CI sandboxes have broken IPv6 egress and stall on
  // brokers whose DNS publishes AAAA records; browsers do proper Happy
  // Eyeballs and never need this
  const ws = new WebSocket(url, "mqtt", { family: 4 } as never);
  return {
    on(event, cb) {
      if (event === "message") {
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

async function until(cond: () => boolean, ms = 25_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("condition never became true");
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe.skipIf(!LIVE)("MqttRelayTransport - LIVE public brokers", () => {
  it("two nodes meet over broker.emqx.io and exchange a frame", async () => {
    const url = "wss://broker.emqx.io:8084/mqtt";
    const a = collector();
    const b = collector();
    const ta = new MqttRelayTransport([url], { newSocket, announceMs: 2_000 });
    const tb = new MqttRelayTransport([url], { newSocket, announceMs: 2_000 });
    try {
      await Promise.all([ta.start(a.events), tb.start(b.events)]);
      // the room may legitimately contain REAL network nodes - assert on
      // OUR pair, not on the roster size
      await until(() => ta.links().includes(tb.selfId) && tb.links().includes(ta.selfId));
      ta.send(tb.selfId, "live-block");
      await until(() => b.log.some((e) => e.kind === "msg" && e.data === "live-block"));
    } finally {
      ta.stop();
      tb.stop();
    }
  }, 60_000);

  it("two nodes meet over broker.hivemq.com and exchange a frame", async () => {
    const url = "wss://broker.hivemq.com:8884/mqtt";
    const a = collector();
    const b = collector();
    const ta = new MqttRelayTransport([url], { newSocket, announceMs: 2_000 });
    const tb = new MqttRelayTransport([url], { newSocket, announceMs: 2_000 });
    try {
      await Promise.all([ta.start(a.events), tb.start(b.events)]);
      await until(() => ta.links().includes(tb.selfId) && tb.links().includes(ta.selfId));
      tb.send(ta.selfId, "live-headers");
      await until(() => a.log.some((e) => e.kind === "msg" && e.data === "live-headers"));
    } finally {
      ta.stop();
      tb.stop();
    }
  }, 60_000);
});
