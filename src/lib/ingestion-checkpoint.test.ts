import { expect, it } from "vitest";
import { encodeCheckpoint, decodeCheckpoint } from "./ingestion-checkpoint";

it.each([true, false])("round trips a large Unicode checkpoint (compressed=%s)", compress => {
  const original = { assets: Array.from({ length: 5665 }, (_, index) => ({ id: index, name: "County \u00e9\ud83c\udf32", evidence: "x".repeat(600) })) };
  const encoded = encodeCheckpoint(original, compress);
  const parts = encoded.parts.map((value, part) => ({ part, value }));
  expect(decodeCheckpoint(encoded.manifest, parts)).toEqual(original);
  for (const part of parts) expect(Buffer.byteLength(JSON.stringify(part.value))).toBeLessThan(786432);
});
it("rejects missing, reordered and tampered chunks", () => {
  const { manifest, parts } = encodeCheckpoint({ value: "x".repeat(900000) }, false);
  const rows = parts.map((value, part) => ({ part, value }));
  expect(() => decodeCheckpoint(manifest, rows.slice(1))).toThrow();
  expect(() => decodeCheckpoint(manifest, [...rows].reverse())).toThrow();
  expect(() => decodeCheckpoint({ ...manifest, hash: "bad" }, rows)).toThrow();
  expect(() => decodeCheckpoint({ ...manifest, bytes: 1024 ** 3 }, rows)).toThrow();
});
