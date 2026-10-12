// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { codeGraphNavigation } from "../../scripts/code-graph-navigation.mjs";

describe("code graph navigation", () => {
  it("starts small, drills into complete neighborhoods and can restore all symbols", () => {
    document.body.innerHTML = '<aside id="snapshot-notice"></aside><div id="legend-wrap"></div><div id="info-content"></div>';
    const nodes = ["project:fireafter", "directory:src/lib", "file:src/lib/a.ts", "symbol:a"].map(id => ({ id, label: id }));
    const edges = [
      { from: "project:fireafter", to: "directory:src/lib" },
      { from: "directory:src/lib", to: "file:src/lib/a.ts" },
      { from: "file:src/lib/a.ts", to: "symbol:a" },
    ];
    class DataSet {
      constructor(public values: unknown[]) {}
      get() { return this.values; }
    }
    const nodesDS = new DataSet(nodes);
    const edgesDS = new DataSet(edges);
    const network = { setData: vi.fn(), setOptions: vi.fn(), fit: vi.fn(), stabilize: vi.fn(), once: vi.fn(), on: vi.fn() };
    const focus = vi.fn();
    const run = new Function("RAW_NODES", "RAW_EDGES", "nodesDS", "edgesDS", "network", "vis", "focusNode", "showInfo", `${codeGraphNavigation}\nreturn focusNode;`);
    const focusNode = run(nodes, edges, nodesDS, edgesDS, network, { DataSet }, focus, vi.fn());
    expect(network.setData.mock.lastCall?.[0].nodes.get()).toHaveLength(2);
    expect(document.getElementById("graph-view-status")?.textContent).toContain("Folder overview");
    focusNode("symbol:a");
    expect(network.setData.mock.lastCall?.[0].nodes.get().map((node: { id: string }) => node.id)).toEqual(["file:src/lib/a.ts", "symbol:a"]);
    expect(focus).toHaveBeenCalledWith("symbol:a");
    document.getElementById("graph-all")?.click();
    expect(network.setData.mock.lastCall?.[0].nodes).toBe(nodesDS);
    expect(document.getElementById("legend-wrap")?.hidden).toBe(false);
    document.getElementById("graph-overview")?.click();
    expect(network.setData.mock.lastCall?.[0].nodes.get()).toHaveLength(2);
  });
});
