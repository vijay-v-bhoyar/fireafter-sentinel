import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function reconcileProjectGraph(input, fileExists) {
  const graph = structuredClone(input);
  const nodes = new Map();
  const duplicates = [];
  for (const node of graph.nodes) {
    if (nodes.has(node.id)) duplicates.push(node.id);
    nodes.set(node.id, { ...nodes.get(node.id), ...node });
  }
  const indexed = new Map(graph.functionIndex.flatMap((entry) =>
    entry.functions.map((fn) => [fn.id, { ...fn, file: entry.file }])));
  const contracts = new Map(graph.apiContracts.map((api) => [api.id || `api:${api.method} ${api.path.split("?")[0]}`, api]));
  const restored = [];
  const retired = [];
  for (const id of new Set(graph.edges.flatMap((edge) => [edge.from, edge.to]))) {
    if (nodes.has(id)) continue;
    let node;
    if (id.startsWith("file:") && fileExists(id.slice(5))) {
      node = { id, type: "[File]", path: id.slice(5) };
    } else if (indexed.has(id) && fileExists(indexed.get(id).file)) {
      node = { ...indexed.get(id), catalogOrigin: "functionIndex" };
    } else if (contracts.has(id) && fileExists(contracts.get(id).file)) {
      node = { id, type: "[API]", file: contracts.get(id).file, catalogOrigin: "apiContracts" };
    }
    if (node) {
      nodes.set(id, node);
      restored.push(id);
    }
  }
  const edges = new Map();
  const addEdge = (edge) => edges.set(JSON.stringify([edge.from, edge.to, edge.type]), edge);
  for (const edge of graph.edges) {
    if (nodes.has(edge.from) && nodes.has(edge.to)) addEdge(edge);
    else retired.push(edge);
  }
  const catalog = "file:pkg.json";
  if (!nodes.has(catalog)) nodes.set(catalog, { id: catalog, type: "[File]", path: "pkg.json", role: "Authoritative project catalog. Catalog membership is not a runtime dependency." });
  for (const node of nodes.values()) {
    if (node.id !== catalog) addEdge({ from: catalog, to: node.id, type: "[catalogs]" });
  }
  graph.nodes = [...nodes.values()];
  graph.edges = [...edges.values()];
  graph.edgeTypes = [...new Set([...graph.edgeTypes, "[catalogs]"])];
  return { graph, report: { duplicates, restored, retired } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  const filename = path.join(root, "pkg.json");
  const original = readFileSync(filename, "utf8");
  const input = JSON.parse(original);
  if (process.argv.includes("--retry-retired")) {
    const previous = JSON.parse(readFileSync(path.join(root, "output/verification/project-graph-cleanup/receipt.json"), "utf8"));
    input.edges.push(...previous.retired);
  }
  const roles = {
    "scripts/refresh-code-graph.py": "Rebuilds the complete current source/config/test structural graph. Excludes generated metadata and document semantics; canonicalizes file aliases and exporter endpoint metadata, retains real standalone files via explicit ownership, and removes only source-less isolated parser aliases. Staged JSON integrity gate and working-tree digest precede publication.",
    "scripts/test_refresh_code_graph.py": "Graph cleanup contracts for real file ownership, source-less aliases, external Node modules, excluded sources and idempotence.",
    "scripts/code-graph-health.mjs": "Strict graph integrity: rejects every isolated node, duplicate ID and missing endpoint, including external references. No orphan allowlist.",
    "scripts/verify-graph-health.mjs": "CLI for strict graph integrity. Supports a staged graph path and bounds displayed failure details while reporting full issue counts.",
    "src/lib/code-graph-health.test.ts": "Regression tests for old orphan exemptions, unresolved external/internal endpoints, duplicate/malformed IDs and self-loop-only nodes.",
    "scripts/clean-project-graph.mjs": "Reconciles PKG references against existing function/API catalogs and real files, deduplicates IDs/relations and retires unresolved historical edges with an audit receipt. Catalog membership does not claim a runtime dependency.",
    "src/lib/project-graph-cleanup.test.ts": "Project catalog cleanup: identity deduplication, validated endpoint restoration, unresolved edge retirement and idempotence.",
    "scripts/publish-code-graph.mjs": "Publishes only complete, orphan-free Graphify JSON and matching HTML node/edge sets. Retains generation date, scope disclosure and same-origin integrity-pinned viewer.",
    "scripts/code-graph-navigation.mjs": "Default folder overview with explicit ownership links; complete graph remains selectable. Folder drill-down and symbol search show focused neighborhoods without changing stored graph evidence.",
    "src/lib/code-graph-navigation.test.ts": "Executable DOM tests for small default overview, full symbol-neighborhood discovery, all-symbol restoration and return navigation.",
    "scripts/publish-code-graph.node-test.mjs": "Publication tests reject missing dates, tampered viewer bytes, orphan graphs and mismatched HTML snapshots.",
    ".graphifyignore": "Excludes generated public viewer/vendor, graph output, PKG structural metadata and local evidence from recursive code extraction.",
    ".gitignore": "Keeps secrets, browser artifacts, Python bytecode and historical Graphify caches local; retains current tracked graph exports.",
  };
  for (const [file, role] of Object.entries(roles)) {
    const id = "file:" + file;
    const existing = input.nodes.find((node) => node.id === id);
    if (existing) existing.role = role;
    else input.nodes.push({ id, type: "[File]", path: file, role });
  }
  const { graph, report } = reconcileProjectGraph(input, (file) => existsSync(path.join(root, file)));
  graph.generatedAt = new Date().toISOString();
  const output = path.join(root, "output/verification/project-graph-cleanup");
  mkdirSync(output, { recursive: true });
  const beforePath = path.join(output, "pkg.before.json");
  if (!existsSync(beforePath)) writeFileSync(beforePath, original);
  writeFileSync(path.join(output, "receipt.json"), JSON.stringify(report, null, 2) + "\n");
  writeFileSync(filename, JSON.stringify(graph, null, 2) + "\n");
  console.log(JSON.stringify({ nodes: graph.nodes.length, edges: graph.edges.length, restored: report.restored.length, duplicateIds: report.duplicates.length, retiredEdges: report.retired.length }));
}
