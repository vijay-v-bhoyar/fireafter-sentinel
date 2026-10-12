import { describe, expect, it } from "vitest";
import { createIncident, getIncidentBundle, importAssets } from "./fireafter-store";

function upload(content: string, fileName = "assets.csv") {
  const incident = createIncident("ventura-ca");
  return importAssets({ incidentId: incident.id, incident, fileName, content });
}

function geo(geometry: unknown, properties: unknown = { name: "County record", type: "culvert" }) {
  return JSON.stringify({ type: "FeatureCollection", features: [{ type: "Feature", geometry, properties }] });
}

const square = [[-119.3, 34.3], [-119.1, 34.3], [-119.1, 34.6], [-119.3, 34.6], [-119.3, 34.3]];

describe("FA12-C1 complete bounded import validation", () => {
  it("preserves quoted commas, escaped quotes, multiline text, BOM and CRLF", () => {
    const result = upload('\uFEFFname,type,latitude,longitude,road\r\n"Culvert, north ""A""\r\ninspection",culvert,34.4,-119.2,"Road, north"\r\n');
    expect(result.importErrors).toEqual([]);
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]).toMatchObject({ name: 'Culvert, north "A"\r\ninspection', road: "Road, north", coordinates: [-119.2, 34.4] });
  });

  it.each([
    'name,lat,lon\n"Unclosed,34.4,-119.2',
    'name,lat,lon\n"Closed"junk,34.4,-119.2',
    'name,lat,lon\nUn"quoted,34.4,-119.2',
    'name,lat,lat,lon\nA,34.4,34.5,-119.2',
    'name,lat,latitude,lon\nA,34.4,34.5,-119.2',
    'name,lat,lon,longitude\nA,34.4,-119.2,-119.3',
    'name,lat,lon\nA,34.4,-119.2,extra',
    'name,lat,lon\nA,34.4',
    'name,,lat,lon\nA,b,34.4,-119.2',
    'name,lat,lon\n',
  ])("rejects ambiguous or malformed CSV without accepted records: %s", (content) => {
    const result = upload(content);
    expect(result.assets).toEqual([]);
    expect(result.importErrors.length).toBeGreaterThan(0);
  });

  it("retains valid rows and reports the physical line after an embedded newline", () => {
    const result = upload('name,lat,lon\n"First\nrecord",34.4,-119.2\nBad,34.4,-119.2,extra\nLast,34.5,-119.3');
    expect(result.assets.map((asset) => asset.name)).toEqual(["First\nrecord", "Last"]);
    expect(result.importErrors).toHaveLength(1);
    expect(result.importErrors[0]).toMatch(/CSV row 4:/);
  });

  it.each(["", " ", "null", "0x22", "Infinity", "NaN"])("does not coerce coordinate %j", (lat) => {
    const result = upload(`name,lat,lon\nA,${lat},-119.2`);
    expect(result.assets).toEqual([]);
    expect(result.importErrors.length).toBeGreaterThan(0);
  });

  it.each([
    { type: "LineString", coordinates: [[-119.2, 34.4]] },
    { type: "LineString", coordinates: [[-119.2, 34.4], [-119.2, 34.4]] },
    { type: "LineString", coordinates: [[-119.2, 34.4], [999, 34.4]] },
    { type: "LineString", coordinates: [[-119.2, 34.4], ["-119.3", 34.5]] },
    { type: "LineString", coordinates: [[-119.2, 34.4], [-118, 34.5]] },
    { type: "Point", coordinates: [-119.2, 34.4, 20] },
    { type: "Polygon", coordinates: [square.slice(0, -1)] },
    { type: "Polygon", coordinates: [[[-119.3, 34.3], [-119.2, 34.4], [-119.1, 34.5], [-119.3, 34.3]]] },
    { type: "Polygon", coordinates: [[[-119.3, 34.3], [-119.1, 34.6], [-119.1, 34.3], [-119.3, 34.6], [-119.3, 34.3]]] },
    { type: "Polygon", coordinates: [square, [[-119.4, 34.4], [-119.35, 34.4], [-119.35, 34.5], [-119.4, 34.4]]] },
    { type: "Polygon", coordinates: [square, [[-119.3, 34.4], [-119.2, 34.4], [-119.2, 34.5], [-119.3, 34.4]]] },
    { type: "MultiPoint", coordinates: [[-119.2, 34.4]] },
    { type: "GeometryCollection", geometries: [] },
    { type: "Polygon", coordinates: [] },
  ])("rejects an invalid or unsupported whole geometry %#", (geometry) => {
    const result = upload(geo(geometry), "assets.geojson");
    expect(result.assets).toEqual([]);
    expect(result.importErrors).toHaveLength(1);
  });

  it("preserves every vertex and valid holes in supported geometry", () => {
    const geometry = { type: "Polygon", coordinates: [square, [[-119.25, 34.4], [-119.2, 34.5], [-119.15, 34.4], [-119.25, 34.4]]] };
    const result = upload(geo(geometry), "assets.geojson");
    expect(result.importErrors).toEqual([]);
    expect(result.assets[0].geometry).toEqual(geometry);
  });

  it.each(["null", "[]", "{}", '{"type":"FeatureCollection","features":null}'])("rejects invalid GeoJSON root %s", (content) => {
    const result = upload(content, "assets.geojson");
    expect(result.assets).toEqual([]);
    expect(result.importErrors.length).toBeGreaterThan(0);
  });

  it("rejects non-object properties and explicit alternate coordinate systems", () => {
    expect(upload(geo({ type: "Point", coordinates: [-119.2, 34.4] }, []), "assets.geojson").assets).toEqual([]);
    const payload = JSON.parse(geo({ type: "Point", coordinates: [-119.2, 34.4] }));
    payload.crs = { type: "name", properties: { name: "EPSG:3857" } };
    expect(upload(JSON.stringify(payload), "assets.geojson").assets).toEqual([]);
  });

  it("fails oversized input without processing a prefix as a complete import", () => {
    const result = upload("name,lat,lon\n" + "a".repeat(1_000_001));
    expect(result.assets).toEqual([]);
    expect(result.importErrors).toHaveLength(1);
  });
});

describe("FA12-C2/C3 upload confidence and empty-import semantics", () => {
  it("does not earn High confidence through upload origin", () => {
    const result = upload("name,lat,lon\nA,34.4,-119.2");
    expect(result.assets[0]).toMatchObject({ confidence: "Low" });
    expect(result.assets[0].confidenceReason).toMatch(/unverified/i);
  });

  it("does not append a successful audit event for zero accepted records", () => {
    const incident = createIncident("ventura-ca");
    const before = structuredClone(getIncidentBundle(incident.id));
    const result = importAssets({ incidentId: incident.id, fileName: "bad.csv", content: "name,lat,lon\nA,invalid,invalid" });
    expect(result.assets).toEqual([]);
    expect(result.auditEvent).toBeNull();
    expect(getIncidentBundle(incident.id).auditEvents).toEqual(before.auditEvents);
  });
});
