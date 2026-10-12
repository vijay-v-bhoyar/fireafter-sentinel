import { readFile } from "node:fs/promises";
import { inspectGraph } from "./code-graph-health.mjs";

try {
  const graphPath = process.argv[2] || "graphify-out/graph.json";
  const result = inspectGraph(JSON.parse(await readFile(graphPath, "utf8")));
  console.log(JSON.stringify({ graphPath, ...result,
    isolated: result.isolated.slice(0, 20), dangling: result.dangling.slice(0, 20),
    duplicates: result.duplicates.slice(0, 20),
  }, null, 2));
  if (!result.ok) process.exitCode = 1;
} catch (error) {
  console.error("[verify:graph] failed:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
