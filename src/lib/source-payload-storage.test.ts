import { describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import { packSourcePayload, unpackSourcePayload } from "./source-payload-storage";

describe("lossless bounded source payload storage", () => {
  const payload = { geometryVersion: "test-version", features: Array.from({ length: 6000 }, (_, id) => ({ id, paths: [[[-120.123456789, 48.123456789], [-120.223456789, 48.223456789]]] })) };
  it("preserves legacy small objects and every coordinate in a large round trip", () => {
    expect(packSourcePayload({ available: false })).toEqual({ rawPayload: { available: false } });
    expect(unpackSourcePayload({ rawPayload: { available: false } })).toEqual({ available: false });
    const packed = packSourcePayload(payload);
    expect(packed.rawPayloadEncoding).toBe("gzip-json-v1");
    expect(JSON.stringify(packed).length).toBeLessThan(JSON.stringify(payload).length / 5);
    expect(unpackSourcePayload(packed)).toEqual(payload);
  });
  it.each([
    { rawPayloadEncoding: "unknown" }, { rawPayloadGzip: "malformed!" }, { rawPayloadBytes: 1 },
    { rawPayloadHash: "0".repeat(64) }, { rawPayloadBytes: 65 * 1024 * 1024 },
    { rawPayloadGzip: gzipSync(Buffer.from("[]")).toString("base64") },
  ])("rejects malformed or tampered evidence rather than returning empty coverage: %j", change => {
    expect(() => unpackSourcePayload({ ...packSourcePayload(payload), ...change })).toThrow();
  });
  it("enforces the aggregate decoded-source budget", () => {
    const packed = packSourcePayload(payload);
    const budget = { remaining: packed.rawPayloadBytes as number };
    expect(unpackSourcePayload(packed, budget)).toEqual(payload);
    expect(budget.remaining).toBe(0);
    expect(() => unpackSourcePayload(packed, budget)).toThrow();
  });
});
