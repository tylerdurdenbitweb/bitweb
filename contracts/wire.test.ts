/**
 * Wire hygiene: the message-size cap is the flood gate - anything bigger
 * than MAX_WIRE_MESSAGE_BYTES is dropped unread (null, never a throw), so a
 * hostile peer cannot make us burn memory/CPU parsing giant JSON blobs.
 */
import { describe, expect, it } from "vitest";
import { MAX_WIRE_MESSAGE_BYTES, decodeMessage, encodeMessage } from "./wire";

describe("decodeMessage size cap", () => {
  it("parses normal messages and round-trips", () => {
    const m = { type: "ping" as const, t: 123 };
    expect(decodeMessage(encodeMessage(m))).toEqual(m);
  });

  it("accepts a message just under the cap", () => {
    const pad = "x".repeat(MAX_WIRE_MESSAGE_BYTES - 40);
    const raw = `{"type":"ping","t":1,"pad":"${pad}"}`;
    expect(raw.length).toBeLessThanOrEqual(MAX_WIRE_MESSAGE_BYTES);
    const decoded = decodeMessage(raw);
    expect(decoded).not.toBeNull();
    expect(decoded!.type).toBe("ping");
  });

  it("drops a message over the cap unread", () => {
    const raw = `{"type":"ping","t":1,"pad":"${"x".repeat(MAX_WIRE_MESSAGE_BYTES)}"}`;
    expect(raw.length).toBeGreaterThan(MAX_WIRE_MESSAGE_BYTES);
    expect(decodeMessage(raw)).toBeNull();
  });

  it("still rejects non-strings and garbage under the cap", () => {
    expect(decodeMessage({ type: "ping" })).toBeNull();
    expect(decodeMessage("not json at all")).toBeNull();
    expect(decodeMessage('{"noType":true}')).toBeNull();
  });
});
