import { expect, it } from "vitest";
import { classifyRing, geometryBudget, prepareRingClassifier, PwfdfGeometryError, type Position } from "./pwfdf-geometry";

const shapes: Position[][] = [
  [[0, 0], [8, 0], [8, 8], [0, 8], [0, 0]],
  [[0, 0], [8, 0], [8, 1], [2, 1], [2, 6], [8, 6], [8, 8], [0, 8], [0, 0]],
  [[0, 0], [4, 3], [8, 0], [8, 8], [0, 8], [0, 0]],
];
it("matches exhaustive exact classification across concavities, horizontal edges, vertices and winding", () => {
  for (const source of shapes) for (const ring of [source, [...source].reverse()]) {
    const before = structuredClone(ring), classify = prepareRingClassifier(ring);
    for (let x = -1; x <= 9; x += 0.125) for (let y = -1; y <= 9; y += 0.125) {
      expect(classify([x, y])).toBe(classifyRing([x, y], ring));
    }
    expect(ring).toEqual(before);
  }
});
it("retains exact subnormal and nearly collinear boundary behavior without rounding", () => {
  const s = Number.MIN_VALUE;
  for (const ring of [
    [[0, 0], [4 * s, 0], [4 * s, 4 * s], [0, 4 * s], [0, 0]],
    [[0, 0], [1, 1], [1, 1 + Number.EPSILON], [0, Number.EPSILON], [0, 0]],
  ] as Position[][]) {
    const classify = prepareRingClassifier(ring);
    for (const point of [...ring, [s, s], [2 * s, -s], [0.5, 0.5], [0.5, 0.5 + Number.EPSILON]] as Position[]) {
      expect(classify(point)).toBe(classifyRing(point, ring));
    }
  }
});
it("uses a private snapshot and keeps construction and query work bounded", () => {
  const ring = structuredClone(shapes[0]), classify = prepareRingClassifier(ring);
  ring[0][0] = 99;
  expect(classify([1, 1])).toBe(1);
  expect(classify([NaN, 1])).toBe(-1);
  expect(() => prepareRingClassifier(shapes[0], { vertices: 0, work: 2_000_000 })).toThrow(PwfdfGeometryError);
  expect(() => classify([1, 1], { vertices: 0, work: 2_000_000 })).toThrow(PwfdfGeometryError);
});
it("prunes a high-resolution ring without simplifying or dropping any edge", () => {
  const ring: Position[] = Array.from({ length: 10_000 }, (_, i) => [Math.cos(i * 2 * Math.PI / 10_000), Math.sin(i * 2 * Math.PI / 10_000)]);
  ring.push([...ring[0]]);
  const classify = prepareRingClassifier(ring), budget = geometryBudget();
  expect(classify([0.1, 0.2], budget)).toBe(classifyRing([0.1, 0.2], ring));
  expect(budget.work).toBeLessThan(150);
  for (const i of [0, 120, 2500, 6400, 9999]) expect(classify(ring[i])).toBe(0);
});
