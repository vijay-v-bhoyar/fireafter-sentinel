import { linkPwfdfHazardsToAssets, pwfdfLinkageBasinsFromSnapshot, type PwfdfAssessment } from "./pwfdf";
import type { Asset, Incident, SourceSnapshot } from "./types";
import { projectSourceFreshness } from "./source-freshness";

export type PublishedHazard = {
  assessmentId: string;
  fireName: string;
  basinId: string;
  combinedHazard: "Low" | "Moderate" | "High";
  probabilityClass: string;
  volumeClass: string;
  assessmentDate: string;
  rainfallScenario: string;
  sourceUrl: string;
  fireIdentity: "candidate";
};

/** Recompute from validated provider polygons, not persisted asset metrics or evidence text. */
export function projectPublishedHazards(incident: Incident, assets: Asset[], sources: SourceSnapshot[], now = new Date()): Asset[] {
  const clean = assets.map(asset => {
    const copy = { ...asset };
    delete copy.publishedHazard;
    return copy;
  });
  const stored = sources.find(item => item.sourceKey === "usgs-pwfdf" && item.incidentId === incident.id);
  const source = stored && projectSourceFreshness(stored, now, stored.freshness?.maxAgeMinutes);
  if (!source || source.freshness?.state !== "current" || source.status !== "online") return clean;
  try {
    const basins = pwfdfLinkageBasinsFromSnapshot(source, incident);
    if (!basins.length) return clean;
    const assessment = source.rawPayload!.assessment as PwfdfAssessment;
    const url = new URL(source.sourceUrl ?? "");
    if (url.protocol !== "https:" || !(url.hostname === "usgs.gov" || url.hostname.endsWith(".usgs.gov") ||
      url.hostname === "www.sciencebase.gov")) return clean;
    // Redacted facilities must never be joined using their public county-centroid placeholder.
    const eligible = clean.filter(asset => asset.incidentId === incident.id && asset.sourceKey !== "critical-facility" &&
      !asset.id.startsWith("asset-redacted"));
    const linked = linkPwfdfHazardsToAssets(eligible, assessment, basins, url.href);
    const byId = new Map(basins.map(basin => [basin.id, basin]));
    const hazards = new Map<string, PublishedHazard>();
    for (const asset of linked) {
      const evidence = asset.evidence?.find(item => item.sourceKey === "usgs-pwfdf");
      const basin = byId.get(evidence?.sourceFeatureId ?? "");
      if (!basin) continue;
      hazards.set(asset.id, {
        assessmentId: assessment.fireId, fireName: assessment.fireName, basinId: basin.id,
        combinedHazard: basin.combinedHazard, probabilityClass: basin.probabilityClass,
        volumeClass: basin.volumeClass, assessmentDate: basin.assessmentDate,
        rainfallScenario: assessment.rainfallScenario ?? "Rainfall scenario unspecified; consult the official assessment",
        sourceUrl: url.href, fireIdentity: "candidate",
      });
    }
    return clean.map(asset => hazards.has(asset.id) ? { ...asset, publishedHazard: hazards.get(asset.id) } : asset);
  } catch {
    return clean;
  }
}

export function rankPublishedHazards(assets: Asset[]): Asset[] {
  const rank = { High: 3, Moderate: 2, Low: 1 };
  return assets.filter(asset => asset.publishedHazard).sort((a, b) =>
    rank[b.publishedHazard!.combinedHazard] - rank[a.publishedHazard!.combinedHazard] ||
    a.name.localeCompare(b.name, "en") || a.id.localeCompare(b.id, "en"));
}

export function inventoryEvidenceGaps(asset: Asset): string[] {
  if (asset.origin === "uploaded" || asset.localOrUploaded) return ["verified uploaded asset inventory"];
  if ((asset.type === "Bridge" && asset.sourceKey === "fhwa-nbi-bridges" ||
    asset.type === "Critical Facility" && asset.sourceKey === "tnm-structures") &&
    asset.sourceFeatureId && asset.coverageStatus === "available") return [];
  return [asset.type === "Culvert" || asset.type === "Inferred Crossing" || asset.type === "Road Crossing"
    ? "verified culvert inventory" : "verified asset inventory"];
}
