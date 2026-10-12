export type RiskLevel =
  | "Unknown"
  | "Very High"
  | "High"
  | "Medium"
  | "Low"
  | "Very Low";

export type ConfidenceLevel = "High" | "Medium" | "Low";

export type ResponderActionType = "accept" | "modify" | "reject" | "annotate";

export type CoverageStatus =
  | "available"
  | "partial"
  | "not_available"
  | "stale"
  | "error";

export type Geometry =
  | {
      type: "Point";
      coordinates: [number, number];
    }
  | {
      type: "LineString";
      coordinates: [number, number][];
    }
  | {
      type: "Polygon";
      coordinates: [number, number][][];
    };

export type Evidence = {
  sourceKey: string;
  sourceName: string;
  sourceUrl?: string;
  sourceFeatureId?: string;
  sourcePartIndex?: number;
  summary: string;
};

export type LocationCandidate = {
  id: string;
  county: string;
  state: string;
  label: string;
  centroid: [number, number];
  bbox?: [number, number, number, number];
  fips: string;
  fireWeatherZone: string;
  population: number;
  wildfireContext: string;
  boundary?: Geometry | { type: "MultiPolygon"; coordinates: [number, number][][][] };
  sourceKey?: string;
  sourceUrl?: string;
  coverageStatus?: CoverageStatus;
};

export type Incident = {
  recoveryScopeId?: string;
  id: string;
  locationId: string;
  county: string;
  state: string;
  title: string;
  code: string;
  status: "Storm Watch" | "Monitoring" | "Stale Data";
  stormWindow: string;
  rainfallForecast: string;
  lastRefresh: string;
  dataFreshness: ConfidenceLevel;
  activeAlerts: number;
  alertCoverageStatus?: "available" | "partial" | "unavailable";
  selectedFire: {
    name: string;
    acres: number;
    perimeterUpdated: string;
    source: string;
    sourceKey?: string;
    sourceUrl?: string;
    sourceFeatureId?: string;
    coverageStatus?: CoverageStatus;
  };
  locationContext?: LocationCandidate;
  fireCandidates?: Array<Incident["selectedFire"]>;
  coverageStatus?: CoverageStatus;
};

export type SourceSnapshot = {
  nativeAcquisition?: import("./sentinel/native-provenance").NativeAcquisition;
  id: string;
  incidentId: string;
  sourceKey?: string;
  sourceUrl?: string;
  sourceName: string;
  fetchedAt: string;
  sourceUpdatedAt: string;
  sourceTimeBasis?: "provider" | "retrieval" | "unknown";
  validUntil?: string;
  freshness?: {
    state: "current" | "expired" | "invalid";
    evaluatedAt: string;
    expiresAt: string | null;
    maxAgeMinutes: number;
  };
  status: "online" | "delayed" | "offline";
  stale: boolean;
  freshnessLabel: string;
  detail: string;
  coverageStatus?: CoverageStatus;
  warnings?: string[];
  rawPayload?: Record<string, unknown>;
  derivedSignals?: Record<string, unknown>;
};

export type AssetType =
  | "Road Crossing"
  | "Culvert"
  | "Bridge"
  | "Evacuation Route"
  | "Critical Facility"
  | "Inferred Crossing";

export type Asset = {
  publishedHazard?: import("./published-hazard").PublishedHazard;
  id: string;
  incidentId: string;
  name: string;
  type: AssetType;
  locationLabel: string;
  coordinates: [number, number];
  source: string;
  confidence: ConfidenceLevel;
  localOrUploaded: boolean;
  geometry?: Geometry;
  origin?: "uploaded" | "inferred" | "source";
  sourceKey?: string;
  sourceUrl?: string;
  sourceFeatureId?: string;
  sourceFeatureIds?: string[];
  coverageStatus?: CoverageStatus;
  confidenceReason?: string;
  evidence?: Evidence[];
  metrics?: {
    inferenceGeometryVersion?: string;
    slopeTerrain?: number;
    downstreamExposure?: number;
    elevationChangeMeters?: number;
    elevationSampleMeters?: number[];
    elevationSampledAt?: string;
    roadClass?: string;
    hydroDistanceMeters?: number;
    pwfdfProbabilityClass?: string;
    pwfdfVolumeClass?: string;
    pwfdfCombinedHazard?: "Low" | "Moderate" | "High";
    pwfdfAssessmentDate?: string;
    pwfdfRainfallScenario?: string;
  };
  road?: string;
  stream?: string;
};

export type ScoreBreakdown = {
  scoringVersion?: string;
  scoreBasis?: "hazard-screening" | "review-only" | "legacy-unassessed";
  rainfallThreat: number;
  burnSeverity: number;
  slopeTerrain: number;
  downstreamExposure: number;
  dataFreshness: number;
  confidenceMultiplier: number;
  baseScore: number;
  finalScore: number;
  metricStatus?: Record<
    "rainfallThreat" | "burnSeverity" | "slopeTerrain" | "downstreamExposure" | "dataFreshness",
    CoverageStatus
  >;
};

export type Recommendation = {
  inventoryRevision?: string;
  id: string;
  incidentId: string;
  assetId: string;
  assetName: string;
  assetType: AssetType;
  locationLabel: string;
  coordinates: [number, number];
  recommendedAction: string;
  finalScore: number;
  score100: number;
  riskLevel: RiskLevel;
  confidenceLevel: ConfidenceLevel;
  reasonCodes: string[];
  limitations: string[];
  changedSinceLastRefresh: string;
  sourcesUpdatedLabel: string;
  dataFreshnessHours: number;
  scoreBreakdown: ScoreBreakdown;
  evidence?: Evidence[];
  sourceSnapshotIds?: string[];
  createdAt: string;
};

export type AuditEvent = {
  id: string;
  incidentId: string;
  recommendationId?: string;
  eventType:
    | "IncidentCreated"
    | "SourcesRefreshed"
    | "RecommendationCreated"
    | "RecommendationAccepted"
    | "RecommendationModified"
    | "RecommendationRejected"
    | "RecommendationAnnotated"
    | "AssetsImported"
    | "FireContextSelected";
  actorName: string;
  createdAt: string;
  summary: string;
  payload: Record<string, unknown>;
};

export type AuditTrailStatus = "available" | "unavailable";

export type ResponderAction = {
  id: string;
  recommendationId: string;
  action: ResponderActionType;
  note: string;
  actorName: string;
  createdAt: string;
  modifiedPriority?: RiskLevel;
  recommendationSnapshot: Recommendation;
  auditEvent: AuditEvent;
};
