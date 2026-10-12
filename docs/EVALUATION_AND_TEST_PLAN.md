# Evaluation and verification plan

Final acceptance-test design. Local baseline and partial evidence/durable-run checks have run; their actual outcomes and limits belong to [observed local progress](DECISIONS_AND_BUILD_GATE.md#observed-local-progress). No Sentinel-specific corpus/labels, real provider proof, full fresh-target migration-chain acceptance or release acceptance has been recorded. [evaluation_cases.csv](evaluation_cases.csv) enumerates 39 designed cases; actual source corpus and independent labels must be created and reviewed during SEN-T20. The separate [24-probe adversarial manifest](red_team_probes.csv) has runtime status NOT_RUN; [red-team plan](RED_TEAM_PLAN.md) defines adaptive trajectories and non-model success oracles.

**Golden tasks:** G01 open a scoped incident and inspect source mode/time; G02 retrieve and compare a notice; G03 identify affected plan items; G04 create a feasible proposal; G05 approve/modify/reject and retain evidence; G06 recover an interrupted run/decision; G07 open/export the same committed revision from a fresh judge session; G08 distinguish zero change from unavailable evidence.

**Dataset:** collect permitted real notice sequences and deliberately labeled synthetic/adversarial examples. Preserve issuer, version, jurisdiction, publication/effective/retrieval times, intended affected entities, expected materiality and uncertainty. Domain reviewer labels decision-relevant meaning. Split development cases from a frozen holdout. Replay cannot use later evidence. Missing practitioner labels stay provisional.

**Comparisons:** A static/current FireAfter-style review; B Nemotron with static evidence; C Nemotron with fresh Tavily evidence. Hold task, constraints, documents/time boundary and model configuration constant where possible. Report retrieval failures and missing evidence rather than dropping them. A model grading itself is insufficient ground truth. Measure benefits from fresh evidence separately from benefits of a new interface/model.

| Metric | Definition | Proposed acceptance |
| --- | --- | --- |
| Material-change recall | Correctly detected material changes / all labeled material changes | At least 90% on frozen declared cases |
| False-positive rate | Benign changes incorrectly called material / all labeled benign changes | At most 10%; publish denominator |
| Dependency accuracy | Correctly affected/unaffected item labels versus reviewer ground truth | Report counts; zero critical wrong-item linkage in golden demo |
| Citation validity | Existing exact version/span/hash references | Every promoted claim passes mechanical validation |
| Semantic support | Claim actually follows from source/context | Every critical demo claim manually checked; report broader labels |
| Approval safety | Stale/expired/conflicted/cross-scope approvals rejected | All tested negative cases pass |
| Retry correctness | Replay duplicates or inconsistent decisions/audits | Zero in tested cases |
| User usefulness | Task time, missed changes, overrides and observed confusion | Report measured walkthrough outcomes; no invented endorsement |
| Performance | p50/p95 elapsed time for declared 5-document workload | Initial p95 target 60 seconds; report actual hardware/network/model |
| Cost | Actual reserved/charged provider usage per completed/failed run | Within owner budget; report failures and uncertainty |

These are proposed engineering targets with small-sample limitations. They are not field qualification, calibrated hazard accuracy, or guaranteed prize scores. Failure of a critical authorization/history/stale-approval case blocks release irrespective of averages.

**Test layers:** pure unit checks for parsing/time/constraints; adapter integration for real response contracts; real Postgres migration/authorization/atomicity/concurrency/recovery tests; browser workflow and rendered accessibility; authorized live Token Factory/Tavily smoke; exact-deployment fresh-session rehearsal. Mock-only and static SQL checks are explicitly separate from provider/hosted evidence.

**Scope-specific assertions:** exact inherited roles; viewer-read helper and analyst accept/reject denial with permitted draft modification/annotation; shared membership lock/revocation race; unknown source changes fence the incident before inference; lock-wait expiry uses wall time; duplicate/opposing terminal decisions reject; runtime retries keep original aggregate reservations; HTTP 200 partial Extract is incomplete; overflow is never authoritative truncation; full briefing hash checked in the client. These assertions test the concrete protocols in [architecture](ARCHITECTURE.md).

**Evaluation independence:** freeze corpus labels before comparison; have a second person label critical demo claims when available, recording disagreement and who resolved it. Without an independent reviewer, label results builder-reviewed/provisional, never independently validated. SEN-T19 may record missing participation but cannot thereby satisfy the usefulness portion of SEN-R019. Performance and detection thresholds remain hypotheses, and 39 designed cases are not a 39-example labeled corpus.

**Inherited checks:** npm.cmd ci; npm.cmd test; npm.cmd run lint; npx.cmd tsc --noEmit; npm.cmd run build; npm.cmd run verify:graph; npm.cmd run verify:migration-contract. Use existing browser/authenticated scripts with Sentinel target checks, never inherited production defaults. Capture full logs, exit status, source/config revision, time and test environment.

**Evidence format:** verification ID, requirement/task/case IDs, subject commit and dirty digest, target/mode, config/model/prompt versions, start/end, outcome PASS/FAIL/BLOCKED/DEGRADED/SKIPPED/NOT_RUN, log/artifact path, safe diagnostics and known limits. An implementation change invalidates affected earlier evidence and requires focused rerun.

**Traceability:** [traceability.csv](traceability.csv) maps each requirement to a task and designed verification. Tests pass only after the corresponding actual input/corpus and execution record exist.

## Verification categories

These IDs group required acceptance evidence. This table is a specification, not an execution report; partial local checks do not complete a category. The decision register owns observed results, and designed case/probe rows remain unexecuted.

| ID | Required evidence |
| --- | --- |
| CHECK-BASELINE | Reviewed source identity, separate resources, inherited feature inventory and baseline regression results |
| CHECK-UX | Rendered workflow, navigation, responsive and keyboard/accessibility observations |
| CHECK-TRUST | Scope, identity, redaction, source-instruction isolation and negative authorization checks |
| CHECK-EVAL | Frozen labeled cases, comparison results, denominators and practitioner observations |
| CHECK-LIVE | Authorized real Tavily and Nebius/Nemotron request receipts, response validation and safe usage evidence |
| CHECK-DATABASE | Real database migrations, isolation, evidence locks, atomicity and concurrent-decision results |
| CHECK-DELIVERY | Repository-required checks and generated-briefing correctness for the declared revision |
| CHECK-RECOVERY | Interrupted jobs, late workers, retry/replay and restart-safe budget/deadline results |
| CHECK-JUDGE | Exact deployed URL, fresh-session golden journey, coverage/mode and retained-history evidence |
| CHECK-BUDGET | Measured provider usage, reservations, limit rejection and failure accounting |
| CHECK-SUBMISSION | Rules/category eligibility, provenance, publication permissions and complete submission checklist |
| CHECK-REDTEAM | Authorized sandbox dry-run, static and adaptive trajectory coverage, app-control oracles, safe findings and pinned regression results |
| CHECK-FEEDBACK | E36 typed correction, atomic receipt, scope/size/idempotency, permission/revocation, no egress/promotion |
| CHECK-SCOPE | Supported incident/format/task/crew limits, complete bounded journey and explicit capacity rejection; effort checkpoint |

## Feedback, isolation and portability checks

CHECK-FEEDBACK covers E36: typed signal scope/size/idempotency, absent/revoked permission, no model/telemetry egress or automatic promotion. E37 extends CHECK-BASELINE with stubbed protected-target zero-call tests; no test calls FireAfter production. E38 extends CHECK-JUDGE/CHECK-SUBMISSION with full free access and the rules crosswalk. E39 extends CHECK-DELIVERY with complete permitted portable decision lineage, honest rights limits and overflow rejection. Existing checks remain required. Private learning comparison is optional and NOT_RUN unless actually authorized/executed; no moat improvement or agency trust may be claimed from design alone.


## Optional permissioned improvement comparison

Export only eligible scoped signals to an authorized offline evaluation destination. A person groups errors and proposes extraction/schema/policy changes; preserve the original corpus and freeze a separate holdout before tuning. Compare baseline and candidate with unchanged cases/configuration boundaries, report raw denominators, critical failures and reviewer disagreement. A failed or unmeasured candidate cannot be promoted. Approval/release is explicit with a new policy/model revision; no automated fine-tuning, self-modifying policy, production promotion or extra learning service is in this release. If actual learning comparison is not performed, record NOT_RUN and claim only a capture seed.

Verification reports retain actual reviewer identity and scope, frozen subject/corpus/config, raw counts, failures, target and time. Missing independent/domain review remains provisional; it is not agency endorsement or certification.

## Inherited database release controls

This is the sole current version table for inherited controls. Required versions are code contracts, not proof that a fresh database has applied them. Test their RPCs on the disposable Sentinel target before judge activation.

<!-- current-security-probes -->
| Control | Required version |
| --- | --- |
| serverOwnedWrites | `20260914070900` |
| serverOwnedReads | `20260913230300` |
| atomicResponderAction | `20260914010000` |
| atomicBundlePersistence | `20261002010000` |
| operatorAccountIssuanceAudit | `20260915130000` |
| scheduledRefresh | `20261002000000` |
<!-- /current-security-probes -->

The inherited import recovery contract includes 20260914090000_import_operation_receipts.sql: preserve the original operation UUID, reconcile the scoped receipt after a lost response, and do not infer rollback or refresh completion from the receipt.

libpg-query provides offline SQL parsing only; PL/pgSQL bodies are not validated. Applied migration candidate safety UNKNOWN until fresh-target authorization, transactional, recovery and concurrency checks pass. A syntax pass cannot establish deployment or field readiness.
