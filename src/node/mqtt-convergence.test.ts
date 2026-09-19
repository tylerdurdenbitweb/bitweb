/**
 * THE cross-device acceptance test, in CI: two FULLY independent node
 * instances (own module graph, own storage - the analogue of two phones)
 * with WebRTC disabled and NO same-browser mesh: the ONLY path between
 * them is the MQTT room transport over a real broker (aedes). They must
 * handshake through the room, then CONVERGE ON ONE CHAIN: A mines, B
 * adopts, identical tips. This is the regression net for "her cihaz kendi
 * zincirini kaziyor" - the split-brain bug.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { hashMeetsTarget } from "@contracts/protocol";
import http from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer, createWebSocketStream } from "ws";
import { Aedes } from "aedes";
import { walletFromPrivHex } from "@/lib/bitweb";
import { MemoryStorage } from "./storage";
import type { MqttSocketLike } from "./mqtt";

const w1 = walletFromPrivHex("01".repeat(32))!;

async function until(fn: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 100));
  }
}

// deterministic preimages on a fresh chain paying w1 (same as p2p.test.ts)
const BAKED: Record<string, { nonce: number; hash: string }> = {
  "BTWB1|1|c56c7b1e6bd77fb1cce41b3cb76d05a54c3bfd719db2942066daddf3a52352c3|d62b9190107cb799394ff51e25c12ff58a23fa360f6b632805bd0f4268d6ecc8|1787443201|": { nonce: 175577, hash: "000000f11f737b8028d03070c7decc69e1cf199d3c532ea6cf27895396333a9c" },
};

function powSearch(prefixAscii: string, target: string): { nonce: number; hash: string } {
  const baked = BAKED[prefixAscii];
  if (baked) return baked;
  const prefix = utf8ToBytes(prefixAscii);
  for (let nonce = 0; nonce < 2 ** 31; nonce++) {
    const d1 = sha256.create().update(prefix).update(utf8ToBytes(String(nonce))).digest();
    const hash = bytesToHex(sha256(d1));
    if (hashMeetsTarget(hash, target)) {
      console.log(`BAKE: "${prefixAscii}": { nonce: ${nonce}, hash: "${hash}" },`);
      return { nonce, hash };
    }
  }
  throw new Error("nonce space exhausted");
}

function nodeSocket(url: string): MqttSocketLike {
  const ws = new WebSocket(url, "mqtt");
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

const FAST = {
  announceMs: 150,
  ttlMs: 3_000,
  sweepMs: 250,
  reconnectLadderMs: [100, 100],
  keepAliveSec: 2,
  connectTimeoutMs: 2_000,
};

type Booted = Awaited<ReturnType<(typeof import("./client"))["bootNode"]>>;

let server: http.Server;
let aedes: Aedes;
let brokerUrl: string;
let nodeA: Booted | undefined;
let nodeB: Booted | undefined;

async function freshMqttNode(): Promise<Booted> {
  vi.resetModules();
  const client = await import("./client");
  const { MqttRelayTransport } = await import("./mqtt");
  return client.bootNode({
    storage: new MemoryStorage(),
    transports: [new MqttRelayTransport([brokerUrl], { ...FAST, newSocket: nodeSocket })],
    webRtc: false,
  });
}

async function mineOne(node: Booted, miner: string): Promise<void> {
  const tpl = await node.template(miner);
  const ts = tpl.minTimestamp;
  const { nonce } = powSearch(
    `BTWB1|${tpl.height}|${tpl.prevHash}|${tpl.merkleRoot}|${ts}|`,
    tpl.target,
  );
  await node.submitBlock(tpl.templateId, ts, nonce);
}

afterAll(async () => {
  nodeA?.stop();
  nodeB?.stop();
  if (aedes) {
    await new Promise<void>((res) => {
      aedes.close(() => res());
    });
  }
  if (server) await new Promise((res) => server.close(res));
});

describe("two full nodes over ONE MQTT room (no webrtc, no tab mesh)", () => {
  it("they meet, handshake, and converge on one chain with identical tips", async () => {
    aedes = await Aedes.createBroker();
    server = http.createServer();
    const wss = new WebSocketServer({ server });
    wss.on("connection", (ws) => {
      aedes.handle(createWebSocketStream(ws));
    });
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    brokerUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/mqtt`;

    nodeA = await freshMqttNode();
    nodeB = await freshMqttNode();

    // discovery: each node sees exactly the other over the mqtt transport
    await until(
      () =>
        nodeA!.peers().some((p) => p.transport === "mqtt") &&
        nodeB!.peers().some((p) => p.transport === "mqtt"),
      20_000,
    );

    // the sybil gate must actually pass on BOTH sides: an unverified link
    // dies at the challenge deadline (30s) - mine a block and confirm the
    // peer book is still alive well past any handshake hiccup
    await mineOne(nodeA, w1.address);
    const infoA = await nodeA.info();
    expect(infoA.height).toBe(1);

    // convergence: B adopts A's block and arrives at the IDENTICAL tip
    await until(
      async () => {
        const b = await nodeB!.info();
        return b.height === 1 && b.tipHash === infoA.tipHash;
      },
      30_000,
    );
    const infoB = await nodeB.info();
    expect(infoB.tipHash).toBe(infoA.tipHash);

    // and the link that carried it all is still up
    expect(nodeA.peers().some((p) => p.transport === "mqtt")).toBe(true);
    expect(nodeB.peers().some((p) => p.transport === "mqtt")).toBe(true);
  }, 120_000);
});
