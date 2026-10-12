import { describe, expect, it } from "vitest";
import { createInventoryManifest, parseInventoryManifest, selectInventoryRows } from "./inventory-manifest";

const id = "11111111-1111-4111-8111-111111111111";
const ids = { assetIds: [id], recommendationIds: [], sourceSnapshotIds: [] };

describe("current inventory manifest", () => {
  it("accepts only an absent field as legacy, and keeps an empty current inventory valid", () => {
    expect(parseInventoryManifest(undefined)).toBeNull();
    const manifest = createInventoryManifest({ assetIds: [], recommendationIds: [], sourceSnapshotIds: [] });
    expect(parseInventoryManifest(JSON.parse(JSON.stringify(manifest)))).toEqual(manifest);
    expect(selectInventoryRows([], [], "incident")).toEqual([]);
  });

  it.each([null, false, [], "v1", {}, { version: "future" }, { revision: "not-a-uuid" },
    { assetIds: null }, { recommendationIds: {} }, { sourceSnapshotIds: ["invalid"] },
    { assetIds: [id, id] }, { assetIds: [null] },
  ])("fails closed on invalid manifest input %j", (change) => {
    const valid = createInventoryManifest(ids);
    const input = change && !Array.isArray(change) && typeof change === "object" ? { ...valid, ...change } : change;
    if (change && typeof change === "object" && Object.keys(change).length === 0 && !Array.isArray(change)) {
      expect(() => parseInventoryManifest({})).toThrow(/inventory/i);
    } else {
      expect(() => parseInventoryManifest(input)).toThrow(/inventory/i);
    }
  });

  it("rejects over-budget and case-insensitive duplicate membership", () => {
    const valid = createInventoryManifest(ids);
    expect(() => parseInventoryManifest({ ...valid, assetIds: Array(100_001).fill(id) })).toThrow(/inventory/i);
    const letters = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    expect(() => parseInventoryManifest({ ...valid, assetIds: [letters, letters.toUpperCase()] })).toThrow(/inventory/i);
  });

  it("does not silently filter malformed row identities", () => {
    expect(() => selectInventoryRows([{ id: null as unknown as string, incident_id: "incident" }], [id], "incident")).toThrow(/inventory/i);
  });
});
