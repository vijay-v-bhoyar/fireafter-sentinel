"""Refresh only the judge-presentation source and documentation graph scope."""
import json
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory

from graphify.build import build_merge
from graphify.cluster import cluster, label_communities_by_hub, score_all
from graphify.export import to_html, to_json
from graphify.extract import extract
from graphify.report import generate

root = Path(__file__).resolve().parent.parent
graph_path = root / "graphify-out/graph.json"
old = json.loads(graph_path.read_text(encoding="utf-8-sig"))
roles = {
    "scripts/verify-browser-smoke.mjs": "Release-bound browser smoke harness; validates same-origin incident-scoped queue/map navigation, browser Back and feature graph round trips rather than obsolete unscoped hrefs. Agent live verification uses the approved CUA browser surface, not this harness.",
    "docs/features.md": "October 6 audited eleven-feature guide; implemented behavior, dated October 2 deployed proof, ownership boundaries, unverified uploads, missing severity, and incomplete live/field acceptance are separate.",
    "src/app/features/page.tsx": "Public request-time feature guide: validates an optional single incidentId and passes it to navigation without auth, incident loading or live-source dependencies. Invalid references never silently substitute the default county.",
    "src/app/features/page.test.tsx": "Public unscoped availability, initial server-rendered county links and invalid-reference rejection with auth and incident-data imports forbidden.",
    "src/components/feature-graph.tsx": "Accessible interactive feature graph with pointer/keyboard selection and county-scoped return and feature links; documentation/code links remain unscoped and dashboard prefetch is disabled.",
    "src/components/feature-graph.test.tsx": "Feature detail rendering, pointer/keyboard selection, all eleven nodes' scoped app links, unscoped documentation links and encoded incident query safety.",
    "src/lib/source-line-geometry.ts": "Complete multipart geometry validation with distinct failed-acquisition and malformed/legacy states. Canonical empty failure envelopes produce no geometry or inferred crossings; stored provider detail remains intact and contradictory failure-plus-geometry payloads fail closed.",
    "src/lib/source-line-geometry.test.ts": "Multipart geometry, failed acquisition, contradictory status, immutable provider-detail projection, legacy rejection and inferred-version regressions.",
    "src/lib/fireafter-data.ts": "Authorized/redacted client bundle service. Heavy raw geometry remains server-side; compaction retains only the known MTBS interpretation marker so browser freshness checks preserve boundary-only limitations rather than invent a legacy state.",
    "src/lib/fireafter-data.test.ts": "Client compaction/privacy, immutable server context, MTBS JSON/freshness round-trip and unknown-marker rejection contracts.",
    "src/components/fireafter-freshness.test.tsx": "Rendered clock expiry and source provenance, including server-compacted MTBS context surviving browser freshness ticks without claiming measured severity.",
    "src/app/api/map/features/route.test.ts": "Complete map transport, geometry topology, role-aware sensitive projection and failed-hydro warnings that preserve valid road/basin collections.",
    "src/lib/source-coverage.ts": "Evidence-backed source category coverage. Uploaded local records are present but unverified/Low confidence; format validation never establishes field accuracy.",
    "src/lib/source-coverage.test.ts": "Coverage classification, reachable no-coverage sources and explicit uploaded-record confidence limitations.",
    "src/components/incident-dashboard-page.tsx": "Shared server route renderer: await and validate a single incidentId query, retain the pinned default only when unscoped, load through the existing authorized/redacted bundle boundary, and key client state by incident identity.",
    "src/app/page.tsx": "Queue route resolves the explicit incidentId query via the shared server renderer; unscoped visits retain the configured demo default.",
    "src/app/map/page.tsx": "Map route retains the explicitly selected incident across navigation and reload.",
    "src/app/assets/page.tsx": "Asset route retains the explicitly selected incident across navigation and reload.",
    "src/app/settings/page.tsx": "Settings route retains the explicitly selected incident across navigation and reload.",
    "src/app/page.test.tsx": "Seventeen route tests: scoped and default reads, invalid-reference rejection, unavailable scoped data, and keyed incident identity across four workspace pages.",
    "src/components/history-explorer.tsx": "Private paginated retained history with incident-scoped return links; no current-inventory dependency for retained evidence reads.",
    "src/components/history-explorer.test.tsx": "History pagination, recovery, late-response isolation and incident-scoped return-link tests.",
    "src/lib/pwfdf-geometry.ts": "Full-resolution basin topology v2: lossless splitting at identical Esri self-touch vertices, strict crossing/overlap rejection, bounded edge sweep, exact predicates and immutable prepared containment; 100000 shared vertices and unchanged 2000000 work limit.",
    "src/lib/pwfdf-geometry.test.ts": "Topology, lossless vertex contacts, crossing/retrace rejection, exact subnormal predicates, immutable containment and shared capacity boundary tests.",
    "src/lib/pwfdf-provider-regression.test.ts": "Offline full197-feature Plaskett capture: exact edge preservation, independent even-odd containment oracle, complete persistence round-trip and 1000-asset capacity; no production fallback.",
    "src/test/fixtures/plaskett-pwfdf-20261002.json.gz": "Losslessly compressed complete public USGS response for offline regression only; never loaded by the app.",
    "src/test/fixtures/plaskett-pwfdf-20261002.provenance.json": "Public capture source URL, timestamp, SHA256, 197 features and 39631 input vertices.",
    "scripts/capture-pwfdf-regression.mjs": "Reproducible offline fixture capture requiring exact public-response SHA256 and all197 features before lossless compression.",
    "src/lib/pwfdf.ts": "Provider assessment resolution, complete basin parsing and snapshot reload; bounded prepared containment links real assets only to validated published basins.",
    "src/lib/product-promise.ts": "Evidence-based product checks with independently revalidated source-linked basin containment and shared operation budgets; missing evidence stays incomplete.",
    "src/lib/recommendation-order.ts": "Canonical review queue comparator: Unknown evidence first, scores descending, stable normalized-name and domain-identity tie breaks shared by generation, previous-rank comparison, persistence hydration and freshness projection.",
    "src/lib/recommendation-order.test.ts": "Deterministic tied-score ordering and Unknown-first review priority contracts.",
    "src/lib/source-freshness.ts": "Clock-based evidence projection with canonical deterministic queue ordering and shared MTBS interpretation marker; boundary context never supplies burn severity and expired evidence remains Unknown, not low risk.",
    "src/lib/source-freshness.test.ts": "Freshness expiry and provider-publication provenance contracts including tied queue ordering across expiry.",
    "src/lib/fireafter-supabase.test.ts": "Persistence identity, atomic-write and hydration contracts including provider-error detail preservation and canonical tied queue ordering independent of database row order.",
    "supabase/migrations/20261002010000_bulk_bundle_capacity.sql": "Forward capacity-only migration: bulk bundle/import statements bounded at 30 seconds, unchanged body hashes, ownership, grants, fencing and audit controls; exact new probe version 20261002010000.",
    "src/lib/refresh-operation.ts": "Root refresh lifecycle with cancellation, a 120-second deadline, four admitted operations/four requests per operation, 512 requests and a default 96-MiB cumulative inbound budget covering previous inventory, acquisition and committed readback.",
    "src/lib/stream-json-response.ts": "Validated complete JSON streamed in 64-KiB chunks with cancellation and a 64-MiB response budget; avoids buffered map response limits without geometry truncation.",
    "src/lib/stream-json-response.test.ts": "Complete multi-megabyte response equality, bounded chunks, private no-store delivery and cancellation tests.",
    "src/app/api/map/features/route.ts": "Full source-backed vector map with role-aware sensitive asset projection and private streamed JSON delivery.",
    "src/lib/source-payload-storage.ts": "Lossless integrity-checked gzip source storage, legacy JSON compatibility, malformed-evidence rejection and bounded decompression; no geometry truncation.",
    "src/lib/source-payload-storage.test.ts": "Complete geometry round-trip, corrupted envelopes and aggregate decompression budget regression tests.",
    "src/lib/supabase.ts": "Bounded Supabase transport: admin bundle/import POSTs receive 40 seconds; source reads receive 20 seconds/16 MiB. Canonical same-origin admin asset/recommendation inventory GETs receive 20 seconds/eight MiB with safe operation labels; ordinary reads/auth retain five seconds. Thirty-second whole-inventory and root refresh limits remain enforced.",
    "src/lib/supabase-inventory-transport.test.ts": "Real isolated HTTP and Supabase SDK tests: complete delayed bodies beyond five seconds, unscaled twenty-second timeout, ordinary-read timeout, byte limit and caller cancellation without partial data or retries.",
    "src/lib/fireafter-supabase.ts": "Atomic authorized bundle persistence, inventory-fenced readback, and losslessly compressed large source snapshots; safe payload-size diagnostics without raw data.",
    "src/components/fireafter-dashboard.tsx": "County/action dashboard with incident-scoped workspace and feature-tour links, wrapping account-role text, read-only asset search, USGS evidence filtering, incremental complete-queue access and original ranks; existing command recovery, mutation guard, source loading, named import confirmation and sensitive projection.",
    "src/components/fireafter-command.test.tsx": "Incident-scoped navigation including feature tour, wrapping account-role text, honest boundary-only MTBS integration copy, complete-queue access and evidence/search filtering without writes; responder command recovery and duplicate live-data mutation prevention.",
    "src/lib/live-county-diagnostic.test.ts": "Opt-in real Okanogan provider acquisition with local payload-size measurements; no database writes and no credentials.",
    "src/lib/elevation-batch.ts": "Bounded real USGS 3DEP multipoint elevation acquisition for complete county inventories: point identity/coordinate/CRS validation, explicit NoData, four workers, 64-point batches, cancellation and redacted telemetry.",
    "src/lib/elevation-batch.test.ts": "Batch elevation completeness, point attribution, malformed/no-data evidence, 2000-point scaling and real transport cancellation contracts.",
    "src/lib/live-sources.ts": "Live public-source ingestion with complete county inventory and canonical queue order. Optional 3DEP aggregate timeout discards every new slope sample while retaining full inventory with Unknown risk; invalid evidence and root cancellation/deadline still reject. USGS evidence retains legacy usgs-epqs group key with actual provider name and URL.",
    "src/lib/live-sources.test.ts": "Live source orchestration, full asset inventory, terrain acquisition and fail-closed refresh regressions.",
    "src/lib/inventory-error.ts": "Safe typed inventory, deadline and invalid/unavailable batch-elevation errors; no partial refresh accepted.",
    "docs/architecture.md": "October 6 reviewed architecture and data flow: bounded acquisition, complete geometry, v4 screening, atomic persistence and role-scoped projections. Optional degradation is distinguished from refresh rejection, and normalized fire-name association is not authoritative identity.",
    "scripts/build-judge-deck.cjs": "Nine-slide judge PowerPoint builder using dated privacy-safe October 2 captures and verified audit-note excerpt; canonical timed notes, contained image sizing, fail-closed rehearsal footer, and explicit incomplete full-feature certification.",
    "scripts/refresh-judge-graph.py": "Scoped AST and document-heading refresh for judge presentation sources, tests and documentation; unrelated semantic claims are preserved without revalidation.",
    "src/lib/judge-presentation.test.ts": "Five tests covering canonical timed notes, missing/duplicate sections, fail-closed rehearsal status, exact retained note and prevention of stale failed-load or uploaded-confidence claims.",
    "docs/demo-script.md": "Presenter-only timed script with nine preserved narration sections; October 6 review dates October 2 Monterey/Okanogan proof, differentiates earlier and final elevation failures, and keeps incomplete feature certification explicit. Public edition is untimed.",
    "docs/FireAfter-Judge-Presentation.pptx": "Thirteen-slide recording edition: nine timed main slides and four editable architecture/data-flow/feature/validation appendices. Dated 12:40 UTC captures and separate17:50 live recheck; original base preserved privately. Full-feature and field certification remain incomplete.",
    "scripts/build-recording-kit.mjs": "Imports preserved nine-slide base using bundled Artifact Tool, synchronizes canonical notes, updates scoped text and appends four editable judge appendices. Finalizes a separately versioned thirteen-slide deck with structural/font/import validation.",
    "docs/recording-kit-2026-10-02.md": "Five-minute presenter preflight, scoped workspace links, shot list, honest dated fallback, privacy and final audio/video playback checks. No MP4 or competition-compliance claim.",
    "docs/judge-qa-2026-10-02.md": "Evidence-based judge answers on differentiation, deterministic scoring, unknown risk, basin identity, provider failure, county reuse, privacy, imports and proposed responder validation.",
    "docs/model-card.md": "Current deterministic v4 review model: normalized relative hazard weights, confidence kept separate, boundary-only MTBS and explicit missing measured severity. No calibrated prediction or field validation claim.",
    "docs/system-manifest.md": "October 6 reviewed system manifest: deployed surfaces, six required security controls, October 2 selected-workflow receipts, daily-cron freshness limits and unverified cost/scale boundaries; historical observations are not current release authority.",
    "docs/production-release-runbook.md": "Operator-only release controls with exact-target identity, ordered SQL/Auth, credentials, workflow, rollback and recovery gates; supersedes the September empty-workspace observation with scoped October 2 proof without closing remaining assurance gates.",
    "docs/field-validation.md": "Proposed agency-led retrospective evaluation: independently adjudicated assets, matched tasks, uncertainty comprehension, error/time measures, privacy and consent. No completed study, measured benefit or endorsement claimed.",
    "docs/rubric-map.md": "Five judge evidence themes with implementation, dated evidence, limits and inspectable links. Official scoring weights, eligibility, prize allocation and submission requirements are not established by this mapping.",
    "docs/submission-evidence-2026-10-06.md": "Cross-document evidence ledger separating implemented controls, dated October 2 deployed/test proof, October 6 expired-source observation and remaining agency/operational gates; public access and safe attachment boundaries.",
    "output/pdf/FireAfter-IEEE-Submission-Brief.pdf": "Twelve-page untimed visual submission brief, dated Monterey evidence, architecture/data flow, public access and honest pilot boundaries; no credentials or authenticated export.",
    "output/pdf/FireAfter-IEEE-Technical-Support.pdf": "Seven-page plain-language product and technical overview: actual features, source coverage, architecture, scoring, engineering controls and dated Monterey test results. No review commentary, internal release IDs, probe versions, presenter timing or competition strategy. PDF and packaged copy must be regenerated together after content changes.",
    "output/submission/FireAfter-IEEE-Judge-Submission-Pack.zip": "Public attachment pack: two PDFs, eight curated judge Markdown editions, evidence ledger, README and SHA256 manifest. Not a source archive or operational certification.",
    "docs/FireAfter-Judge-Presentation-2026-10-02.pdf": "Thirteen-page rendered-slide offline backup of the verified recording deck; editable source remains PowerPoint.",
    "docs/judge-material-verification-2026-10-02.md": "Local slide/video evidence, privacy and remaining acceptance report: nine rendered slides and 180-second sampled runtime pass; final MP4 approval/render/playback still pending. Artifact drift is not evidence of new production verification.",
    "docs/demo-rehearsal-2026-10-02.md": "Chronological deployed county creation, refresh, geometry, queue, export and retained audit evidence with exact release identities, recorded review-only note, source gaps and remaining unverified feature paths.",
    "src/app/history/page.tsx": "Incident-scoped private retained history independent of current inventory; unscoped entry resolves the dashboard's actual incident or unavailable workspace without inventing a county. Public users retain redacted previews.",
    "src/app/history/page.test.tsx": "Private retained-history independence, invalid input, actual default incident resolution, unavailable workspace, and redacted public preview routing.",
}
sources = [name for name in roles if name.endswith((".cjs", ".mjs", ".py", ".ts", ".tsx"))]
docs = [name for name in roles if name.endswith(".md")]
data = extract([root / name for name in sources + docs], root=root, cache_root=root, parallel=False,
               resolution_context_nodes=old["nodes"], resolution_context_edges=old["links"])
# Retire only the duplicate heading IDs created by the first scoped refresh.
# Markdown is supported structurally; its fresh AST replaces the older headings.
duplicates = {node["id"] for node in old["nodes"]
              if node.get("source_file") in docs and node["id"].startswith("judge_docs_")}
baseline = {**old, "nodes": [node for node in old["nodes"] if node["id"] not in duplicates],
            "links": [edge for edge in old["links"]
                      if edge["source"] not in duplicates and edge["target"] not in duplicates]}
with TemporaryDirectory(prefix="fireafter-judge-graph-") as temporary:
    baseline_path = Path(temporary) / "graph.json"
    baseline_path.write_text(json.dumps(baseline), encoding="utf-8")
    graph = build_merge([data], graph_path=baseline_path, root=root,
                        directed=old.get("directed", False), dedup=False)
pkg_path = root / "pkg.json"
pkg = json.loads(pkg_path.read_text(encoding="utf-8-sig"))
for name, role in roles.items():
    node = next((node for node in pkg["nodes"] if node.get("id") == "file:" + name), None)
    if node is None:
        node = {"id": "file:" + name, "type": "[File]", "path": name}
        pkg["nodes"].append(node)
    node["role"] = role

feature_component = next(node for node in pkg["nodes"] if node["id"] == "component:FeatureGraph")
feature_component["props"] = "{ incidentId?: string }; validated by the public route and encoded into same-origin app links only."

relations = [
    ("src/app/features/page.test.tsx", "src/app/features/page.tsx", "[tests]"),
    ("src/app/features/page.tsx", "src/components/feature-graph.tsx", "[renders]"),
    ("src/components/feature-graph.test.tsx", "src/components/feature-graph.tsx", "[tests]"),
    ("src/components/feature-graph.tsx", "src/lib/feature-graph.ts", "[imports]"),
    ("src/lib/source-line-geometry.test.ts", "src/lib/source-line-geometry.ts", "[tests]"),
    ("src/app/api/map/features/route.test.ts", "src/lib/source-line-geometry.ts", "[tests]"),
    ("src/lib/fireafter-data.test.ts", "src/lib/source-freshness.ts", "[tests]"),
    ("src/components/fireafter-freshness.test.tsx", "src/lib/fireafter-data.ts", "[imports]"),
    ("src/lib/source-coverage.test.ts", "src/lib/source-coverage.ts", "[tests]"),
    ("src/components/incident-dashboard-page.tsx", "src/lib/fireafter-data.ts", "[imports]"),
    ("src/components/incident-dashboard-page.tsx", "src/components/fireafter-dashboard.tsx", "[renders]"),
    ("src/app/page.test.tsx", "src/components/incident-dashboard-page.tsx", "[tests]"),
    ("src/components/history-explorer.test.tsx", "src/components/history-explorer.tsx", "[tests]"),
    ("src/lib/pwfdf-provider-regression.test.ts", "src/lib/pwfdf-geometry.ts", "[tests]"),
    ("src/lib/pwfdf-provider-regression.test.ts", "src/lib/pwfdf.ts", "[tests]"),
    ("src/lib/pwfdf-provider-regression.test.ts", "src/test/fixtures/plaskett-pwfdf-20261002.json.gz", "[reads]"),
    ("src/lib/pwfdf-provider-regression.test.ts", "src/test/fixtures/plaskett-pwfdf-20261002.provenance.json", "[reads]"),
    ("scripts/capture-pwfdf-regression.mjs", "src/test/fixtures/plaskett-pwfdf-20261002.json.gz", "[writes]"),
    ("src/lib/live-sources.ts", "src/lib/pwfdf-geometry.ts", "[imports]"),
    ("src/lib/product-promise.ts", "src/lib/pwfdf-geometry.ts", "[imports]"),
    ("src/lib/live-sources.ts", "src/lib/recommendation-order.ts", "[imports]"),
    ("src/lib/fireafter-supabase.ts", "src/lib/recommendation-order.ts", "[imports]"),
    ("src/lib/source-freshness.ts", "src/lib/recommendation-order.ts", "[imports]"),
    ("src/lib/recommendation-order.test.ts", "src/lib/recommendation-order.ts", "[tests]"),
    ("src/lib/operational-write-security.ts", "supabase/migrations/20261002010000_bulk_bundle_capacity.sql", "[depends_on]"),
    ("src/app/api/map/features/route.ts", "src/lib/stream-json-response.ts", "[imports]"),
    ("src/lib/stream-json-response.test.ts", "src/lib/stream-json-response.ts", "[tests]"),
    ("src/lib/fireafter-supabase.ts", "src/lib/source-payload-storage.ts", "[imports]"),
    ("src/lib/source-payload-storage.test.ts", "src/lib/source-payload-storage.ts", "[tests]"),
    ("src/lib/live-county-diagnostic.test.ts", "src/lib/live-sources.ts", "[tests]"),
    ("src/lib/live-sources.ts", "src/lib/elevation-batch.ts", "[imports]"),
    ("src/lib/elevation-batch.ts", "src/lib/refresh-operation.ts", "[imports]"),
    ("src/lib/elevation-batch.ts", "src/lib/inventory-error.ts", "[imports]"),
    ("src/lib/elevation-batch.test.ts", "src/lib/elevation-batch.ts", "[tests]"),
    ("scripts/build-judge-deck.cjs", "docs/demo-script.md", "[reads]"),
    ("scripts/build-judge-deck.cjs", "docs/FireAfter-Judge-Presentation.pptx", "[writes]"),
    ("src/lib/judge-presentation.test.ts", "scripts/build-judge-deck.cjs", "[validates]"),
    ("src/lib/judge-presentation.test.ts", "docs/demo-script.md", "[validates]"),
    ("src/lib/judge-presentation.test.ts", "docs/demo-rehearsal-2026-10-02.md", "[validates]"),
    ("docs/judge-material-verification-2026-10-02.md", "docs/FireAfter-Judge-Presentation.pptx", "[documents]"),
    ("docs/judge-material-verification-2026-10-02.md", "docs/demo-script.md", "[references]"),
    ("docs/demo-script.md", "src/lib/scoring.ts", "[depends_on]"),
    ("docs/demo-script.md", "src/lib/feature-graph.ts", "[references]"),
    ("scripts/refresh-judge-graph.py", "scripts/build-judge-deck.cjs", "[reads]"),
    ("src/app/history/page.tsx", "src/lib/fireafter-data.ts", "[imports]"),
    ("src/app/history/page.test.tsx", "src/app/history/page.tsx", "[tests]"),
]
route_paths = ["src/app/page.tsx", "src/app/map/page.tsx", "src/app/assets/page.tsx", "src/app/settings/page.tsx"]
relations.extend((path, "src/components/incident-dashboard-page.tsx", "[imports]") for path in route_paths)
relations.append(("src/lib/supabase-inventory-transport.test.ts", "src/lib/supabase.ts", "[tests]"))
relations.extend([
    ("scripts/build-recording-kit.mjs", "docs/demo-script.md", "[reads]"),
    ("scripts/build-recording-kit.mjs", "docs/FireAfter-Judge-Presentation.pptx", "[generates]"),
    ("docs/recording-kit-2026-10-02.md", "docs/demo-script.md", "[references]"),
    ("docs/recording-kit-2026-10-02.md", "docs/judge-qa-2026-10-02.md", "[references]"),
    ("docs/judge-qa-2026-10-02.md", "docs/model-card.md", "[references]"),
    ("docs/FireAfter-Judge-Presentation-2026-10-02.pdf", "docs/FireAfter-Judge-Presentation.pptx", "[depends_on]"),
])
submission_docs = ["docs/" + name + ".md" for name in (
    "model-card", "system-manifest", "architecture", "features", "demo-script",
    "production-release-runbook", "field-validation", "rubric-map")]
for path in submission_docs:
    relations.extend([
        (path, "docs/submission-evidence-2026-10-06.md", "[references]"),
        ("output/pdf/FireAfter-IEEE-Technical-Support.pdf", path, "[depends_on]"),
    ])
relations.extend([
    ("docs/submission-evidence-2026-10-06.md", "docs/demo-rehearsal-2026-10-02.md", "[references]"),
    ("output/submission/FireAfter-IEEE-Judge-Submission-Pack.zip", "output/pdf/FireAfter-IEEE-Technical-Support.pdf", "[depends_on]"),
    ("output/submission/FireAfter-IEEE-Judge-Submission-Pack.zip", "output/pdf/FireAfter-IEEE-Submission-Brief.pdf", "[depends_on]"),
])
inventory_function = "function:src/lib/supabase.ts#inventoryReadOperation"
inventory_role = "Classifies only canonical bounded same-origin-admin inventory query shapes for safe transport timing; no authorization or database side effects."
if not any(node["id"] == inventory_function for node in pkg["nodes"]):
    pkg["nodes"].append({"id": inventory_function, "type": "[Function]", "path": "src/lib/supabase.ts", "role": inventory_role})
inventory_index = next((item for item in pkg["functionIndex"] if item["file"] == "src/lib/supabase.ts"), None)
if inventory_index and not any(item["id"] == inventory_function for item in inventory_index["functions"]):
    inventory_index["functions"].append({"id": inventory_function, "type": "[Function]", "exported": False,
        "signature": "inventoryReadOperation(url: URL)", "returns": "asset_inventory_read | recommendation_inventory_read | null", "sideEffects": "None. " + inventory_role})
inventory_edge = {"from": "file:src/lib/supabase.ts", "to": inventory_function, "type": "[calls]"}
if inventory_edge not in pkg["edges"]:
    pkg["edges"].append(inventory_edge)
# These routes no longer import or call the bundle reader directly.
pkg["edges"] = [edge for edge in pkg["edges"] if not (
    edge["from"] in {"file:" + path for path in route_paths}
    and edge["to"] in {"file:src/lib/fireafter-data.ts", "file:src/components/fireafter-dashboard.tsx",
                        "function:src/lib/fireafter-data.ts#getClientDashboardBundle"})]
renderer_id = "function:src/components/incident-dashboard-page.tsx#renderIncidentDashboard"
if not any(node["id"] == renderer_id for node in pkg["nodes"]):
    pkg["nodes"].append({"id": renderer_id, "type": "[Function]", "path": "src/components/incident-dashboard-page.tsx",
                         "role": "Validate the requested incident and render its authorized/redacted dashboard without silently selecting another county."})
for edge in [
    {"from": renderer_id, "to": "function:src/lib/fireafter-data.ts#getClientDashboardBundle", "type": "[calls]"},
    *[{"from": "file:" + path, "to": renderer_id, "type": "[calls]"} for path in route_paths],
]:
    if edge not in pkg["edges"]:
        pkg["edges"].append(edge)
line_function_roles = {
    "readSourceLineGeometry": "Requires complete versioned multipart features; explicitly failed acquisitions return no features with unavailable guidance, while contradictory, malformed or legacy collections retain invalid-geometry guidance.",
    "projectSourceLineGeometry": "Preserves real provider-error details and offline/error state for canonical failed retrievals; legacy geometry remains unavailable and stored evidence is immutable.",
    "isFailedLineAcquisition": "Recognizes only empty failed-retrieval envelopes without any geometry fields or a completeness claim.",
}
for name, role in line_function_roles.items():
    identity = "function:src/lib/source-line-geometry.ts#" + name
    node = next((node for node in pkg["nodes"] if node["id"] == identity), None)
    if node is None:
        node = {"id": identity, "type": "[Function]", "path": "src/lib/source-line-geometry.ts"}
        pkg["nodes"].append(node)
    node["role"] = role
    index = next(item for item in pkg["functionIndex"] if item["file"] == "src/lib/source-line-geometry.ts")
    entry = next((item for item in index["functions"] if item["id"] == identity), None)
    if entry is None:
        entry = {"id": identity, "type": "[Function]", "exported": False,
                 "signature": "isFailedLineAcquisition(payload)", "returns": "boolean"}
        index["functions"].append(entry)
    entry["sideEffects"] = "None. " + role
line_edge = {"from": "function:src/lib/source-line-geometry.ts#readSourceLineGeometry",
             "to": "function:src/lib/source-line-geometry.ts#isFailedLineAcquisition", "type": "[calls]"}
if line_edge not in pkg["edges"]:
    pkg["edges"].append(line_edge)
for source, target, relation in relations:
    edge = {"from": "file:" + source, "to": "file:" + target, "type": relation}
    if edge not in pkg["edges"]:
        pkg["edges"].append(edge)
    left = next((n for n, d in graph.nodes(data=True) if d.get("source_file") == source), None)
    right = next((n for n, d in graph.nodes(data=True) if d.get("source_file") == target), None)
    if left and right:
        graph.add_edge(left, right, relation=relation.strip("[]"), confidence="EXTRACTED", source_file=source)
pkg["generatedAt"] = datetime.now(timezone.utc).isoformat()
pkg_path.write_text(json.dumps(pkg, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
communities = cluster(graph)
removed = [node for node in old["nodes"] if node["id"] not in graph]
unexpected = [node["id"] for node in removed if node.get("source_file") not in sources + docs]
if unexpected:
    raise RuntimeError(f"Scoped refresh removed unrelated nodes: {unexpected}")
print(json.dumps({"removedWithinReextractedScope": [{"id": node["id"], "file": node.get("source_file")} for node in removed]}))
if to_json(graph, communities, graph_path, built_at_commit=old.get("built_at_commit"), force=bool(removed)) is False:
    raise RuntimeError("Graph export refused a shrink; inspect the scoped diff before proceeding")
to_html(graph, communities, root / "graphify-out/graph.html")
report = generate(graph, communities, score_all(graph, communities), label_communities_by_hub(graph, communities),
                  [], [], {"warning": "Scoped judge presentation AST/document refresh; unrelated semantic claims not revalidated."},
                  {"input": 0, "output": 0}, str(root), built_at_commit=old.get("built_at_commit"))
(root / "graphify-out/GRAPH_REPORT.md").write_text(report, encoding="utf-8")
print(json.dumps({"nodes": graph.number_of_nodes(), "edges": graph.number_of_edges(), "scope": list(roles)}))
