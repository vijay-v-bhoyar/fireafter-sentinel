import type {
  Asset,
  AuditEvent,
  Incident,
  Recommendation,
  ResponderAction,
  SourceSnapshot,
} from "./types";

export type SourceCoverageStatus =
  | "Live"
  | "Partial / Proxy"
  | "Upload Required"
  | "Delayed"
  | "Not Available";

export type SourceCoverageItem = {
  category: string;
  item: string;
  status: SourceCoverageStatus;
  sourceKeys: string[];
  evidence: string;
  limitation: string;
  nextAction: string;
};

export type SourceCoverageInput = {
  incident: Incident;
  assets: Asset[];
  sourceSnapshots: SourceSnapshot[];
  recommendations: Recommendation[];
  actions: ResponderAction[];
  auditEvents: AuditEvent[];
};

export function buildSourceCoverageMatrix(
  input: SourceCoverageInput,
): SourceCoverageItem[] {
  const uploadedAssets = input.assets.filter((asset) => asset.localOrUploaded);
  const inferredCrossings = input.assets.filter((asset) =>
    ["Inferred Crossing", "Road Crossing"].includes(asset.type),
  );
  const bridges = input.assets.filter((asset) => asset.type === "Bridge");
  const criticalFacilities = input.assets.filter(
    (asset) => asset.type === "Critical Facility",
  );
  const responderDecisions = input.actions.filter((action) =>
    ["accept", "modify", "reject", "annotate"].includes(action.action),
  );

  return [
    sourceBackedItem(input, {
      category: "Weather",
      item: "NOAA/NWS rainfall forecasts, alerts, and warnings",
      sourceKeys: ["nws"],
      absentStatus: "Not Available",
      absentLimitation: "NWS forecast and alert feed has not been refreshed for this incident.",
      nextAction: "Run Refresh and verify the NWS source row is live.",
    }),
    sourceBackedItem(input, {
      category: "Weather",
      item: "NWS latest weather observations",
      sourceKeys: ["nws-observations"],
      absentStatus: "Not Available",
      absentLimitation: "Latest station observations are not loaded yet.",
      nextAction: "Refresh observations from the nearest NWS station list.",
    }),
    sourceBackedItem(input, {
      category: "Fire",
      item: "Current fire perimeter and burn-area context",
      sourceKeys: ["wfigs"],
      absentStatus: "Not Available",
      absentLimitation: "No current WFIGS perimeter source is loaded for this incident.",
      nextAction: "Run current WFIGS perimeter refresh and explain no-fire coverage when true.",
    }),
    sourceBackedItem(input, {
      category: "Fire",
      item: "Recent fire perimeter fallback",
      sourceKeys: ["wfigs-ytd"],
      absentStatus: "Delayed",
      absentLimitation: "Year-to-date WFIGS fallback has not returned recent perimeter context.",
      nextAction: "Refresh the current-year WFIGS perimeter service.",
    }),
    sourceBackedItem(input, {
      category: "Fire",
      item: "NASA FIRMS active fire/hotspot context",
      sourceKeys: ["firms"],
      absentStatus: "Delayed",
      absentLimitation: "FIRMS hotspot context is missing or waiting on a MAP_KEY/source response.",
      noCoverageLimitation:
        "FIRMS was reached and returned no recent hotspots for this county window.",
      noCoverageNextAction:
        "Monitor FIRMS on the next refresh and keep the no-hotspot finding visible in source evidence.",
      nextAction: "Verify NASA_FIRMS_MAP_KEY and rerun Refresh.",
    }),
    sourceBackedItem(input, {
      category: "Satellite Burn Severity",
      item: "MTBS NBR/dNBR burn-severity products",
      sourceKeys: ["mtbs-burn-severity"],
      absentStatus: "Delayed",
      onlineNoCoverageStatus: "Delayed",
      absentLimitation:
        "MTBS burn-severity products are often delayed for current fires; absence is not replaced with synthetic dNBR.",
      nextAction: "The configured MTBS layer supplies boundaries only. Integrate validated, selected-fire-linked severity raster/statistics before using burn severity; do not substitute acreage or hotspots.",
    }),
    sourceBackedItem(input, {
      category: "Post-Wildfire Hazard",
      item: "USGS PWFDF combined-hazard basin polygons",
      sourceKeys: ["usgs-pwfdf"],
      absentStatus: "Not Available",
      absentLimitation:
        "No validated USGS PWFDF combined-hazard basin layer is loaded for the selected fire.",
      availableLimitation:
        "PWFDF classes are screening-level estimates for published design rainfall; basin-to-asset linkage still requires exact point containment and field validation.",
      noCoverageLimitation:
        "USGS PWFDF was reached but returned no validated combined-hazard basins for the selected fire.",
      noCoverageNextAction:
        "Select a published fire with a matching PWFDF assessment, then run Refresh.",
      nextAction:
        "Select a currently published WFIGS fire with a matching PWFDF assessment, then run Refresh.",
    }),
    sourceBackedItem(input, {
      category: "Terrain & Hydrology",
      item: "DEM/elevation-derived slope proxy",
      sourceKeys: ["usgs-epqs"],
      absentStatus: "Not Available",
      absentLimitation: "USGS elevation sampling is not loaded for this incident.",
      availableLimitation: "A county-centroid sample is elevation context only. Asset slope requires separate paired samples; neither is a full hydrologic model.",
      nextAction: "Refresh USGS elevation sampling and verify each asset's paired slope evidence separately.",
    }),
    sourceBackedItem(input, {
      category: "Terrain & Hydrology",
      item: "Drainage, flowlines, and watershed context",
      sourceKeys: ["3dhp-flowlines"],
      forcedAvailableStatus: "Partial / Proxy",
      absentStatus: "Not Available",
      absentLimitation:
        "USGS 3DHP flowlines are not loaded; watershed/catchment delineation is still a Phase 2 layer.",
      availableLimitation:
        "3DHP flowlines support drainage screening; full watershed/catchment delineation is not loaded yet.",
      nextAction: "Use 3DHP for drainage proxy and add catchment/watershed layers when available.",
    }),
    sourceBackedItem(input, {
      category: "Infrastructure",
      item: "Roads and inferred road/stream crossings",
      sourceKeys: ["tiger-roads", "3dhp-flowlines"],
      assetCount: inferredCrossings.length,
      absentStatus: "Not Available",
      absentLimitation: "Public road/hydro geometry has not produced crossing candidates.",
      nextAction: "Load source-backed road and flowline layers before building ranked road-crossing recommendations.",
    }),
    sourceBackedItem(input, {
      category: "Infrastructure",
      item: "FHWA/BTS National Bridge Inventory bridges",
      sourceKeys: ["fhwa-nbi-bridges"],
      assetCount: bridges.length,
      absentStatus: "Not Available",
      absentLimitation: "NBI bridge candidates are not loaded for this county.",
      nextAction: "Refresh the FHWA/BTS NBI bridge source or upload local bridge inventory.",
    }),
    sourceBackedItem(input, {
      category: "Infrastructure",
      item: "Hospitals, fire/EMS stations, and critical facilities",
      sourceKeys: ["tnm-structures"],
      assetCount: criticalFacilities.length,
      absentStatus: "Not Available",
      absentLimitation: "Public critical-facility candidates are not loaded.",
      nextAction: "Refresh USGS TNM Structures or upload county critical-facility files.",
    }),
    {
      category: "Local Agency Data",
      item: "County GIS/public works culverts and evacuation routes",
      status: uploadedAssets.length > 0 ? "Live" : "Upload Required",
      sourceKeys: ["local-upload"],
      evidence:
        uploadedAssets.length > 0
          ? `${uploadedAssets.length} uploaded local asset${uploadedAssets.length === 1 ? "" : "s"} available.`
          : "No uploaded county GIS/public works assets are loaded.",
      limitation:
        uploadedAssets.length > 0
          ? "Uploaded records remain unverified with Low confidence. Format checks do not establish field accuracy or condition; authorized review and field validation are still required."
          : "National culvert and evacuation-route coverage is not reliable enough for a public-source-only claim.",
      nextAction:
        uploadedAssets.length > 0
          ? "Keep uploaded files current as local inventories change."
          : "Upload CSV/GeoJSON culverts, evacuation routes, or public works assets when available.",
    },
    {
      category: "Responder Feedback",
      item: "Responder decisions and audit feedback",
      status: responderDecisions.length > 0 && input.auditEvents.length > 0 ? "Live" : "Not Available",
      sourceKeys: ["responder-actions", "audit-events"],
      evidence:
        responderDecisions.length > 0 && input.auditEvents.length > 0
          ? `${responderDecisions.length} responder decision${responderDecisions.length === 1 ? "" : "s"} and ${input.auditEvents.length} audit event${input.auditEvents.length === 1 ? "" : "s"} recorded.`
          : "No responder decision has been recorded for this incident yet.",
      limitation:
        "Responder feedback is human-in-the-loop evidence; FireAfter does not automate emergency orders.",
      nextAction:
        responderDecisions.length > 0 && input.auditEvents.length > 0
          ? "Review History & Audit for immutable action snapshots."
          : "Accept, modify, reject, or annotate a recommendation after review.",
    },
  ];
}

function sourceBackedItem(
  input: SourceCoverageInput,
  config: {
    category: string;
    item: string;
    sourceKeys: string[];
    absentStatus: SourceCoverageStatus;
    absentLimitation: string;
    nextAction: string;
    forcedAvailableStatus?: SourceCoverageStatus;
    availableLimitation?: string;
    noCoverageLimitation?: string;
    noCoverageNextAction?: string;
    onlineNoCoverageStatus?: SourceCoverageStatus;
    assetCount?: number;
  },
): SourceCoverageItem {
  const sources = input.sourceSnapshots.filter((source) =>
    config.sourceKeys.includes(source.sourceKey ?? ""),
  );
  const status = statusFromSources(sources, config);
  const capacityLimited = sources.some(source => source.coverageStatus === "error" && source.rawPayload?.reason === "limit_exceeded");
  const hasNoCoverage = status === "Not Available" && sources.length > 0 &&
    sources.every((source) => source.status === "online");
  const assetEvidence =
    config.assetCount !== undefined
      ? `${config.assetCount} asset candidate${config.assetCount === 1 ? "" : "s"} linked.`
      : "";
  const sourceEvidence =
    sources.length > 0
      ? sources
          .map((source) => {
            const basinCount = numberValue(source.rawPayload?.basinCount);
            const featureCount = numberValue(source.rawPayload?.featureCount);
            const count = basinCount !== undefined
              ? `${basinCount} basin polygon${basinCount === 1 ? "" : "s"}`
              : featureCount !== undefined
                ? `${featureCount} feature${featureCount === 1 ? "" : "s"}`
                : undefined;
            return `${source.sourceName}: ${count ?? source.detail}`;
          })
          .join(" ")
      : "No matching source snapshot is present.";

  return {
    category: config.category,
    item: config.item,
    status,
    sourceKeys: config.sourceKeys,
    evidence: [assetEvidence, sourceEvidence].filter(Boolean).join(" "),
    limitation:
      capacityLimited
        ? "A required source inventory exceeds this deployment's capacity. No partial inventory was accepted; missing geometry does not mean no hazard."
      : status === "Live" || status === "Partial / Proxy"
        ? config.availableLimitation ?? limitationFromSources(sources)
        : hasNoCoverage
          ? config.noCoverageLimitation ?? noCoverageLimitationFromSources(sources)
        : sources.length > 0
          ? `Saved source evidence is limited or out of date. Refresh and review the source details before use. ${noCoverageLimitationFromSources(sources)}`
        : config.absentLimitation,
    nextAction:
      capacityLimited
        ? "Ask an operator to provision a capacity-reviewed complete-source ingestion path. Repeating Refresh will not reduce the inventory."
      : status === "Live" || status === "Partial / Proxy"
        ? "Monitor freshness and source warnings during each refresh."
        : hasNoCoverage
          ? config.noCoverageNextAction ?? "Monitor this source on the next refresh and explain the no-coverage result."
        : config.nextAction,
  };
}

function statusFromSources(
  sources: SourceSnapshot[],
  config: {
    absentStatus: SourceCoverageStatus;
    forcedAvailableStatus?: SourceCoverageStatus;
    onlineNoCoverageStatus?: SourceCoverageStatus;
    assetCount?: number;
    sourceKeys: string[];
  },
): SourceCoverageStatus {
  if (sources.length === 0) return config.absentStatus;
  const available = sources.filter((source) =>
    source.status === "online" &&
    !source.stale &&
    (source.coverageStatus === "available" || source.coverageStatus === "partial"),
  );
  const hasAvailable = available.length > 0;
  if (hasAvailable && config.assetCount !== undefined && config.assetCount === 0) {
    return "Partial / Proxy";
  }
  if (hasAvailable) {
    const complete = config.sourceKeys.every((key) => available.some((source) =>
      source.sourceKey === key && source.coverageStatus === "available"));
    return complete ? config.forcedAvailableStatus ?? "Live" : "Partial / Proxy";
  }
  if (sources.some((source) => source.status === "delayed" ||
    (source.stale && source.coverageStatus !== "not_available"))) return "Delayed";
  if (sources.some((source) => source.status === "online")) {
    return config.onlineNoCoverageStatus ?? "Not Available";
  }
  if (sources.some((source) => source.status === "delayed" || source.stale)) return "Delayed";
  if (sources.some((source) => source.coverageStatus === "partial")) return "Partial / Proxy";
  return config.absentStatus;
}

function limitationFromSources(sources: SourceSnapshot[]) {
  const warnings = [...new Set(sources.flatMap((source) => source.warnings ?? []))];
  if (warnings.length > 0) return warnings.slice(0, 2).join(" ");
  return "Coverage is source-backed and still requires responder review before action.";
}

function noCoverageLimitationFromSources(sources: SourceSnapshot[]) {
  const warnings = sources.flatMap((source) => source.warnings ?? []);
  if (warnings.length > 0) return warnings.slice(0, 2).join(" ");
  const details = sources
    .map((source) => source.detail)
    .filter((detail) => detail.trim().length > 0);
  if (details.length > 0) return details.slice(0, 2).join(" ");
  return "The source was reached, but it returned no matching coverage for this incident.";
}

function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

