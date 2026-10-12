# FireAfter baseline and reuse inventory

Inspection date: October 11, 2026. Code references are repository-relative in this document.

**Git source:** https://github.com/vijay-v-bhoyar/FireAfter.git. Both observed local HEAD and remote refs/heads/main are 6c7b7d62b7a7a2f91fe2b7a370ad6c37d73f9b6c. This is an identity observation, not a complete regression run or proof that deployed bytes equal that commit.

**Local dirty work:** graphify-out/GRAPH_REPORT.md, graphify-out/graph.html, graphify-out/graph.json, pkg.json, public/code-graph.html, dashboard code/test, queue-dashboard-server code/test, and untracked docs/submission-evidence-2026-10-09.md. Dashboard/queue changes distinguish not-found, access-denied and unavailable saved incidents. Source fingerprints are retained in [source-baseline.json](evidence/source-baseline.json). No changes were made to FireAfter.

**Graph:** 2,990 nodes; structural code/config/test coverage. A focused query matched common/test symbols and was insufficient for ownership conclusions; pkg.json and named source reads supplied the implementation map. Stored graph metadata reports the current HEAD and a dirty source digest; that digest was not independently recomputed. No runtime behavior is inferred from graph edges.

**Public observations on October 11, 2026:**

| Surface | Observed | What remains unproven |
| --- | --- | --- |
| Homepage / | No incident selected; unavailable data; zero current/limited source rows; public refresh disabled | Successful automatic onboarding and fresh incident creation |
| /features | Six stages and 25 capabilities; implementation/source/operator labels | Whether every capability works on a particular live incident |
| Saved Los Angeles queue | 534 items; page shows 10; 0 current and 12 limited sources; Grande selected; visible cards Unknown; public refresh/fire selection disabled | Full-county coverage, current hazard ranking, authenticated actions |
| Saved incident evidence | No current validated basin-to-asset matches; visible card source age about 94 days | Operational suitability or safe inspection routing |
| Settings | Read-only session; MTBS boundary-only warning; hydro inventory capacity failure; bridge deadline failure; 4 decisions/13 audit events in coverage panel | New authenticated read/write and recovery rehearsal |
| Visual layout | Dark green shell, cream workspace, orange highlights, incident header, left navigation, status cards | Accessibility conformance across all devices/states |

Browser observations prove those pages rendered for this public session. They do not establish global availability, backend root causes, source truth, or hazard accuracy. Internal health numbers are application diagnostics and must not become judge scores or agency approval.

**Novelty boundary:** FireAfter already narrates changes to queue positions, screening values and source state between refreshes. src/lib/live-sources.ts buildChangedSinceRefreshMessage and src/lib/feature-graph.ts change-narration document that behavior. Sentinel adds versioned external-notice interpretation, explicit claim-to-plan dependencies, conflict handling, generation-fenced review/approval, and crew-constrained inspection proposals. Do not market basic change narration as newly invented.

| Existing capability | Source catalog status | Sentinel disposition |
| --- | --- | --- |
| County discovery and saved incidents | Implemented | Retain; improve intentional demo entry |
| Protected responder access | Implemented | Retain organization/role checks; isolate demo workspaces |
| Published fire selection | Source-dependent | Retain server revalidation and audit |
| Public-source integration | Source-dependent | Retain; add official-document retrieval |
| Background ingestion and progress | Operator configuration | Retain only after new-target verification |
| Weather outlook and alerts | Source-dependent | Retain measured inputs and availability |
| Terrain and burn-context checks | Source-dependent | Retain boundary/severity distinction |
| Freshness and missing-evidence checks | Implemented | Extend to document/claim/plan dependencies |
| Saved asset inventory and paging | Implemented | Retain revision-scoped bounded paging |
| Source-backed map layers | Source-dependent | Retain exact coverage/disclosure semantics |
| Inferred crossing discovery | Source-dependent | Retain candidate labels, not verified culverts |
| Local knowledge upload | Implemented | Retain validation and user-data isolation |
| USGS basins and asset linkage | Source-dependent | Retain identity/geometry/time restrictions |
| Explainable ranked action queue | Source-dependent | Retain Unknown; separate inspection priority |
| Queue search, filters, and pages | Implemented | Retain ordering and scope |
| Published USGS hazard review | Source-dependent | Retain design-storm interpretation |
| Change narration | Implemented | Retain; extend with document/plan lineage |
| Human decisions with audit | Implemented | Extend to plan revisions and stale approval rejection |
| Retained evidence and audit history | Implemented | Retain immutable decision-time evidence |
| Interrupted-write recovery | Implemented | Extend to Sentinel commands/jobs |
| GIS interoperability | Implemented | Retain; add versioned briefing |
| Sensitive-infrastructure redaction | Implemented | Apply to every new payload/export/trace |
| Operational health and product checks | Implemented | Extend with provider and plan-state checks |
| Scheduled refresh and worker recovery | Operator configuration | Verify worker/leases on independent target |
| Large-county delivery controls | Operator configuration | Preserve bounded behavior; qualify supported scope |

The catalog labels are source assertions, not fresh acceptance results. See src/lib/feature-graph.ts for implementation and test links.

**Reuse map:** types.ts and fireafter-data.ts for incident/evidence envelopes; scoring.ts for deterministic screening; source-freshness.ts for current-evidence projection; fireafter-supabase.ts for scope/persistence; audit.ts and responder-command for commands/receipts; dashboard/map/history components for UX; ingestion-worker/workflows for durable contracts. Avoid treating fireafter-store.ts's fixture storage as production persistence.

**Local import and remaining acceptance:** 444 tracked working-tree files, including reviewed dirty fixes, have been copied; exact hashes and exclusions are retained in [provenance](../PROVENANCE.md) and the source record. Preserve original provenance, resolve absent project license and third-party notices, verify imported destinations/metadata and run baseline checks in this new repository. Several migrations are local candidates; installation must be verified on a fresh test target.
