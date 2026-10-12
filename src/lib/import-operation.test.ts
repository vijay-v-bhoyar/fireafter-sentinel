import { describe, expect, it } from "vitest";
import { ImportReceiptSchema, readImportReceipt } from "./import-operation";

const operationId = "10000000-0000-4000-8000-000000000001";
const incidentId = "20000000-0000-4000-8000-000000000002";
const receipt = { operationId, incidentId, requestHash: "a".repeat(64),
  auditEventId: "30000000-0000-4000-8000-000000000003", revision: "40000000-0000-4000-8000-000000000004",
  assetCount: 1, committedAt: "2026-09-14T09:00:00.000Z" };
describe("FA10-R1/R3 import recovery receipt", () => {
  it("requires exact operation, incident and request binding", () => {
    expect(readImportReceipt(receipt, { operationId, incidentId, requestHash: receipt.requestHash })).toEqual(receipt);
    for (const field of ["operationId", "incidentId", "requestHash"]) {
      expect(() => readImportReceipt({ ...receipt, [field]: field === "requestHash" ? "b".repeat(64) : "50000000-0000-4000-8000-000000000005" },
        { operationId, incidentId, requestHash: receipt.requestHash })).toThrow();
    }
  });
  it.each([null, {}, { ...receipt, assetCount: 0 }, { ...receipt, content: "private GIS" }, { ...receipt, committedAt: "yesterday" }])("rejects malformed or over-disclosing receipt %j", value => {
    expect(ImportReceiptSchema.safeParse(value).success).toBe(false);
  });
});
