import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectGraph } from "./code-graph-health.mjs";
import { codeGraphNavigation } from "./code-graph-navigation.mjs";

export async function publishCodeGraph(root = process.cwd()) {
  const htmlPath = path.join(root, "graphify-out", "graph.html");
  const reportPath = path.join(root, "graphify-out", "GRAPH_REPORT.md");
  const vendorPath = path.join(root, "node_modules", "vis-network", "standalone", "umd", "vis-network.min.js");
  const outputPath = path.join(root, "public", "code-graph.html");
  const vendorOutputPath = path.join(root, "public", "vendor", "vis-network.min.js");
  const [source, report, vendor, graphText] = await Promise.all([
    readFile(htmlPath, "utf8"),
    readFile(reportPath, "utf8"),
    readFile(vendorPath),
    readFile(path.join(root, "graphify-out", "graph.json"), "utf8"),
  ]);
  const graph = JSON.parse(graphText);
  const health = inspectGraph(graph);
  if (!health.ok) throw new Error(`Graph integrity failed: ${health.issues.join("; ")}`);
  const nodeMatch = source.match(/^const RAW_NODES = (.+);\r?$/m);
  const edgeMatch = source.match(/^const RAW_EDGES = (.+);\r?$/m);
  if (!nodeMatch || !edgeMatch) throw new Error("Graph HTML has no complete embedded graph data.");
  const visibleNodes = JSON.parse(nodeMatch[1]);
  const visibleEdges = JSON.parse(edgeMatch[1]).map((edge) => ({ source: edge.from, target: edge.to }));
  const visibleHealth = inspectGraph({ nodes: visibleNodes, edges: visibleEdges });
  const sourceIds = new Set(graph.nodes.map((node) => node.id));
  const sourceEdges = new Set((graph.edges || graph.links).map((edge) => JSON.stringify([edge.source, edge.target])));
  if (!visibleHealth.ok || visibleNodes.length !== graph.nodes.length ||
      visibleNodes.some((node) => !sourceIds.has(node.id)) || visibleEdges.length !== health.edges ||
      visibleEdges.some((edge) => !sourceEdges.has(JSON.stringify([edge.source, edge.target])))) {
    throw new Error("Graph HTML is stale, truncated, or contains orphan/dangling nodes.");
  }
  const reportIdentity = report.match(/^# Graph Report - (FireAfter(?: Sentinel)?)\s+\((\d{4}-\d{2}-\d{2})\)/m);
  const project = reportIdentity?.[1];
  const date = reportIdentity?.[2];
  if (!date) throw new Error("Graph report has no valid FireAfter generation date.");
  if (graph.graph?.project && graph.graph.project !== project) throw new Error("Graph report belongs to a different project.");
  if (!source.includes("<body>") || !source.includes("</body>") || !source.includes("</style>")) {
    throw new Error("Graphify HTML structure is not recognized; refusing to publish a partial snapshot.");
  }
  const viewerScript = source.match(/<script src="https:\/\/unpkg\.com\/vis-network@9\.1\.6\/standalone\/umd\/vis-network\.min\.js"\s+integrity="(sha384-[^"]+)"\s+crossorigin="anonymous"><\/script>/);
  if (!viewerScript) throw new Error("Graphify viewer dependency is missing or no longer pinned to vis-network 9.1.6.");
  const actualIntegrity = `sha384-${createHash("sha384").update(vendor).digest("base64")}`;
  if (viewerScript[1] !== actualIntegrity) {
    throw new Error("Installed vis-network bytes do not match the integrity-pinned Graphify viewer dependency.");
  }

  const banner = `<aside id="snapshot-notice" role="note"><strong>${project} code graph snapshot - ${date}</strong><span>Public repository structure: paths, symbols, and test names. This view does not contain full source files.</span><span>Structural map: 0 orphan nodes, 0 dangling edges.</span><a href="/features">Back to the product feature graph</a></aside>`;
  const styles = `\n  #snapshot-notice { position: fixed; z-index: 20; top: 8px; left: 8px; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; max-width: calc(100vw - 310px); padding: 8px 12px; border: 1px solid #fb923c; border-radius: 8px; background: rgba(7, 19, 31, .96); color: #f8fafc; font-size: 12px; line-height: 1.4; box-shadow: 0 8px 24px rgba(0,0,0,.28); }\n  #snapshot-notice strong { color: #fdba74; }\n  #snapshot-notice a { color: #fed7aa; text-decoration: underline; }\n  @media (max-width: 640px) { #snapshot-notice { max-width: calc(100vw - 16px); right: 8px; } }\n`;
  const output = source
    .replace(/network\.focus\(n\.id, \{ scale: 1\.5, animation: true \}\);\s*network\.selectNodes\(\[n\.id\]\);\s*showInfo\(n\.id\);/, "focusNode(n.id);")
    .replace(viewerScript[0], viewerScript[0].replace("https://unpkg.com/vis-network@9.1.6/standalone/umd/vis-network.min.js", "/vendor/vis-network.min.js"))
    .replace(/<title>[^<]*<\/title>/, `<title>${project} Code Graph Snapshot - ${date}</title>`)
    .replace("</style>", `${styles}\n#graph-navigation { display:flex; flex-wrap:wrap; gap:8px; align-items:center; width:100%; } #graph-navigation button { background:#173e39; color:#f8fafc; border:1px solid #558b80; border-radius:5px; padding:6px 12px; cursor:pointer; } #graph-navigation button:focus-visible { outline:2px solid #fdba74; } #legend-wrap[hidden] { display:none; }\n</style>`)
    .replace("<body>", `<body>\n${banner}`)
    .replace("</body>", `<script>${codeGraphNavigation}</script>\n</body>`);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await mkdir(path.dirname(vendorOutputPath), { recursive: true });
  await writeFile(outputPath, output, "utf8");
  await writeFile(vendorOutputPath, vendor);
  return { outputPath, vendorOutputPath, date, bytes: Buffer.byteLength(output), vendorBytes: vendor.byteLength };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await publishCodeGraph();
    console.log(`[code-graph] published ${result.bytes} graph bytes and ${result.vendorBytes} pinned viewer bytes from ${result.date} to public/`);
  } catch (error) {
    console.error(`[code-graph] publish failed: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  }
}
