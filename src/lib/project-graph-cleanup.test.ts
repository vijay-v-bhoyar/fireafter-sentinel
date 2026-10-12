import { describe, expect, it } from "vitest";
import { reconcileProjectGraph } from "../../scripts/clean-project-graph.mjs";
import { inspectGraph } from "../../scripts/code-graph-health.mjs";

describe("project catalog reconciliation", () => {
  const fixture = {
    nodes: [{ id: "a", role: "old" }, { id: "a", role: "current" }, { id: "orphan" }],
    edges: [
      { from: "a", to: "function:src/a.ts#run", type: "[calls]" },
      { from: "a", to: "file:src/a.ts", type: "[imports]" },
      { from: "a", to: "missing", type: "[calls]" },
    ],
    functionIndex: [{ file: "src/a.ts", functions: [{ id: "function:src/a.ts#run", type: "[Function]" }] }],
    apiContracts: [], edgeTypes: ["[calls]"],
  };
  it("restores only supported references and records retired edges", () => {
    const { graph, report } = reconcileProjectGraph(fixture, (file: string) => file === "src/a.ts");
    expect(report.duplicates).toEqual(["a"]);
    expect(report.restored).toHaveLength(2);
    expect(report.retired).toEqual([fixture.edges[2]]);
    expect(graph.nodes.find((node: { id: string }) => node.id === "a").role).toBe("current");
    expect(inspectGraph({ nodes: graph.nodes, edges: graph.edges.map((e: { from: string; to: string }) => ({ source: e.from, target: e.to })) }).ok).toBe(true);
    expect(fixture.nodes).toHaveLength(3);
  });
  it("is idempotent", () => {
    const first = reconcileProjectGraph(fixture, () => true).graph;
    expect(reconcileProjectGraph(first, () => true).graph).toEqual(first);
  });
  it("uses API identity rather than a documentation URL containing query parameters", () => {
    const input = structuredClone(fixture);
    const graph = { ...input, apiContracts: [{ id: "api:GET /api/map/features", method: "GET", path: "/api/map/features?incidentId=", file: "src/app/api/map/features/route.ts" }] };
    graph.edges.push({ from: "a", to: "api:GET /api/map/features", type: "[calls]" });
    expect(reconcileProjectGraph(graph, () => true).report.restored).toContain("api:GET /api/map/features");
  });
});
