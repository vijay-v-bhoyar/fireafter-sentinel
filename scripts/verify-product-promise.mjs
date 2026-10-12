import { admitAppTarget } from "./sentinel-target.mjs";
import { inspect } from "node:util";
import { formatProductPromiseGateIssue } from "./product-promise-report.mjs";
import { fetchReleaseText, verifyReleaseIdentity } from "./release-artifact.mjs";

const baseUrl = admitAppTarget(process.env.FIREAFTER_TEST_BASE || process.env.SENTINEL_TARGET_APP_URL || "http://127.0.0.1:3020");
const testIncidentQuery =
  process.env.FIREAFTER_TEST_QUERY || "Utah";
const testIncidentId =
  process.env.FIREAFTER_TEST_INCIDENT_ID || "";

const requiredRecommendationFields = [
  "assetName",
  "assetType",
  "locationLabel",
  "recommendedAction",
  "changedSinceLastRefresh",
  "sourcesUpdatedLabel",
  "dataFreshnessHours",
  "confidenceLevel",
  "scoreBreakdown",
  "limitations",
  "evidence",
];

const requiredProductPromiseIds = [
  "data_integration",
  "geospatial_view",
  "basin_asset_linkage",
  "ranked_action_queue",
  "responsible_handling",
  "auditability",
];

const requiredCoverage = [
  {
    id: "weather",
    labels: ["weather"],
  },
  {
    id: "fire",
    labels: ["fire"],
  },
  {
    id: "infrastructure",
    labels: ["infrastructure", "roads", "bridge", "facility"],
  },
  {
    id: "terrain-hydrology",
    labels: ["terrain", "hydrology", "hydro"],
  },
  {
    id: "local-agency-data",
    labels: ["local agency", "county gis", "public works", "facility"],
  },
  {
    id: "responder-feedback",
    labels: ["responder feedback", "responder"],
  },
];

const requiredSourceKeys = ["tiger-roads", "3dhp-flowlines"];

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function hasLabelMatch(text, labels) {
  const normalized = normalizeText(text);
  return labels.some((label) => normalized.includes(label));
}

async function fetchJson(url, label) {
  try {
    return { ok: true, value: JSON.parse(await fetchReleaseText(url)) };
  } catch {
    return {
      ok: false,
      value: null,
      issue: `${label} could not be verified at the bound release origin.`,
    };
  }
}

function isNonEmpty(value) {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return true;
  return Boolean(value);
}

function addIssueIf(issues, condition, message) {
  if (!condition) issues.push(message);
}

function report(section, issues, isFinal = false) {
  const ok = issues.length === 0;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${section}`);
  if (!ok) {
    for (const item of issues) {
      console.log(`  - ${item}`);
    }
  }
  if (isFinal) {
    console.log(`\nSummary: ${ok ? "no blocking gaps" : "gaps found; review issues above"}`);
  }
  return ok;
}

function assertRecommendationFields(recs, topCount) {
  const issues = [];

  for (const rec of recs.slice(0, topCount)) {
    const id = String(rec.id || "unknown");
    for (const field of requiredRecommendationFields) {
      const value = rec[field];
      if (!isNonEmpty(value)) {
        issues.push(`recommendation ${id} missing ${field}`);
      }
      if (field === "scoreBreakdown" && value && typeof value === "object") {
        const sb = value;
        if (!isNonEmpty(sb.finalScore) || !isNonEmpty(sb.baseScore)) {
          issues.push(`recommendation ${id} scoreBreakdown incomplete`);
        }
      }
    }
  }

  return issues;
}

async function resolveIncidentId(candidateLocationId) {
  if (!candidateLocationId) return { incidentId: "", issue: null };

  const response = await fetchJson(`${baseUrl}/api/recommendations`, "Persisted incident evidence");
  if (!response.ok) return { incidentId: "", issue: response.issue };
  const incidents = (response.value.recommendations || [])
    .map((recommendation) => recommendation.incidentId)
    .filter((value, index, self) => Boolean(value) && self.indexOf(value) === index);

  const directMatch = incidents.find(
    (incidentId) =>
      incidentId === `incident-${candidateLocationId}` ||
      incidentId.endsWith(`-${candidateLocationId}`),
  );
  if (directMatch) return { incidentId: directMatch, issue: null };

  return {
    incidentId: "",
    issue: [
      `No persisted incident is discoverable from recommendations for location "${candidateLocationId}".`,
      "Create and refresh that real incident as an authenticated responder, then rerun this check.",
    ].join(" "),
  };
}

async function main() {
  const identity = await verifyReleaseIdentity(baseUrl);
  const failures = [];
  let activeIncidentId = testIncidentId?.trim();
  const hasExplicitIncident = activeIncidentId.length > 0;

  const searchResponse = await fetchJson(
    `${baseUrl}/api/search?query=${encodeURIComponent(testIncidentQuery)}`,
    "County search",
  );
  const search = searchResponse.value ?? { results: [] };
  const discoveredLocationId = (search.results || []).find(Boolean)?.id;
  const searchIssues = [];
  if (!searchResponse.ok) searchIssues.push(searchResponse.issue);
  addIssueIf(
    searchIssues,
    Boolean(discoveredLocationId),
    `search must return at least one county from query "${testIncidentQuery}"`,
  );
  if (testIncidentId) {
    addIssueIf(
      searchIssues,
      search.results?.some((result) => result.id === testIncidentId),
      `search must include configured incident id ${testIncidentId}`,
    );
  }
  report("1) Incident discoverability", searchIssues);
  if (searchIssues.length) failures.push(...searchIssues);

  if (!activeIncidentId) {
    const derivationIssues = [];
    if (!discoveredLocationId) {
      derivationIssues.push("No county result is available, so persisted incident derivation cannot begin.");
    } else {
      const derived = await resolveIncidentId(discoveredLocationId);
      activeIncidentId = derived.incidentId;
      if (derived.issue) derivationIssues.push(derived.issue);
    }
    if (derivationIssues.length) failures.push(...derivationIssues);
    report("1b) Incident derivation", derivationIssues);
  }

  if (!activeIncidentId) {
    const message = "No incident id resolved; skipping incident-bound checks.";
    failures.push(message);
    report("2) Incident-bound checks (skipped)", [message]);
    const finalOk = report(
      "6) Final demo-readiness blocker check",
      failures,
      true,
    );
    if (!finalOk) process.exitCode = 1;
    return;
  }

  const readinessResponse = await fetchJson(
    `${baseUrl}/api/readiness?incidentId=${encodeURIComponent(activeIncidentId)}`,
    "Readiness evidence",
  );
  if (!readinessResponse.ok) {
    failures.push(readinessResponse.issue);
    report("2) Product promise gates (skipped)", [readinessResponse.issue]);
    report("3) Source coverage matrix (skipped)", [readinessResponse.issue]);
    report("4) Queue-clarity fields on top recommendations (skipped)", [readinessResponse.issue]);
    report("5) Map payload availability (skipped)", [readinessResponse.issue]);
    report("6) Final demo-readiness blocker check", failures, true);
    process.exitCode = 1;
    return;
  }
  const readiness = readinessResponse.value;

  const hasNoActiveIncident = readiness?.incident?.id === "no-incident-selected" &&
    readiness?.incident?.locationId === "unselected";

  if (hasNoActiveIncident && !hasExplicitIncident) {
    const message = [
      "No persisted incident is active for this incident id.",
      "Open a real county in the UI as a signed-in user and run Refresh before running this check.",
    ].join(" ");
    failures.push(message);
    report("2) Product promise gates (skipped)", [message]);
    report("3) Source coverage matrix (skipped)", [message]);
    report(
      "4) Queue-clarity fields on top recommendations (skipped)",
      [message],
    );
    report("5) Map payload availability (skipped)", [message]);
    const finalOk = report(
      "6) Final demo-readiness blocker check",
      failures,
      true,
    );
    if (!finalOk) process.exitCode = 1;
    return;
  }

  const promiseIssues = [];
  const gateMap = new Map((readiness.productPromise || []).map((gate) => [gate.id, gate]));

  for (const id of requiredProductPromiseIds) {
    const gate = gateMap.get(id);
    addIssueIf(promiseIssues, Boolean(gate), `missing product promise gate: ${id}`);
    if (gate && gate.status !== "pass") {
      promiseIssues.push(formatProductPromiseGateIssue(gate));
    }
  }
  addIssueIf(promiseIssues, readiness.overallStatus !== "blocked", "readiness blocked");
  report("2) Product promise gates", promiseIssues);
  if (promiseIssues.length) failures.push(...promiseIssues);

  const statusResponse = await fetchJson(
    `${baseUrl}/api/sources/status?incidentId=${encodeURIComponent(activeIncidentId)}`,
    "Source coverage evidence",
  );
  const status = statusResponse.value ?? { coverageMatrix: [], sources: [] };

  const coverageIssues = [];
  if (!statusResponse.ok) coverageIssues.push(statusResponse.issue);
  const coverageLabels = (status.coverageMatrix || []).map(
    (row) => `${row.category || ""} ${row.item || ""}`.toLowerCase(),
  );

  for (const coverage of requiredCoverage) {
    const label = coverage.id;
    addIssueIf(
      coverageIssues,
      coverageLabels.some((entry) => hasLabelMatch(entry, coverage.labels)),
      `coverage matrix missing: ${label}`,
    );
  }
  const sourceKeys = new Set(
    (status.sources || []).map((source) => String(source.sourceKey)),
  );
  for (const sourceKey of requiredSourceKeys) {
    addIssueIf(
      coverageIssues,
      sourceKeys.has(sourceKey),
      `coverage does not include ${sourceKey} source key`,
    );
  }
  report("3) Source coverage matrix", coverageIssues);
  if (coverageIssues.length) failures.push(...coverageIssues);

  const recommendationsResponse = await fetchJson(
    `${baseUrl}/api/recommendations?incidentId=${encodeURIComponent(activeIncidentId)}`,
    "Recommendation evidence",
  );
  const recPayload = recommendationsResponse.value ?? { recommendations: [] };
  const recIssues = recommendationsResponse.ok
    ? assertRecommendationFields(recPayload.recommendations || [], 10)
    : [recommendationsResponse.issue];
  report("4) Queue-clarity fields on top recommendations", recIssues);
  if (recIssues.length) failures.push(...recIssues);

  const mapResponse = await fetchJson(
    `${baseUrl}/api/map/features?incidentId=${encodeURIComponent(activeIncidentId)}`,
    "Map evidence",
  );
  const mapPayload = mapResponse.value ?? {};
  const mapIssues = [];
  if (!mapResponse.ok) mapIssues.push(mapResponse.issue);
  addIssueIf(mapIssues, Object.keys(mapPayload || {}).length > 0, "map payload returned no keys");
  report("5) Map payload availability", mapIssues);
  if (mapIssues.length) failures.push(...mapIssues);

  await verifyReleaseIdentity(baseUrl, identity.releaseId);
  const finalOk = report("6) Final demo-readiness blocker check", [...failures], true);
  if (!finalOk) process.exitCode = 1;
}

main().catch((error) => {
  console.error("Audit script crashed:", error instanceof Error ? error.message : inspect(error));
  process.exitCode = 1;
});
