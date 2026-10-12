# FireAfter Sentinel

Final planning set. Sentinel is a separate FireAfter-derived app with its own repository, hosting app and fresh database/auth/storage. Existing FireAfter remains untouched. The reviewed 444-file baseline is imported locally; the complete product is not yet accepted or deployed. [Provenance](PROVENANCE.md) records inherited and new work. The [decision register](docs/DECISIONS_AND_BUILD_GATE.md) is the sole owner of current implementation status and verification results.

**Promise:** when official evidence changes, show which inspection proposals need review, explain why and let a coordinator record a revised plan with retained evidence.

## Read order and topic ownership

| Order | Final document | Owns |
| --- | --- | --- |
| 1 | [Build plan](BUILD_PLAN.md) | Dependency-driven execution, effort and checkpoints |
| 2 | [Strategy](docs/PRODUCT_STRATEGY.md) | Buyer/workflow, defensibility, pilot falsifiers and typed seeds |
| 3 | [Product requirements](docs/PRODUCT_REQUIREMENTS.md) | Complete supported scope and extensions |
| 4 | [Resource isolation](docs/PROJECT_ISOLATION.md) | Protected FireAfter boundaries and new target admission |
| 5 | [Baseline](docs/FIREAFTER_BASELINE.md) and [provenance](PROVENANCE.md) | Dated source observations, all 25 inherited capabilities and actual new-work disclosure |
| 6 | [UX](docs/UX_SPEC.md) | Screens, rendered states, reviewer interactions and wireframes |
| 7 | [Architecture](docs/ARCHITECTURE.md) | Runtime, proposed modules, persistence, locks, dispatch and numerical ceilings |
| 8 | [Data/API contracts](docs/DATA_AND_API_CONTRACTS.md) | Records/routes/roles, feedback permission and portable briefing fields |
| 9 | [Source/tool contracts](docs/SOURCE_AND_TOOL_CONTRACTS.md) | Registry, Tavily, Nemotron, authority, missingness and modes |
| 10 | [Security](docs/SECURITY_AND_HUMAN_REVIEW.md) | Trust boundaries, privacy, rendering and human authority |
| 11 | [Evaluation](docs/EVALUATION_AND_TEST_PLAN.md) and [red-team plan](docs/RED_TEAM_PLAN.md) | Metrics, required checks, probes, oracles and acceptance evidence |
| 12 | [Domain discovery](docs/DOMAIN_DISCOVERY.md) | Unsent practitioner agenda and unvalidated cognitive judgments |
| 13 | [Operations](docs/OPERATIONS_AND_COST_PLAN.md) | Environments/configuration, cost, recovery and judge availability |
| 14 | [Submission](docs/SUBMISSION_PLAN.md) | Official rules, award eligibility, package/video and freeze protocol |
| 15 | [Decisions/build entry](docs/DECISIONS_AND_BUILD_GATE.md) | Unresolved inputs, authority by phase and actual governed-loop status |

## Structured sources of truth

The pack contains 29 required artifacts: 18 Markdown documents, seven CSV registries, three JSON records and one validator. Generated manifest/validation records are current indexes, not specification versions. No additional final, draft or review pack is required. The current inventory already contains one file per required topic; cleanup removes superseded prose in place. Recoverable originals are held outside this workspace, while execution receipts are retained as evidence.

[requirements.csv](docs/requirements.csv) owns 25 acceptance IDs; [backlog.csv](docs/backlog.csv) owns 24 tasks, current task status, dates, dependencies and provisional hours; [traceability.csv](docs/traceability.csv) binds them to specifications and check IDs. [evaluation_cases.csv](docs/evaluation_cases.csv) contains 39 designed cases; [red_team_probes.csv](docs/red_team_probes.csv) contains 24 designed probes; [cognitive_demands.csv](docs/cognitive_demands.csv) contains 10 hypothesis rows; [hackathon_compliance.csv](docs/hackathon_compliance.csv) maps all 15 official-rules sections through 26 pending obligations.

No target date means completed work. No designed case means a realized labeled corpus or passing test. No planning/check pass means app readiness, security acceptance, entrant eligibility or a winning probability. Source observation dates remain explicit. No field expert interview, real provider call, private-record import, production mutation or submission has occurred.

## Evidence and validation

Keep one authoritative file per topic using the ownership table above. Official rules govern eligibility; requirements.csv and PRODUCT_REQUIREMENTS.md govern scope; architecture and data/API contracts govern their respective implementation details; backlog.csv governs task status/dependencies/dates; DECISIONS_AND_BUILD_GATE.md governs observed verification and pending decisions. Provenance rows are dated history, not a second current status. Resolve a conflict in its owner file and update its dependents in the same batch. Update that file in place and refresh the manifest; do not add numbered, draft, final-final or archived copies inside the planning pack. Recovery archives stay outside the workspace; immutable execution/failure receipts remain outside the planning pack and are not specification versions.

[source-baseline.json](docs/evidence/source-baseline.json) retains selected source fingerprints, source identity and a full working-tree digest; its Sentinel import section retains the exact copied-file manifest, separately from the original-source observations; neither is a production probe. [PLANNING_MANIFEST.json](docs/PLANNING_MANIFEST.json) binds the one final artifact set; [document-validation.json](docs/evidence/document-validation.json) records current executed document checks.

Run `python docs/evidence/validate_documents.py` using the [document validator](docs/evidence/validate_documents.py) to check the pack. The validator uses the Python standard library and read-only Git/source fingerprinting; it does not execute app, provider or database tests. It refreshes only this workspace's manifest and document-validation report. The validator checks the 29 planning artifacts independently of application/dependency files, and rejects extra documents inside docs/ or extra root planning Markdown. AGENTS.md remains a separate required instruction file. pkg.json now identifies this Sentinel checkout and catalogs its implemented helpers, SQL records and final documents. Remaining inherited runtime/semantic edges are provisional. The worker batch has a source-bound structural manifest; document changes are tracked through the final manifest and project-map catalog, not structural source-graph coverage; SQL/document semantics and full-target acceptance still require their explicit checks. The structural graph under graphify-out excludes SQL and document semantics. Refresh its source-bound manifest after coherent code batches before relying on affected edges; current verification is owned by the decision register. SQL procedures and document semantics retain explicit project-map and test traces; graph navigation never proves runtime acceptance. Document links and traceability provide current planning navigation.

For operator onboarding and password rotation, follow the recoverable issuance contract in [operations](docs/OPERATIONS_AND_COST_PLAN.md); retain one attempt UUID across uncertain results.

## Work boundary

Maintain this single final set in place. Implementation uses only this project's files and new named resources. Provider credentials, paid execution, data migration, external publication/submission and outreach require their applicable target/authority; no such step was performed. Use one agent by default and preserve unrelated work.
