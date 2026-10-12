"""Rebuild the public code map from current source, not generated graph metadata."""
import hashlib
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory

import networkx as nx
from graphify.build import build
from graphify.cluster import cluster, label_communities_by_hub, score_all
from graphify.export import to_html, to_json
from graphify.extract import extract
from graphify.report import generate


ROOT_CONFIGS = {"next.config.ts", "vitest.config.ts", "eslint.config.mjs", "postcss.config.mjs"}
EXTENSIONS = {".ts", ".tsx", ".js", ".mjs", ".cjs", ".py", ".sql"}


def source_files(root):
    listed = subprocess.check_output(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=root
    ).decode("utf-8").split("\0")
    return sorted({name for name in listed if name and (root / name).is_file()
                   and (name in ROOT_CONFIGS or (
                       name.split("/")[0] in {"src", "scripts", "supabase"}
                       and Path(name).suffix in EXTENSIONS
                       and not name.startswith(("supabase/.temp/", "src/app/.well-known/"))))})


def connect_inventory(graph, files):
    """File membership is structural evidence, never an invented call dependency."""
    file_set = set(files)
    for _, node in graph.nodes(data=True):
        source = node.get("source_file") or ""
        if source.startswith("node:"):
            node["external_module"] = source
            node["source_file"] = ""
            source = ""
        if source and source not in file_set:
            raise ValueError(f"Unexpected source outside the code inventory: {source}")
    aliases = {}
    for identity, node in graph.nodes(data=True):
        source = node.get("source_file")
        if source in file_set and node.get("label") in {source, Path(source).name}:
            aliases[identity] = "file:" + source
    graph = nx.relabel_nodes(graph, aliases, copy=True)
    # Graphify's serializer restores these cached endpoints after NetworkX export.
    for _, _, edge in graph.edges(data=True):
        for key in ("_src", "_tgt"):
            if key in edge:
                edge[key] = aliases.get(edge[key], edge[key])
    # Source-less zero-degree references are parser artifacts, not unused files.
    removed = [{"id": identity, "label": node.get("label", "")}
               for identity, node in graph.nodes(data=True)
               if graph.degree(identity) == 0 and not node.get("source_file")]
    graph.remove_nodes_from(item["id"] for item in removed)

    def member(parent, child, relation, source=""):
        if parent != child and not graph.has_edge(parent, child):
            graph.add_edge(parent, child, relation=relation, confidence="EXTRACTED",
                           confidence_score=1, source_file=source, weight=1)

    graph.add_node("project:fireafter", label="FireAfter", file_type="project", source_file="")
    for name in files:
        identity = "file:" + name
        group = name.rsplit("/", 1)[0] if "/" in name else "configuration"
        group = "/".join(group.split("/")[:2]) if group.startswith(("src/", "supabase/")) else group.split("/")[0]
        group_id = "directory:" + group
        graph.add_node(group_id, label=group, file_type="directory", source_file="")
        graph.add_node(identity, label=name, source_file=name, file_type="code")
        member("project:fireafter", group_id, "contains_directory")
        member(group_id, identity, "contains_file", name)
    for identity, node in list(graph.nodes(data=True)):
        source = node.get("source_file")
        if source in file_set:
            member("file:" + source, identity, "declares", source)
        elif not source and identity != "project:fireafter" and not identity.startswith("directory:"):
            node["file_type"] = "reference"
    isolated = list(nx.isolates(graph))
    if isolated:
        raise ValueError(f"Unexplained isolated nodes: {isolated}")
    if not nx.is_weakly_connected(graph):
        raise ValueError("Code graph has a disconnected component without a source owner")
    return graph, removed


def main():
    root = Path(__file__).resolve().parent.parent
    files = source_files(root)
    if not files:
        raise ValueError("No source files found; refusing to replace the graph")
    print(f"Code corpus: {len(files)} source/config/test files; generated output and document semantics excluded.", flush=True)
    data = extract([root / name for name in files], cache_root=root, root=root, max_workers=4)
    if data.get("failed_sources"):
        raise ValueError(f"Extraction failed: {data['failed_sources']}")
    graph, removed = connect_inventory(build([data], root=root, directed=True, dedup=False), files)
    communities = cluster(graph)
    labels = label_communities_by_hub(graph, communities)
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root).decode().strip()
    digest = hashlib.sha256()
    for name in files:
        digest.update(name.encode() + b"\0" + (root / name).read_bytes() + b"\0")
    receipt = {"generatedAt": datetime.now(timezone.utc).isoformat(), "commit": commit,
               "sourceDigest": digest.hexdigest(), "files": files,
               "scope": "Current working-tree code/config/tests; structural extraction only, not semantic or runtime proof.",
               "removedSourceLessIsolates": removed, "nodes": len(graph), "edges": graph.number_of_edges(),
               "isolated": 0, "dangling": 0, "connectedComponents": 1}
    graph.graph.update({"source_digest": receipt["sourceDigest"], "scope": receipt["scope"]})
    output = root / "graphify-out"
    output.mkdir(exist_ok=True)
    (root / "output").mkdir(exist_ok=True)
    # Stage exports before replacing the last usable snapshot; shrinking is intentional.
    with TemporaryDirectory(prefix="fireafter-clean-graph-", dir=root / "output") as temporary:
        stage = Path(temporary)
        if not to_json(graph, communities, stage / "graph.json", built_at_commit=commit, community_labels=labels):
            raise ValueError("Graph JSON export refused")
        subprocess.run(["node", str(root / "scripts/verify-graph-health.mjs"), str(stage / "graph.json")],
                       cwd=root, check=True)
        if len(graph) > 5000:
            print(f"Warning: {len(graph)} nodes; the complete viewer may take time to lay out.", flush=True)
        if to_html(graph, communities, stage / "graph.html", community_labels=labels, node_limit=len(graph) + 1) is False:
            raise ValueError("Graph HTML export refused")
        report = generate(graph, communities, score_all(graph, communities), labels, [], [],
                          {"warning": receipt["scope"]}, {"input": 0, "output": 0}, str(root), built_at_commit=commit)
        report += "\n## Integrity And Scope\n- Zero isolated nodes and dangling endpoints; one connected component.\n"
        report += "- contains_file and declares edges represent inventory ownership, not runtime calls.\n"
        report += f"- Working-tree source digest: `{receipt['sourceDigest']}`. The commit alone does not identify dirty source.\n"
        (stage / "GRAPH_REPORT.md").write_text(report, encoding="utf-8")
        for name in ("graph.json", "graph.html", "GRAPH_REPORT.md"):
            (stage / name).replace(output / name)
    (output / "cleanup-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: value for key, value in receipt.items() if key not in {"files", "removedSourceLessIsolates"}}))


if __name__ == "__main__":
    main()
