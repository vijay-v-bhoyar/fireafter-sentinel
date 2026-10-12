export function inspectGraph(graph) {
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph.edges) ? graph.edges : Array.isArray(graph.links) ? graph.links : [];
  const endpointId = (value) => String(value && typeof value === "object" ? value.id : value);
  const ids = nodes.map((node) => endpointId(node.id));
  const nodeIds = new Set(ids);
  const degree = new Map(ids.map((id) => [id, 0]));
  const dangling = [];
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  for (const edge of edges) {
    const source = endpointId(edge.source);
    const target = endpointId(edge.target);
    if (!nodeIds.has(source) || !nodeIds.has(target)) dangling.push({ source, target });
    if (nodeIds.has(source) && nodeIds.has(target) && source !== target) {
      degree.set(source, degree.get(source) + 1);
      degree.set(target, degree.get(target) + 1);
    }
  }
  const isolated = [...degree].filter(([, count]) => count === 0).map(([id]) => id);
  const issues = [];
  if (!nodes.length) issues.push("graph has no nodes");
  if (!edges.length) issues.push("graph has no edges");
  if (nodes.some((node) => typeof node.id !== "string" || !node.id.trim())) issues.push("graph has invalid node IDs");
  if (duplicates.length) issues.push(`graph has ${duplicates.length} duplicate node IDs`);
  if (dangling.length) issues.push(`graph has ${dangling.length} dangling edges`);
  if (isolated.length) issues.push(`graph has ${isolated.length} isolated nodes`);
  return { ok: issues.length === 0, nodes: nodes.length, edges: edges.length, isolated, dangling, duplicates, issues };
}
