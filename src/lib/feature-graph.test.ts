import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { FEATURE_GRAPH_EDGES, FEATURE_GRAPH_NODES, FEATURE_STAGES } from "./feature-graph";

describe("product feature graph catalog", () => {
  it("groups every capability exactly once in six ordered, nonempty stages", () => {
    expect(FEATURE_STAGES).toHaveLength(6);
    expect(FEATURE_STAGES.map((stage) => stage.number)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(new Set(FEATURE_STAGES.map((stage) => stage.id)).size).toBe(6);
    expect(FEATURE_GRAPH_NODES).toHaveLength(25);
    expect(FEATURE_STAGES.flatMap((stage) => FEATURE_GRAPH_NODES.filter((node) => node.stage === stage.id)))
      .toEqual(FEATURE_GRAPH_NODES);
    for (const stage of FEATURE_STAGES) {
      expect(FEATURE_GRAPH_NODES.some((node) => node.stage === stage.id)).toBe(true);
    }
  });

  it("has unique identities and valid connected relationships with no orphans or duplicate edges", () => {
    const ids = new Set(FEATURE_GRAPH_NODES.map((node) => node.id));
    expect(ids.size).toBe(FEATURE_GRAPH_NODES.length);
    expect(new Set(FEATURE_GRAPH_EDGES.map((edge) => `${edge.from}:${edge.to}`)).size).toBe(FEATURE_GRAPH_EDGES.length);
    for (const edge of FEATURE_GRAPH_EDGES) {
      expect(ids.has(edge.from)).toBe(true);
      expect(ids.has(edge.to)).toBe(true);
      expect(edge.from).not.toBe(edge.to);
      expect(edge.label.length).toBeGreaterThan(0);
    }
    for (const node of FEATURE_GRAPH_NODES) {
      expect(FEATURE_GRAPH_EDGES.some((edge) => edge.from === node.id || edge.to === node.id)).toBe(true);
    }
    const visited = new Set([FEATURE_GRAPH_NODES[0].id]);
    for (let i = 0; i < ids.size; i++) {
      for (const edge of FEATURE_GRAPH_EDGES) {
        if (visited.has(edge.from) || visited.has(edge.to)) {
          visited.add(edge.from);
          visited.add(edge.to);
        }
      }
    }
    expect([...visited].sort()).toEqual([...ids].sort());
  });

  it("anchors every feature to real pages, API methods, implementation, and test files", () => {
    for (const node of FEATURE_GRAPH_NODES) {
      expect(node.summary.length).toBeGreaterThan(20);
      expect(node.limits.length).toBeGreaterThan(20);
      expect(["Implemented", "Source-dependent", "Operator configuration"]).toContain(node.availability);
      for (const field of ["where", "apis", "sources", "implementation", "tests"] as const) {
        expect(node[field].length, `${node.id}: ${field}`).toBeGreaterThan(0);
      }
      for (const file of [...node.implementation, ...node.tests]) {
        expect(existsSync(path.join(process.cwd(), file)), `${node.id}: ${file}`).toBe(true);
      }
      for (const link of node.where) {
        expect(link.href).toMatch(/^\/(?:[a-z-]+\/)*[a-z-]*$/);
        expect(existsSync(path.join(process.cwd(), "src/app", link.href, "page.tsx")), `${node.id}: ${link.href}`).toBe(true);
      }
      for (const api of node.apis) {
        const [method, route] = api.split(" ");
        const file = path.join(process.cwd(), "src/app", route, "route.ts");
        expect(existsSync(file), `${node.id}: ${api}`).toBe(true);
        expect(readFileSync(file, "utf8"), api).toMatch(new RegExp(`export (?:async function|const) ${method}\\b`));
      }
    }
  });

  it("keeps gated and evidence-dependent capabilities explicit rather than claiming live availability", () => {
    for (const id of ["background-ingestion", "large-county", "scheduled-refresh"]) {
      expect(FEATURE_GRAPH_NODES.find((node) => node.id === id)?.availability).toBe("Operator configuration");
    }
    for (const id of ["ranked-queue", "published-assessment", "assessment-linkage", "fire-selection"]) {
      expect(FEATURE_GRAPH_NODES.find((node) => node.id === id)?.availability).toBe("Source-dependent");
    }
    expect(FEATURE_GRAPH_NODES.find((node) => node.id === "published-assessment")?.where[0].href).toBe("/");
    expect(FEATURE_GRAPH_NODES.find((node) => node.id === "ranked-queue")?.limits).toContain("Unknown");
  });
});
