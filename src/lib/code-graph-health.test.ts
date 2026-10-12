import { describe, expect, it } from "vitest";
import { inspectGraph } from "../../scripts/code-graph-health.mjs";

describe("strict code graph integrity", () => {
  it("accepts connected endpoints in both supported edge formats", () => {
    const nodes = [{ id: "a" }, { id: "b" }];
    expect(inspectGraph({ nodes, links: [{ source: "a", target: "b" }] }).ok).toBe(true);
    expect(inspectGraph({ nodes, edges: [{ source: { id: "a" }, target: { id: "b" } }] }).ok).toBe(true);
  });
  it.each(["vitest_config", "scripts_server_only_test_boundary", "public_assets"])(
    "rejects formerly allowed orphan %s", (id) => {
      expect(inspectGraph({ nodes: [{ id }], edges: [] }).isolated).toEqual([id]);
      expect(inspectGraph({ nodes: [{ id }], edges: [] }).ok).toBe(false);
    },
  );
  it.each(["missing-internal", "ref_external", "src_app_globals"])(
    "rejects every dangling endpoint, including %s", (target) => {
      const result = inspectGraph({ nodes: [{ id: "a" }], edges: [{ source: "a", target }] });
      expect(result.dangling).toHaveLength(1);
      expect(result.ok).toBe(false);
    },
  );
  it("rejects duplicate and malformed identifiers", () => {
    expect(inspectGraph({ nodes: [{ id: "a" }, { id: "a" }], edges: [] }).duplicates).toEqual(["a"]);
    expect(inspectGraph({ nodes: [{}], edges: [] }).issues).toContain("graph has invalid node IDs");
  });
  it("does not treat a self-loop as a connection", () => {
    expect(inspectGraph({ nodes: [{ id: "a" }], edges: [{ source: "a", target: "a" }] }).ok).toBe(false);
  });
});
