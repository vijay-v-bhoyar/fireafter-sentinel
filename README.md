# FireAfter Sentinel

FireAfter Sentinel helps a post-wildfire inspection team review plans when source evidence changes. It connects cited evidence to affected inspection proposals and retains the human decision and its supporting history.

Sentinel is a separate FireAfter-derived local prototype, with its own repository and isolated local database. Hosting and hosted database provisioning are on hold. The reviewed 444-file FireAfter baseline is attributed in [provenance](PROVENANCE.md); a new repository does not make inherited work new. The [decision register](docs/DECISIONS_AND_BUILD_GATE.md) owns current implementation status, verification results and submission blockers.

**Promise:** when official evidence changes, show which inspection proposals need review, explain why and let a coordinator record a revised plan with retained evidence.

## The demonstrated workflow

| Role | Operation |
| --- | --- |
| Analyst | Inspect cited changes and affected assets, prepare crew/task constraints, and prepare or modify a proposal for review. |
| Commander | Check evidence, freshness and constraints; approve, reject or request modification. A modified proposal needs a separate approval. |
| Viewer | Read the resulting briefing and history, preserving the distinction between a draft and a confirmed decision. |

Local automated checks cover real Auth/database persistence, role boundaries, stale-decision protection and opposing-session races using explicitly synthetic records. These checks do not establish field safety or complete human acceptance. The demo supports inspection planning review; it does not authorize emergency action.

The provider integration uses Tavily for source discovery/extraction and NVIDIA Nemotron through Nebius Token Factory for interpretation. A retained authenticated local SDK run completed real retrieval, claims, comparison and publication. The pinned tokenizer preserves complete notice versions under the existing cap; numbered passages retain exact UTF-8 citation spans. A separate current local-development SDK context-crash test resumes the same logical/runtime run without a provider attempt, preserving its checkpoint, deadline and funds. The approved provider-backed incident briefing, practitioner validation and public judge access remain pending. These scoped runs do not prove hosted operation or SDK recovery after a paid provider response. Synthetic demonstrations remain distinct from real provider execution.

Current local execution and blocked complete-case branches are recorded in the [persona control crosswalk](docs/EVALUATION_AND_TEST_PLAN.md#remaining-local-persona-execution--october-15-2026) and decision register.

For testing and adoption: start with the [persona definitions](docs/DOMAIN_DISCOVERY.md#participant-catalog-and-task-context), [end-to-end operations](docs/UX_SPEC.md#end-to-end-persona-operations), then [test protocols](docs/EVALUATION_AND_TEST_PLAN.md#adoption-and-lifecycle-validation). The [Improve-mode assessment](docs/PRODUCT_STRATEGY.md#improve-mode-adoption-assessment) separates local improvements from unmeasured human value and adoption.

## Judge reproduction status

Tracked commands now prepare a native workspace, start an isolated stack, issue local accounts and seed fresh synthetic scenarios. Follow the [portable setup sequence](docs/OPERATIONS_AND_COST_PLAN.md#portable-setup-sequence). Earlier Windows/WSL qualification downloaded and verified fresh native runtime archives and exercised synthetic authenticated API journeys. The current packaged runtime inputs also passed an independent dependency installation, production build and sign-in-shell check; later documentation updates preserve those runtime inputs. Scoped browser checks pass, but the complete keyboard decision/recovery journey remains unqualified after local test timing and development-server reload failures. These results do not qualify a public clone, a complete Linux-only installation or the intended judge environment. Do not present localhost links as remote judge access or publish private status/account files.

The [submission plan](docs/SUBMISSION_PLAN.md#recording-script-and-shot-list) owns the final timed recording script. Media and retained working copies live under `output/submission-media/20261019/`, outside the final planning set.

## Local manual testing

Use [the real app with Docker-free local Auth and persistent database](http://127.0.0.1:3023). Follow the [current three-role workflow guide and fresh scenarios](docs/EVALUATION_AND_TEST_PLAN.md#docker-free-native-role-testing-current), the [complete15-persona catalog/preview guide](docs/EVALUATION_AND_TEST_PLAN.md#manual-self-testing-guide--october-14-2026), and [owned WSL start/stop instructions](docs/OPERATIONS_AND_COST_PLAN.md#docker-free-native-wsl-runtime). Records remain synthetic, providers disabled, spend$0 and hosted DB/deployment on hold. Earlier3020 entry/3021 preview have their original limited scope. These URLs are local only; availability ends when owned processes stop.

## Read order and topic ownership

| Order | Final document | Owns |
| --- | --- | --- |
| 1 | [Build plan](BUILD_PLAN.md) | Dependency-driven execution, effort and checkpoints |
| 2 | [Strategy](docs/PRODUCT_STRATEGY.md) | Buyer/workflow, defensibility, pilot falsifiers and typed seeds |
| 3 | [Product requirements](docs/PRODUCT_REQUIREMENTS.md) | Complete supported scope and extensions |
| 4 | [Resource isolation](docs/PROJECT_ISOLATION.md) | Protected FireAfter boundaries and new target admission |
| 5 | [Baseline](docs/FIREAFTER_BASELINE.md) and [provenance](PROVENANCE.md) | Dated source observations, all 25 inherited capabilities and actual new-work disclosure |
| 6 | [UX](docs/UX_SPEC.md) | Complete persona lifecycle operations, handoffs, role checklist, screens and reviewer interactions |
| 7 | [Architecture](docs/ARCHITECTURE.md) | Runtime, proposed modules, persistence, locks, dispatch and numerical ceilings |
| 8 | [Data/API contracts](docs/DATA_AND_API_CONTRACTS.md) | Records/routes/roles, feedback permission and portable briefing fields |
| 9 | [Source/tool contracts](docs/SOURCE_AND_TOOL_CONTRACTS.md) | Registry, Tavily, Nemotron, authority, missingness and modes |
| 10 | [Security](docs/SECURITY_AND_HUMAN_REVIEW.md) | Trust boundaries, privacy, rendering and human authority |
| 11 | [Evaluation](docs/EVALUATION_AND_TEST_PLAN.md) and [red-team plan](docs/RED_TEAM_PLAN.md) | Persona-based manual E2E guide, local setup, metrics, required checks, probes, oracles and acceptance evidence |
| 12 | [Domain discovery](docs/DOMAIN_DISCOVERY.md) | Canonical participant definitions, task context, research gaps and unsent practitioner agenda |
| 13 | [Operations](docs/OPERATIONS_AND_COST_PLAN.md) | Environments/configuration, cost, recovery and judge availability |
| 14 | [Submission](docs/SUBMISSION_PLAN.md) | Official rules, award eligibility, package/video and freeze protocol |
| 15 | [Decisions/build entry](docs/DECISIONS_AND_BUILD_GATE.md) | Unresolved inputs, authority by phase and actual governed-loop status |

## Structured sources of truth

The pack contains 29 required artifacts: 18 Markdown documents, seven CSV registries, three JSON records and one validator. Generated manifest/validation records are current indexes, not specification versions. No additional final, draft or review pack is required. The current inventory already contains one file per required topic; cleanup removes superseded prose in place. Recoverable originals are held outside this workspace, while execution receipts are retained as evidence.

[requirements.csv](docs/requirements.csv) owns 25 acceptance IDs; [backlog.csv](docs/backlog.csv) owns 24 tasks, current task status, dates, dependencies and provisional hours; [traceability.csv](docs/traceability.csv) binds them to specifications and check IDs. [evaluation_cases.csv](docs/evaluation_cases.csv) contains 39 designed cases; [red_team_probes.csv](docs/red_team_probes.csv) contains 24 designed probes; [cognitive_demands.csv](docs/cognitive_demands.csv) contains 10 hypothesis rows; [hackathon_compliance.csv](docs/hackathon_compliance.csv) maps all 15 official-rules sections through 26 pending obligations.

No target date means completed work. No designed case means a realized labeled corpus or passing test. No planning/check pass means app readiness, security acceptance, entrant eligibility or a winning probability. Source observation dates remain explicit. No field expert interview, private-record import, production mutation or final submission is claimed. Real Tavily adapter tests and a saved Devpost draft are recorded separately; One real standalone Nebius/Nemotron inference passed; integrated persistent provider qualification remains pending.

## Evidence and validation

Keep one authoritative file per topic using the ownership table above. Official rules govern eligibility; requirements.csv and PRODUCT_REQUIREMENTS.md govern scope; architecture and data/API contracts govern their respective implementation details; backlog.csv governs task status/dependencies/dates; DECISIONS_AND_BUILD_GATE.md governs observed verification and pending decisions. Provenance rows are dated history, not a second current status. Resolve a conflict in its owner file and update its dependents in the same batch. Update that file in place and refresh the manifest; do not add numbered, draft, final-final or archived copies inside the planning pack. Recovery archives stay outside the workspace; immutable execution/failure receipts remain outside the planning pack and are not specification versions.

[source-baseline.json](docs/evidence/source-baseline.json) retains selected source fingerprints, source identity and a full working-tree digest; its Sentinel import section retains the exact copied-file manifest, separately from the original-source observations; neither is a production probe. [PLANNING_MANIFEST.json](docs/PLANNING_MANIFEST.json) binds the one final artifact set; [document-validation.json](docs/evidence/document-validation.json) records current executed document checks.

Run `python docs/evidence/validate_documents.py` using the [document validator](docs/evidence/validate_documents.py) to check the pack. The validator uses the Python standard library and read-only Git/source fingerprinting; it does not execute app, provider or database tests. It refreshes only this workspace's manifest and document-validation report. The validator checks the 29 planning artifacts independently of application/dependency files, and rejects extra documents inside docs/ or extra root planning Markdown. AGENTS.md remains a separate required instruction file. pkg.json now identifies this Sentinel checkout and catalogs its implemented helpers, SQL records and final documents. Remaining inherited runtime/semantic edges are provisional. The worker batch has a source-bound structural manifest; document changes are tracked through the final manifest and project-map catalog, not structural source-graph coverage; SQL/document semantics and full-target acceptance still require their explicit checks. The structural graph under graphify-out excludes SQL and document semantics. Refresh its source-bound manifest after coherent code batches before relying on affected edges; current verification is owned by the decision register. SQL procedures and document semantics retain explicit project-map and test traces; graph navigation never proves runtime acceptance. Document links and traceability provide current planning navigation.

For operator onboarding and password rotation, follow the recoverable issuance contract in [operations](docs/OPERATIONS_AND_COST_PLAN.md); retain one attempt UUID across uncertain results.

## Work boundary

Maintain this single final set in place. Implementation uses only this project's files and new named resources. Provider credentials, paid execution, data migration, external publication/submission and outreach require their applicable target/authority; no such step was performed. Use one agent by default and preserve unrelated work.

## License

Sentinel is licensed under the [MIT License](LICENSE), as authorized by its owner. Third-party dependencies and bundled assets retain their respective licenses and notices; see [PROVENANCE.md](PROVENANCE.md).
