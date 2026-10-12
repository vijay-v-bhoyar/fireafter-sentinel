// Test-only transport records. These do not emulate PostgreSQL atomicity or grants.
export const operationId = "10000000-0000-4000-8000-000000000001";
export const databaseIncidentId = "90000000-0000-4000-8000-000000000009";
export const importOperation = { operationId, requestHash: "a".repeat(64) };
export const importReceipt = { ...importOperation, incidentId: databaseIncidentId,
  auditEventId: "50000000-0000-4000-8000-000000000005", revision: "60000000-0000-4000-8000-000000000006",
  assetCount: 1, committedAt: "2026-09-14T09:00:00Z" };
