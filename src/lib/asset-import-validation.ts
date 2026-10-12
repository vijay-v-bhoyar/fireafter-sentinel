import { coordinateInIncidentBounds, coordinateInPolygon } from "./geo";
import { CountyScopeError, prepareCountyScope } from "./county-scope";
import { InventoryCapacityError } from "./inventory-error";
import { ASSET_IMPORT_CONTENT_CHARS } from "./request-limits";
import type { Asset, Geometry, Incident } from "./types";

export const UPLOAD_CONFIDENCE_REASON = "Uploaded local asset data is unverified. Format checks do not establish field accuracy or asset condition.";
export const IMPORT_LIMITS = { records: 5000, fields: 64, fieldChars: 4096, vertices: 20000, comparisons: 200000 } as const;
type Position = [number, number];
type Bounds = Pick<Incident, "county" | "locationContext">;
export type ImportValidationBudget = { vertices: number; comparisons: number };
type ParsedRecord = { properties: Record<string, unknown>; geometry: Geometry; coordinates: Position; label: string };
class InvalidImport extends Error {}
class ImportBudgetExceeded extends InvalidImport {}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function parseAssetUpload(input: { content: string; fileName: string }, incident: Bounds) {
  const assets: ParsedRecord[] = [];
  const errors: string[] = [];
  const budget: ImportValidationBudget = { vertices: 0, comparisons: 0 };
  let rejected = 0;
  const reject = (message: string) => { rejected++; if (errors.length < 100) errors.push(message); };
  try {
    const scope = prepareCountyScope(incident);
    if (input.content.length > ASSET_IMPORT_CONTENT_CHARS) throw new ImportBudgetExceeded("Import exceeds the content limit; split the file before retrying.");
    if (!input.fileName.trim() || input.fileName.length > 255) throw new InvalidImport("Import filename must contain 1-255 characters.");
    const content = input.content.replace(/^\uFEFF/, "");
    if (/\.(?:geojson|json)$/i.test(input.fileName) || /^\s*[\[{]/.test(content)) {
      let payload: unknown;
      try { payload = JSON.parse(content); } catch { throw new InvalidImport("GeoJSON is not valid JSON."); }
      if (!record(payload) || payload.type !== "FeatureCollection" || !Array.isArray(payload.features)) throw new InvalidImport("GeoJSON import must be a FeatureCollection.");
      if ("crs" in payload) throw new InvalidImport("GeoJSON must use WGS84 longitude/latitude without a custom CRS; reproject before importing.");
      if (payload.features.length > IMPORT_LIMITS.records) throw new ImportBudgetExceeded("Import record limit exceeded; split the file before retrying.");
      payload.features.forEach((feature: unknown, index: number) => {
        const label = `GeoJSON feature ${index + 1}`;
        try {
          if (!record(feature) || feature.type !== "Feature" || "crs" in feature) throw new InvalidImport("expected a Feature without a custom CRS.");
          if (feature.properties !== null && !record(feature.properties)) throw new InvalidImport("properties must be an object or null.");
          const properties = feature.properties ?? {};
          validateProperties(properties as Record<string, unknown>);
          const geometry = validateImportGeometry(feature.geometry, incident, budget);
          assets.push({ properties: properties as Record<string, unknown>, geometry, coordinates: firstPosition(geometry), label });
        } catch (error) {
          if (error instanceof ImportBudgetExceeded) throw error;
          if (!(error instanceof InvalidImport)) throw error;
          reject(`${label}: ${error.message}`);
        }
      });
    } else {
      const [header, ...rows] = csvRecords(content);
      if (!header) throw new InvalidImport("CSV requires a header and at least one data record.");
      const headers = header.values.map((value) => value.trim().toLowerCase());
      const canonical = headers.map((value) => value === "latitude" ? "lat" : ["lng", "longitude"].includes(value) ? "lon" : value);
      if (canonical.some((value) => !value) || new Set(canonical).size !== canonical.length || !canonical.includes("lat") || !canonical.includes("lon")) throw new InvalidImport("CSV requires unique nonempty headers and exactly one lat/latitude and lon/lng/longitude column.");
      for (const row of rows) {
        const label = `CSV row ${row.line}`;
        if (row.values.length !== headers.length) { reject(`${label}: field count does not match the header.`); continue; }
        const properties = Object.fromEntries(canonical.map((key, index) => [key, row.values[index]]));
        const lat = decimalCoordinate(properties.lat);
        const lon = decimalCoordinate(properties.lon);
        if (lat === undefined || lon === undefined) { reject(`${label}: missing valid lat/lon.`); continue; }
        try {
          const geometry = validateImportGeometry({ type: "Point", coordinates: [lon, lat] }, incident, budget);
          assets.push({ properties, geometry, coordinates: [lon, lat], label });
        } catch (error) {
          if (error instanceof ImportBudgetExceeded) throw error;
          if (!(error instanceof InvalidImport)) throw error;
          reject(`${label}: ${error.message}`);
        }
      }
    }
    for (let index = assets.length - 1; index >= 0; index--) {
      if (!scope.contains(assets[index].coordinates)) {
        reject(`${assets[index].label}: primary asset location falls outside the county boundary.`);
        assets.splice(index, 1);
      }
    }
    if (!assets.length && !errors.length) reject("Import contains no asset records.");
    if (rejected > errors.length) errors.push(`${rejected - errors.length} additional records rejected; correct the file before retrying.`);
    return { assets, errors };
  } catch (error) {
    if (error instanceof CountyScopeError) return { assets: [], errors: [error.message] };
    if (!(error instanceof InvalidImport)) throw error;
    return { assets: [], errors: [error.message] };
  }
}

function decimalCoordinate(value: string) {
  const text = value.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return undefined;
  const number = Number(text);
  return Number.isFinite(number) ? number : undefined;
}

function validateProperties(properties: Record<string, unknown>) {
  for (const key of ["name", "asset_name", "type", "road", "stream", "location"]) {
    const value = properties[key];
    if (value !== undefined && value !== null && (typeof value !== "string" || value.length > IMPORT_LIMITS.fieldChars)) throw new InvalidImport("supported properties must be text within the field limit.");
  }
}

function csvRecords(content: string) {
  const records: { values: string[]; line: number }[] = [];
  let values: string[] = [], field = "", quoted = false, closed = false, line = 1, start = 1;
  const finishField = () => {
    if (values.length >= IMPORT_LIMITS.fields) throw new ImportBudgetExceeded("CSV column limit exceeded.");
    values.push(field); field = ""; closed = false;
  };
  const finishRecord = () => {
    finishField();
    if (values.length !== 1 || values[0] !== "") records.push({ values, line: start });
    values = [];
    if (records.length > IMPORT_LIMITS.records + 1) throw new ImportBudgetExceeded("Import record limit exceeded; split the file before retrying.");
  };
  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    if (quoted) {
      if (char === '"') {
        if (content[i + 1] === '"') { field += '"'; i++; }
        else { quoted = false; closed = true; }
      } else { field += char; if (char === "\n" || (char === "\r" && content[i + 1] !== "\n")) line++; }
    } else if (char === ",") finishField();
    else if (char === "\r" || char === "\n") {
      finishRecord(); if (char === "\r" && content[i + 1] === "\n") i++;
      line++; start = line;
    } else if (char === '"' && !field && !closed) quoted = true;
    else if (char === '"' || closed) throw new InvalidImport(`CSV row ${start}: malformed quoting.`);
    else field += char;
    if (field.length > IMPORT_LIMITS.fieldChars) throw new ImportBudgetExceeded(`CSV row ${start}: field limit exceeded.`);
  }
  if (quoted) throw new InvalidImport(`CSV row ${start}: unterminated quoted field.`);
  if (field || values.length || closed) finishRecord();
  return records;
}

function same(a: Position, b: Position) { return a[0] === b[0] && a[1] === b[1]; }
function firstPosition(geometry: Geometry): Position {
  return geometry.type === "Point" ? geometry.coordinates : geometry.type === "LineString" ? geometry.coordinates[0] : geometry.coordinates[0][0];
}

export function validateImportGeometry(value: unknown, incident: Bounds, budget: ImportValidationBudget = { vertices: 0, comparisons: 0 }): Geometry {
  if (!record(value) || "crs" in value) throw new InvalidImport("geometry must use WGS84 without a custom CRS.");
  const position = (point: unknown): Position => {
    if (++budget.vertices > IMPORT_LIMITS.vertices) throw new ImportBudgetExceeded("Import vertex limit exceeded; split the file without simplifying geometry.");
    if (!Array.isArray(point) || point.length !== 2 || !point.every((number) => typeof number === "number" && Number.isFinite(number)) || Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90) throw new InvalidImport("positions must contain exactly two finite WGS84 longitude/latitude numbers.");
    const result: Position = [point[0], point[1]];
    if (!coordinateInIncidentBounds(incident, result)) throw new InvalidImport(`coordinates fall outside ${incident.county}.`);
    return result;
  };
  if (value.type === "Point") return { type: "Point", coordinates: position(value.coordinates) };
  if (value.type === "LineString") {
    if (!Array.isArray(value.coordinates) || value.coordinates.length < 2) throw new InvalidImport("LineString requires at least two positions.");
    const coordinates = value.coordinates.map(position);
    if (coordinates.some((point, i) => i > 0 && same(point, coordinates[i - 1]))) throw new InvalidImport("LineString contains a zero-length segment.");
    return { type: "LineString", coordinates };
  }
  if (value.type !== "Polygon") throw new InvalidImport("supported geometry is 2D Point, LineString or Polygon; split multipart features in GIS before importing.");
  if (!Array.isArray(value.coordinates) || !value.coordinates.length) throw new InvalidImport("Polygon requires an exterior ring.");
  const rings = value.coordinates.map((raw: unknown): Position[] => {
    if (!Array.isArray(raw) || raw.length < 4) throw new InvalidImport("Polygon rings require at least four positions.");
    const ring = raw.map(position);
    if (!same(ring[0], ring[ring.length - 1])) throw new InvalidImport("Polygon rings must be explicitly closed.");
    if (ring.some((point, i) => i > 0 && same(point, ring[i - 1]))) throw new InvalidImport("Polygon contains a zero-length segment.");
    const [x, y] = ring[0];
    const area = ring.slice(1).reduce((sum, point, i) => sum + (ring[i][0] - x) * (point[1] - y) - (point[0] - x) * (ring[i][1] - y), 0);
    if (Math.abs(area) < 1e-14) throw new InvalidImport("Polygon ring has zero or numerically indeterminate area.");
    return ring;
  });
  for (let r = 0; r < rings.length; r++) {
    for (let s = r; s < rings.length; s++) {
      for (let i = 0; i < rings[r].length - 1; i++) {
        for (let j = s === r ? i + 1 : 0; j < rings[s].length - 1; j++) {
          if (++budget.comparisons > IMPORT_LIMITS.comparisons) throw new ImportBudgetExceeded("Polygon validation budget exceeded; split the file or ask an operator to review GIS complexity.");
          if (r === s && (j === i + 1 || (i === 0 && j === rings[r].length - 2))) {
            const shared = j === i + 1 ? rings[r][j] : rings[r][0];
            const a = j === i + 1 ? rings[r][i] : rings[r][1];
            const b = j === i + 1 ? rings[r][j + 1] : rings[r][j];
            if (cross(a, shared, b) === 0 && ((a[0] - shared[0]) * (b[0] - shared[0]) + (a[1] - shared[1]) * (b[1] - shared[1])) > 0) throw new InvalidImport("Polygon contains overlapping adjacent segments.");
            continue;
          }
          if (intersects(rings[r][i], rings[r][i + 1], rings[s][j], rings[s][j + 1])) throw new InvalidImport("Polygon rings must not self-intersect, cross or touch.");
        }
      }
    }
    if (r > 0 && !coordinateInPolygon(rings[r][0], { type: "Polygon", coordinates: [rings[0]] })) throw new InvalidImport("Polygon holes must lie inside the exterior ring.");
    for (let s = 1; s < r; s++) {
      if (coordinateInPolygon(rings[r][0], { type: "Polygon", coordinates: [rings[s]] }) || coordinateInPolygon(rings[s][0], { type: "Polygon", coordinates: [rings[r]] })) throw new InvalidImport("Polygon holes must not overlap or contain each other.");
    }
  }
  return { type: "Polygon", coordinates: rings };
}

function cross(a: Position, b: Position, c: Position) { return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]); }
function onSegment(a: Position, b: Position, p: Position) {
  return p[0] >= Math.min(a[0], b[0]) && p[0] <= Math.max(a[0], b[0]) && p[1] >= Math.min(a[1], b[1]) && p[1] <= Math.max(a[1], b[1]);
}
function intersects(a: Position, b: Position, c: Position, d: Position) {
  const x = cross(a, b, c), y = cross(a, b, d), z = cross(c, d, a), w = cross(c, d, b);
  return (x === 0 && onSegment(a, b, c)) || (y === 0 && onSegment(a, b, d)) || (z === 0 && onSegment(c, d, a)) || (w === 0 && onSegment(c, d, b)) || (Math.sign(x) !== Math.sign(y) && Math.sign(z) !== Math.sign(w) && x !== 0 && y !== 0 && z !== 0 && w !== 0);
}

export function isUploadedAsset(asset: Pick<Asset, "localOrUploaded" | "origin" | "sourceKey">) {
  return asset.localOrUploaded || asset.origin === "uploaded" || asset.sourceKey === "local-upload";
}

export function uploadedAssetIdentity(asset: Pick<Asset, "incidentId" | "name" | "type" | "source" | "coordinates" | "geometry" | "road" | "stream">) {
  return JSON.stringify([asset.incidentId, asset.source.trim().toLowerCase(), asset.name.trim().toLowerCase(), asset.type,
    asset.coordinates, asset.geometry, asset.road?.trim().toLowerCase() ?? "", asset.stream?.trim().toLowerCase() ?? ""]);
}

export function projectUploadedAsset(asset: Asset, incident: Bounds, budget: ImportValidationBudget = { vertices: 0, comparisons: 0 }): Asset {
  if (!isUploadedAsset(asset)) return asset;
  try {
    const geometry = validateImportGeometry(asset.geometry, incident, budget);
    if (!Array.isArray(asset.coordinates) || asset.coordinates.length !== 2 || !same(firstPosition(geometry), asset.coordinates)) throw new InvalidImport("representative coordinate mismatch");
    return { ...asset, geometry, localOrUploaded: true, origin: "uploaded", sourceKey: "local-upload", confidence: "Low", confidenceReason: UPLOAD_CONFIDENCE_REASON };
  } catch (error) {
    if (!(error instanceof InvalidImport)) throw error;
    console.warn("[fireafter] retained upload rejected", { code: "uploaded_geometry_invalid" });
    throw new InventoryCapacityError("uploaded_geometry_invalid");
  }
}
