import type { AssetInventoryPage } from "@/lib/asset-inventory-contract";

export const inventoryUser = { id: "10000000-0000-4000-8000-000000000001", organizationId: "10000000-0000-4000-8000-000000000002", role: "analyst" as const, email: "test@example.test" };
export function inventoryPage(start = 0, limit = 25, total = 26): AssetInventoryPage {
  const count = Math.min(limit, total - start);
  return { incidentId: "county", canonicalIncidentId: "county", county: "Ventura County", state: "CA", title: "Saved inventory",
    publishedAt: "2026-10-08T00:00:00Z", revision: "10000000-0000-4000-8000-000000000003", start, limit, totalStoredAssets: total,
    nextStart: start + count < total ? start + count : null,
    items: Array.from({ length: count }, (_, index) => ({ position: start + index + 1, status: "available", asset: {
      id: `bridge-${start + index}`, name: `Bridge ${start + index + 1}`, type: "Bridge", locationLabel: "Creek", coordinates: [-119.2, 34.4],
      source: "National Bridge Inventory", confidence: "Medium", localOrUploaded: false, sourceFeatureIds: [], evidence: [],
    } })),
  };
}
