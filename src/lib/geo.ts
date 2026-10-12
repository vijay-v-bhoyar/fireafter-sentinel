import type { Asset, Incident, Recommendation } from "./types";
import { containsBasinPoint, type BasinGeometry, type GeometryBudget } from "./pwfdf-geometry";

export type Bbox = [number, number, number, number];

const defaultToleranceDegrees = 0.05;

export function coordinateInBbox(
  [lon, lat]: [number, number],
  [west, south, east, north]: Bbox,
  toleranceDegrees = defaultToleranceDegrees,
) {
  return (
    Number.isFinite(lon) &&
    Number.isFinite(lat) &&
    lon >= west - toleranceDegrees &&
    lon <= east + toleranceDegrees &&
    lat >= south - toleranceDegrees &&
    lat <= north + toleranceDegrees
  );
}

export function coordinateInIncidentBounds(
  incident: Pick<Incident, "locationContext">,
  coordinates: [number, number],
) {
  const bbox = incident.locationContext?.bbox;
  return bbox ? coordinateInBbox(coordinates, bbox) : false;
}

export function coordinateInPolygon(
  coordinate: [number, number],
  polygon: BasinGeometry,
  budget?: GeometryBudget,
) {
  return containsBasinPoint(coordinate, polygon, budget);
}

export function assetInIncidentBounds(
  incident: Pick<Incident, "locationContext">,
  asset: Pick<Asset, "coordinates">,
) {
  return coordinateInIncidentBounds(incident, asset.coordinates);
}

export function recommendationInIncidentBounds(
  incident: Pick<Incident, "locationContext">,
  recommendation: Pick<Recommendation, "coordinates">,
) {
  return coordinateInIncidentBounds(incident, recommendation.coordinates);
}
