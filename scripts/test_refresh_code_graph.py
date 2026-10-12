"""Small deterministic graph-cleanup contracts; no providers or source mutation."""
import importlib.util
import unittest
from pathlib import Path

import networkx as nx

spec = importlib.util.spec_from_file_location("refresh", Path(__file__).with_name("refresh-code-graph.py"))
refresh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(refresh)


class GraphCleanupTests(unittest.TestCase):
    def test_standalone_files_and_symbols_are_preserved_with_real_ownership(self):
        graph = nx.DiGraph()
        graph.add_node("empty_module", label="config.ts", source_file="config.ts")
        graph.add_node("symbol", label="helper", source_file="src/lib/demo.ts")
        cleaned, removed = refresh.connect_inventory(graph, ["config.ts", "src/lib/demo.ts"])
        self.assertEqual(removed, [])
        self.assertEqual(list(nx.isolates(cleaned)), [])
        self.assertEqual(cleaned.edges["file:src/lib/demo.ts", "symbol"]["relation"], "declares")
        self.assertTrue(nx.is_weakly_connected(cleaned))

    def test_only_source_less_zero_degree_artifacts_are_removed(self):
        graph = nx.DiGraph()
        graph.add_node("module", label="demo.ts", source_file="src/demo.ts")
        graph.add_node("alias", label="public.assets", source_file="")
        graph.add_node("ref_package", label="external", source_file="")
        graph.add_edge("module", "ref_package", relation="imports_from", _src="module", _tgt="ref_package")
        cleaned, removed = refresh.connect_inventory(graph, ["src/demo.ts"])
        self.assertEqual(removed, [{"id": "alias", "label": "public.assets"}])
        self.assertIn("ref_package", cleaned)
        self.assertEqual(cleaned.nodes["ref_package"]["file_type"], "reference")
        self.assertEqual(cleaned.edges["file:src/demo.ts", "ref_package"]["_src"], "file:src/demo.ts")

    def test_generated_sources_and_unowned_components_fail(self):
        graph = nx.DiGraph()
        graph.add_node("noise", label="nodes", source_file="pkg.json")
        with self.assertRaisesRegex(ValueError, "outside the code inventory"):
            refresh.connect_inventory(graph, ["src/demo.ts"])
        graph = nx.DiGraph()
        graph.add_edge("unowned1", "unowned2")
        with self.assertRaisesRegex(ValueError, "disconnected component"):
            refresh.connect_inventory(graph, ["src/demo.ts"])

    def test_inventory_cleanup_is_idempotent(self):
        graph = nx.DiGraph()
        graph.add_node("symbol", label="helper", source_file="src/demo.ts")
        first, _ = refresh.connect_inventory(graph, ["src/demo.ts"])
        second, _ = refresh.connect_inventory(first, ["src/demo.ts"])
        self.assertEqual(set(first.nodes), set(second.nodes))
        self.assertEqual(set(first.edges), set(second.edges))

    def test_node_builtins_are_references_not_local_source_files(self):
        graph = nx.DiGraph()
        graph.add_node("module", label="demo.ts", source_file="src/demo.ts")
        graph.add_node("web", label="node:stream/web", source_file="node:stream/web")
        graph.add_edge("module", "web", relation="imports_from")
        cleaned, _ = refresh.connect_inventory(graph, ["src/demo.ts"])
        self.assertEqual(cleaned.nodes["web"]["source_file"], "")
        self.assertEqual(cleaned.nodes["web"]["external_module"], "node:stream/web")


if __name__ == "__main__":
    unittest.main()
