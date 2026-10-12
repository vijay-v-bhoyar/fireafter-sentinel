import { describe, expect, it } from "vitest";
import {
  createIncident,
  getIncidentBundle,
  importAssets,
  searchLocations,
} from "./fireafter-store";

describe("FireAfter in-memory product workflow", () => {
  it("searches counties and opens an honest unrefreshed incident shell", () => {
    const results = searchLocations("los angeles");
    expect(results[0]).toMatchObject({
      county: "Los Angeles County",
      state: "CA",
    });

    const incident = createIncident(results[0].id);
    const bundle = getIncidentBundle(incident.id);

    expect(incident.status).toBe("Monitoring");
    expect(bundle.sourceSnapshots).toEqual([]);
    expect(bundle.recommendations).toEqual([]);
  });

  it("does not generate custom fixture counties on search misses", () => {
    expect(searchLocations("imaginary ridge county")).toEqual([]);
    expect(() => createIncident("imaginary-ridge-county")).toThrow(
      "No fixture location found",
    );
  });

  it("does not import assets into a default county when the incident is unknown", () => {
    expect(() =>
      importAssets({
        incidentId: "incident-missing",
        fileName: "assets.csv",
        content: "name,type,lat,lon\nUnknown,culvert,34.481,-119.303",
      }),
    ).toThrow("Incident not found for asset import");
  });

  it("imports local assets without claiming field verification", () => {
    const incident = createIncident("ventura-ca");
    const imported = importAssets({
      incidentId: incident.id,
      fileName: "ventura-culverts.csv",
      content:
        "name,type,lat,lon,road,stream\nMatilija Creek Culvert,culvert,34.481,-119.303,SR-33,Matilija Creek",
    });

    expect(imported.assets).toHaveLength(1);
    expect(imported.assets[0]).toMatchObject({
      localOrUploaded: true,
      confidence: "Low",
      source: "ventura-culverts.csv",
    });
    expect(imported.auditEvent?.summary).toContain("Imported 1 local asset");
  });

  it("keeps repeated uploads idempotent while recording separate import attempts", () => {
    const incident = createIncident("boulder-co");
    const input = {
      incidentId: incident.id,
      fileName: "boulder-culverts.csv",
      content:
        "name,type,lat,lon,road,stream\nBoulder Creek Culvert,culvert,40.015,-105.2705,Main Street,Boulder Creek",
    };

    const first = importAssets(input);
    const second = importAssets(input);
    const matchingAssets = getIncidentBundle(incident.id).assets.filter(
      (asset) => asset.id === first.assets[0].id,
    );

    expect(second.assets[0].id).toBe(first.assets[0].id);
    expect(matchingAssets).toHaveLength(1);
    expect(second.auditEvent?.id).not.toBe(first.auditEvent?.id);
  });

  it("normalizes bridge, hospital, fire station, evacuation route, culvert, and critical facility labels", () => {
    const incident = createIncident("ventura-ca");
    const imported = importAssets({
      incidentId: incident.id,
      fileName: "ventura-public-works.csv",
      content: [
        "name,type,lat,lon,road,stream",
        "Bridge 1,bridge,34.481,-119.303,SR-33,Matilija Creek",
        "Hospital 1,hospital,34.482,-119.304,,",
        "Station 1,fire station,34.483,-119.305,,",
        "Evac Route 1,evacuation route,34.484,-119.306,SR-150,",
        "Culvert 1,culvert,34.485,-119.307,SR-33,Creek",
        "Facility 1,critical facility,34.486,-119.308,,",
      ].join("\n"),
    });

    expect(imported.assets.map((asset) => asset.type)).toEqual([
      "Bridge",
      "Critical Facility",
      "Critical Facility",
      "Evacuation Route",
      "Culvert",
      "Critical Facility",
    ]);
    expect(imported.assets[0].confidenceReason).toContain("Uploaded local asset data");
  });

  it("falls back to road names when uploaded CSV stream labels are blank", () => {
    const incident = createIncident("ventura-ca");
    const imported = importAssets({
      incidentId: incident.id,
      fileName: "utah-county-culverts.csv",
      content:
        "name,type,lat,lon,road,stream\nDiamond Fork culvert Utah County GIS OBJECTID 4,culvert,34.481,-119.303,Diamond Fork,",
    });

    expect(imported.importErrors).toEqual([]);
    expect(imported.assets[0]).toMatchObject({
      name: "Diamond Fork culvert Utah County GIS OBJECTID 4",
      type: "Culvert",
      locationLabel: "Diamond Fork",
      road: "Diamond Fork",
    });
  });

  it("rejects uploaded CSV assets outside the selected county bounds", () => {
    const incident = createIncident("ventura-ca");
    const assetCountBeforeImport = getIncidentBundle(incident.id).assets.length;
    const imported = importAssets({
      incidentId: incident.id,
      fileName: "wrong-county-assets.csv",
      content:
        "name,type,lat,lon\nGlendale Fwy Verified Crossing,culvert,34.125,-118.243",
    });

    expect(imported.assets).toEqual([]);
    expect(imported.importErrors).toEqual([
      "CSV row 2: coordinates fall outside Ventura County.",
    ]);
    expect(getIncidentBundle(incident.id).assets).toHaveLength(assetCountBeforeImport);
  });

  it("rejects uploaded GeoJSON features outside the selected county bounds", () => {
    const incident = createIncident("ventura-ca");
    const imported = importAssets({
      incidentId: incident.id,
      fileName: "wrong-county-assets.geojson",
      content: JSON.stringify({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [-118.243, 34.125] },
            properties: {
              name: "Glendale Fwy Verified Crossing",
              type: "culvert",
            },
          },
        ],
      }),
    });

    expect(imported.assets).toEqual([]);
    expect(imported.importErrors).toEqual([
      "GeoJSON feature 1: coordinates fall outside Ventura County.",
    ]);
  });
});
