import { describe, expect, it } from "vitest";
import {
  linkPwfdfHazardsToAssets,
  parsePwfdfBasins,
  selectPwfdfAssessment,
} from "./pwfdf";
import type { Asset } from "./types";
import { SOURCE_LINE_GEOMETRY_VERSION } from "./source-line-geometry";

const assessmentDate = Date.parse("2026-06-20T00:00:00.000Z");

describe("USGS PWFDF contract", () => {
  it.each(["matched", "outside", "unavailable"] as const)(
    "preserves non-PWFDF metrics during %s coverage without mutating the input",
    (coverage) => {
      const assessment = selectPwfdfAssessment({
        features: [locationFeature("Ventura Canyon", "Ventura_Canyon_v2", assessmentDate)],
      }, "Ventura Canyon Fire")!;
      const basins = parsePwfdfBasins({ features: [basinFeature()] }, assessment);
      const input = asset();
      const retained = {
        inferenceGeometryVersion: SOURCE_LINE_GEOMETRY_VERSION,
        downstreamExposure: 0.8, slopeTerrain: 0.4,
        elevationChangeMeters: 28, elevationSampleMeters: [100, 128],
        roadClass: "road", hydroDistanceMeters: 0,
      };
      input.metrics = { ...retained, pwfdfProbabilityClass: "old probability",
        pwfdfVolumeClass: "old volume", pwfdfCombinedHazard: "High",
        pwfdfAssessmentDate: "2020-01-01", pwfdfRainfallScenario: "old scenario" };
      input.evidence!.push({ sourceKey: "usgs-pwfdf", sourceName: "USGS",
        sourceFeatureId: "retired-basin", summary: "Old assessment" });
      if (coverage === "outside") input.coordinates = [-119.5, 34.5];
      const before = structuredClone(input);
      const [result] = linkPwfdfHazardsToAssets([input],
        coverage === "unavailable" ? undefined : assessment,
        coverage === "unavailable" ? [] : basins);
      expect(result.metrics).toMatchObject(retained);
      expect(input).toEqual(before);
      expect(result.evidence).not.toContainEqual(expect.objectContaining({ sourceFeatureId: "retired-basin" }));
      if (coverage === "matched") {
        expect(result.metrics).toMatchObject({ pwfdfProbabilityClass: "60-80%",
          pwfdfVolumeClass: "10,000-100,000", pwfdfCombinedHazard: "High",
          pwfdfAssessmentDate: assessment.assessmentDate, pwfdfRainfallScenario: assessment.rainfallScenario });
      } else {
        expect(result.metrics).toEqual(retained);
        expect(result.evidence).toEqual(before.evidence!.filter((item) => item.sourceKey !== "usgs-pwfdf"));
      }
    },
  );

  it("selects the latest normalized-name revision only within one provider fire ID", () => {
    const assessment = selectPwfdfAssessment({
      features: [
        locationFeature("Ventura Canyon", "Ventura_Canyon_v2", assessmentDate - 1000),
        locationFeature("Ventura Canyon", "Ventura_Canyon_v2", assessmentDate),
        locationFeature("Ventura", "Wrong_Fire", assessmentDate + 1000),
      ],
    }, "Ventura Canyon Fire");

    expect(assessment).toMatchObject({
      fireName: "Ventura Canyon",
      fireId: "Ventura_Canyon_v2",
      assessmentDate: "2026-06-20T00:00:00.000Z",
    });
  });

  it("does not use a partial fire-name match", () => {
    expect(selectPwfdfAssessment({
      features: [locationFeature("Ventura", "Ventura_v1", assessmentDate)],
    }, "Ventura Canyon Fire")).toBeNull();
  });

  it("parses complete combined-hazard basin polygons", () => {
    const assessment = selectPwfdfAssessment({
      features: [locationFeature("Ventura Canyon", "Ventura_Canyon_v2", assessmentDate)],
    }, "Ventura Canyon Fire");
    if (!assessment) throw new Error("Expected fixture assessment");

    expect(parsePwfdfBasins({ features: [basinFeature()] }, assessment)).toEqual([
      expect.objectContaining({
        id: "pwfdf-Ventura_Canyon_v2-42",
        combinedHazard: "High",
        probabilityClass: "60-80%",
        volumeClass: "10,000-100,000",
      }),
    ]);
  });

  it("fails closed on transfer truncation and malformed hazard geometry", () => {
    const assessment = selectPwfdfAssessment({
      features: [locationFeature("Ventura Canyon", "Ventura_Canyon_v2", assessmentDate)],
    }, "Ventura Canyon Fire");
    if (!assessment) throw new Error("Expected fixture assessment");

    expect(() => parsePwfdfBasins({ exceededTransferLimit: true, features: [] }, assessment))
      .toThrow(/more than 500 basin polygons/);
    expect(() => parsePwfdfBasins({
      features: [{ ...basinFeature(), geometry: { rings: [[[-119.4, 34.4]]] } }],
    }, assessment)).toThrow(/valid polygon geometry/);
  });

  it("links an asset to the containing basin and removes stale links when coverage disappears", () => {
    const assessment = selectPwfdfAssessment({
      features: [locationFeature("Ventura Canyon", "Ventura_Canyon_v2", assessmentDate)],
    }, "Ventura Canyon Fire");
    if (!assessment) throw new Error("Expected fixture assessment");
    const basins = parsePwfdfBasins({ features: [basinFeature()] }, assessment);
    const [linked] = linkPwfdfHazardsToAssets(
      [asset()],
      assessment,
      basins,
      "https://earthquake.usgs.gov/arcgis/rest/services/ls/pwfdf/MapServer/4",
    );

    expect(linked.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceKey: "usgs-pwfdf",
        sourceFeatureId: "pwfdf-Ventura_Canyon_v2-42",
      }),
    ]));
    expect(linked.metrics).toMatchObject({
      pwfdfCombinedHazard: "High",
      pwfdfProbabilityClass: "60-80%",
    });

    const [cleaned] = linkPwfdfHazardsToAssets([linked], undefined, []);
    expect(cleaned.evidence?.some((item) => item.sourceKey === "usgs-pwfdf")).toBe(false);
    expect(cleaned.metrics?.pwfdfCombinedHazard).toBeUndefined();
  });
});

function locationFeature(fire: string, fireId: string, date: number) {
  return {
    attributes: {
      fire,
      Fire_ID: fireId,
      status: "Complete",
      Rainfall: "15-minute, 24 mm/h design storm",
      start_date: date - 86_400_000,
      assessment_date: date,
      ScienceBaseURL: "https://www.sciencebase.gov/catalog/item/example",
    },
  };
}

function basinFeature() {
  return {
    attributes: {
      OBJECTID: 42,
      BP_Legend: "60-80%",
      BV_Legend: "10,000-100,000",
      BCH_Legend: "High",
      fire_id: "Ventura_Canyon_v2",
      assessment_date: assessmentDate,
      version: "1.0",
    },
    geometry: {
      rings: [[
        [-119.4, 34.4],
        [-119.2, 34.4],
        [-119.2, 34.6],
        [-119.4, 34.6],
        [-119.4, 34.4],
      ]],
    },
  };
}

function asset(): Asset {
  return {
    id: "asset-1",
    incidentId: "incident-1",
    name: "SR-33 crossing",
    type: "Road Crossing",
    locationLabel: "Matilija Creek",
    coordinates: [-119.3, 34.5],
    source: "TIGERweb",
    confidence: "High",
    localOrUploaded: false,
    evidence: [{ sourceKey: "tiger-roads", sourceName: "TIGERweb", summary: "Road." }],
    metrics: { downstreamExposure: 0.8 },
  };
}
