const demoAssetNames = new Set([
  "angeles crest evacuation route",
  "foothill community relief facility",
  "glendale fwy verified crossing",
  "live db test culvert",
  "topanga canyon drainage culvert",
]);

const unsafeDemoNotes = new Set([
  "inspect by 1600. coordinate with road crew. evacuate",
]);

const legacyFixtureMarkers = [
  "live db test",
  "supabase connectivity smoke test",
  "fireafter api smoke",
  "fireafter browser smoke",
  "heuristic burn-scar scoring is active",
];

const explicitMarkerKeys = new Set([
  "fireafternonoperational",
  "fireafter_non_operational",
  "nonoperational",
  "non_operational",
]);

export function isNonOperationalIncidentId(value: unknown) {
  const text = stringValue(value).toLowerCase();
  return text === "incident-custom-custom-hartford";
}

export function isNonOperationalIncidentRecord(record: Record<string, unknown>) {
  const selectedFire =
    record.selected_fire && typeof record.selected_fire === "object"
      ? (record.selected_fire as Record<string, unknown>)
      : {};
  return (
    isNonOperationalIncidentId(record.id) ||
    isNonOperationalIncidentId(selectedFire.domainIncidentId) ||
    containsLegacyFixtureMarker(record) ||
    hasExplicitNonOperationalMarker(record)
  );
}

export function isNonOperationalAssetRecord(record: Record<string, unknown>) {
  const name = stringValue(record.name).toLowerCase();
  const source = stringValue(record.source);
  const properties = record.properties;
  return (
    demoAssetNames.has(name) ||
    containsLegacyFixtureMarker(source) ||
    containsLegacyFixtureMarker(properties) ||
    hasExplicitNonOperationalMarker(record)
  );
}

export function isNonOperationalSourceSnapshotRecord(
  record: Record<string, unknown>,
) {
  // Source geometry can be large: inspect text and explicit markers in one traversal.
  return containsLegacyFixtureMarker(record, new WeakSet<object>(), true);
}

export function isNonOperationalRecommendationRecord(
  record: Record<string, unknown>,
) {
  const breakdown = record.score_breakdown;
  const assetName =
    typeof breakdown === "object" && breakdown
      ? stringValue((breakdown as Record<string, unknown>).assetName)
      : "";
  return (
    demoAssetNames.has(assetName.toLowerCase()) ||
    containsLegacyFixtureMarker(record) ||
    hasExplicitNonOperationalMarker(record)
  );
}

export function isNonOperationalResponderActionRecord(
  record: Record<string, unknown>,
) {
  const note = stringValue(record.note).toLowerCase();
  const snapshot = record.recommendation_snapshot;
  const snapshotAsset =
    typeof snapshot === "object" && snapshot
      ? stringValue((snapshot as Record<string, unknown>).assetName)
      : "";
  return (
    demoAssetNames.has(snapshotAsset.toLowerCase()) ||
    unsafeDemoNotes.has(note) ||
    containsLegacyFixtureMarker(note) ||
    containsLegacyFixtureMarker(snapshot) ||
    hasExplicitNonOperationalMarker(record)
  );
}

export function isNonOperationalAuditEventRecord(
  record: Record<string, unknown>,
) {
  const summary = stringValue(record.summary).toLowerCase();
  const payload = JSON.stringify(record.payload ?? {}).toLowerCase();
  return (
    [...demoAssetNames].some(
      (assetName) => summary.includes(assetName) || payload.includes(assetName),
    ) ||
    [...unsafeDemoNotes].some((note) => payload.includes(note)) ||
    containsLegacyFixtureMarker(summary) ||
    containsLegacyFixtureMarker(record.payload) ||
    hasExplicitNonOperationalMarker(record)
  );
}

function containsLegacyFixtureMarker(
  value: unknown,
  visited = new WeakSet<object>(),
  includeExplicitMarkers = false,
): boolean {
  if (typeof value === "string") {
    const normalized = value.toLowerCase();
    return legacyFixtureMarkers.some((marker) => normalized.includes(marker));
  }
  if (!value || typeof value !== "object") return false;
  if (visited.has(value)) return false;
  visited.add(value);
  if (includeExplicitMarkers && !Array.isArray(value)) {
    return Object.entries(value).some(([key, nested]) =>
      (explicitMarkerKeys.has(key.toLowerCase()) && nested === true) ||
      containsLegacyFixtureMarker(nested, visited, true),
    );
  }
  return Object.values(value).some((nested) =>
    containsLegacyFixtureMarker(nested, visited, includeExplicitMarkers),
  );
}

function hasExplicitNonOperationalMarker(
  value: unknown,
  visited = new WeakSet<object>(),
): boolean {
  if (!value || typeof value !== "object") return false;
  if (visited.has(value)) return false;
  visited.add(value);

  if (Array.isArray(value)) {
    return value.some((item) => hasExplicitNonOperationalMarker(item, visited));
  }

  return Object.entries(value).some(([key, nested]) => {
    if (explicitMarkerKeys.has(key.toLowerCase()) && nested === true) return true;
    return hasExplicitNonOperationalMarker(nested, visited);
  });
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}
