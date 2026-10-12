import { describe, expect, it } from "vitest";
import { coordinateInBbox, coordinateInIncidentBounds, coordinateInPolygon } from "./geo";

describe("incident geography helpers", () => {
  it("allows nearby county-edge coordinates with a small tolerance", () => {
    expect(coordinateInBbox([-118.61, 34.01], [-119.6, 34.0, -118.6, 34.7])).toBe(
      true,
    );
  });

  it("rejects coordinates far outside the incident bounding box", () => {
    expect(coordinateInBbox([-118.243, 34.125], [-119.6, 34.0, -118.6, 34.7])).toBe(
      false,
    );
  });

  it("fails closed when an incident has no bounding box", () => {
    expect(
      coordinateInIncidentBounds({ locationContext: undefined }, [-119.2, 34.4]),
    ).toBe(false);
  });

  it("applies polygon holes when linking source hazards to assets", () => {
    const polygon = {
      type: "Polygon" as const,
      coordinates: [
        [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]] as [number, number][],
        [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]] as [number, number][],
      ],
    };

    expect(coordinateInPolygon([2, 2], polygon)).toBe(true);
    expect(coordinateInPolygon([5, 5], polygon)).toBe(false);
    expect(coordinateInPolygon([12, 2], polygon)).toBe(false);
  });
});
