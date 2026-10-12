import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { publishCodeGraph } from "./publish-code-graph.mjs";

const vendorPath = path.join("node_modules", "vis-network", "standalone", "umd", "vis-network.min.js");
const vendor = Buffer.from("fixture vis-network bundle");
const integrity = `sha384-${createHash("sha384").update(vendor).digest("base64")}`;

async function createInputs(root, report = "# Graph Report - FireAfter  (2026-09-29)\n") {
  await mkdir(path.join(root, "graphify-out"), { recursive: true });
  await mkdir(path.dirname(path.join(root, vendorPath)), { recursive: true });
  const script = `<script src="https://unpkg.com/vis-network@9.1.6/standalone/umd/vis-network.min.js" integrity="${integrity}" crossorigin="anonymous"></script>`;
  const nodes = [{ id: "a" }, { id: "b" }];
  await writeFile(path.join(root, "graphify-out", "graph.json"), JSON.stringify({ nodes, links: [{ source: "a", target: "b" }] }));
  await writeFile(path.join(root, "graphify-out", "graph.html"),
    `<html><head><title>graphify - graphify-out/graph.html</title>${script}<style>body{}</style></head><body><div id="graph"></div><script>\nconst RAW_NODES = ${JSON.stringify(nodes)};\nconst RAW_EDGES = [{"from":"a","to":"b"}];\n</script></body></html>`);
  await writeFile(path.join(root, "graphify-out", "GRAPH_REPORT.md"), report);
  await writeFile(path.join(root, vendorPath), vendor);
}

test("publishes a dated code graph snapshot with a route back to the feature graph", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fireafter-code-graph-"));
  try {
    await createInputs(root);

    const result = await publishCodeGraph(root);
    const output = await readFile(result.outputPath, "utf8");
    const publishedVendor = await readFile(result.vendorOutputPath);
    assert.equal(result.date, "2026-09-29");
    assert.match(output, /FireAfter Code Graph Snapshot - 2026-09-29/);
    assert.match(output, /repository structure: paths, symbols, and test names/i);
    assert.match(output, /href="\/features"/);
    assert.match(output, /id="graph"/);
    assert.match(output, /Folder overview/);
    assert.match(output, /All symbols/);
    assert.match(output, /ownership, not runtime calls/);
    assert.match(output, /src="\/vendor\/vis-network\.min\.js"/);
    assert.doesNotMatch(output, /src="https:\/\/unpkg\.com/);
    assert.deepEqual(publishedVendor, vendor);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("binds the Sentinel report identity to its current graph metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sentinel-code-graph-"));
  try {
    await createInputs(root, "# Graph Report - FireAfter Sentinel (2026-10-11)\n");
    const graphPath = path.join(root, "graphify-out", "graph.json");
    const graph = JSON.parse(await readFile(graphPath, "utf8"));
    graph.graph = { project: "FireAfter Sentinel" };
    await writeFile(graphPath, JSON.stringify(graph));
    const result = await publishCodeGraph(root);
    assert.match(await readFile(result.outputPath, "utf8"), /FireAfter Sentinel Code Graph Snapshot - 2026-10-11/);
    await writeFile(path.join(root, "graphify-out", "GRAPH_REPORT.md"), "# Graph Report - FireAfter (2026-10-11)\n");
    await assert.rejects(publishCodeGraph(root), /different project/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("refuses to publish when the graph report has no generation date", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fireafter-code-graph-invalid-"));
  try {
    await createInputs(root, "# Graph Report - FireAfter\n");
    await assert.rejects(publishCodeGraph(root), /no valid FireAfter generation date/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses to publish a viewer bundle that does not match the pinned integrity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fireafter-code-graph-integrity-"));
  try {
    await createInputs(root);
    await writeFile(path.join(root, vendorPath), "tampered bundle");
    await assert.rejects(publishCodeGraph(root), /do not match the integrity-pinned/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses to publish orphaned graph data", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fireafter-code-graph-orphan-"));
  try {
    await createInputs(root);
    await writeFile(path.join(root, "graphify-out", "graph.json"), JSON.stringify({ nodes: [{ id: "a" }], links: [] }));
    await assert.rejects(publishCodeGraph(root), /Graph integrity failed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses to publish HTML from a different graph snapshot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fireafter-code-graph-stale-"));
  try {
    await createInputs(root);
    await writeFile(path.join(root, "graphify-out", "graph.json"), JSON.stringify({ nodes: [{ id: "x" }, { id: "y" }], links: [{ source: "x", target: "y" }] }));
    await assert.rejects(publishCodeGraph(root), /stale, truncated/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses different HTML edges even when node IDs and counts match", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fireafter-code-graph-edges-"));
  try {
    await createInputs(root);
    await writeFile(path.join(root, "graphify-out", "graph.json"), JSON.stringify({ nodes: [{ id: "a" }, { id: "b" }], links: [{ source: "b", target: "a" }] }));
    await assert.rejects(publishCodeGraph(root), /stale, truncated/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
