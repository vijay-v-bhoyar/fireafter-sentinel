# FireAfter Sentinel product strategy

Final planning specification, October 11, 2026. Product, demand, purchasing authority and competitive advantage remain unvalidated. This document consolidates the idea and moat reviews; implementation acceptance belongs to [requirements](requirements.csv).

## Buyer, user and problem

Candidate buyer: county public-works department leader. User: inspection coordinator, supported by a GIS analyst. When an official bulletin changes after a proposal is reviewed, the coordinator needs to know which inspection items require reconsideration and preserve the rationale for the next handoff. Frequency, current workarounds, procurement path and willingness to pay need [domain discovery](DOMAIN_DISCOVERY.md).

The chosen wedge is evidence-bound inspection review. Public wildfire chat, a generic dashboard and safe-route optimization are weaker fits for this release: the first two are widely copyable; routing needs additional data and qualification. Existing FireAfter capabilities remain attributed to the foundation.

## Product and return loop

Registered update -> exact cited comparison -> affected tasks -> deterministic crew checks -> human decision/correction -> retained revision -> portable briefing -> next update. Measure missed material changes and review time against static-evidence review. Every decision binds original evidence, constraints, human identity and an immutable receipt; later validity is shown separately. A new app, repo and database are mandatory.

Five added feature groups: retrieval/versioning; comparison/dependencies; constrained proposals; decisions/corrections/history; portable briefings/review evidence. Optional correction capture stays in the existing review interaction. The complete bounded first release and exclusions are owned by [product requirements](PRODUCT_REQUIREMENTS.md); no training platform, procurement product or additional screen is implied.

## Defensibility assessment

An independent blind reviewer assessed the standalone enhanced idea using the moat-reviewer rubric, without the candidate-mechanism table or other project documents. This is a design assessment, not customer, competitor or runtime validation. One design round completed; it stopped as capped because five real moats could not be justified. Zero established moats exist today.

| Moat family | Proposed-design score / 10 | Mechanism and limit |
| --- | --- | --- |
| Proprietary data & learning loop | 2 | Source-linked reviewer adjudications can inform permissioned offline comparisons; no corpus, rights, improvement or exclusivity exists yet |
| Network effects | 0 | No benefit from other agencies joining; private signals are not pooled |
| Switching costs & workflow lock-in | 4 | Adopted decision continuity may be valuable across shifts; open portable exports deliberately limit displacement friction |
| Trust, governance & auditability | 4 | Source/actor/constraint receipts and independent verification can earn confidence; no agency reference or certification exists |
| Domain depth & codified expertise | 2 | Limited inspection semantics and crew constraints; no substantial expert-validated rules library |
| Distribution & point-of-work embedding | 0 | No owned channel, partnership or procurement access |
| Scale economics / cost or performance edge | 0 | No measured structural cost/performance advantage |
| Regulatory or structural edge | 0 | No privileged data access, exclusive rights or certification |

Verdict: **Good wedge, not a full company yet.** Three structural seed hypotheses survive: permissioned reviewer adjudications, portable operational continuity and earned verification confidence. A copyist cannot invent a particular customer's past human decisions or historical independent experience, but can copy code, obtain customer exports or collect more labels sooner. Incumbents may already have stronger relationships.

Model access, prompts, Tavily, map styling, public notices, ordinary caching and downloadable tests are not moats. Agency-specific rules are necessary configuration, but no difficult-to-reproduce expert library exists. Distribution/network/regulatory mechanisms are unsupported. Extraction and comparison are capability-derived: stronger base models can commoditize them. The structural seeds matter only with permitted recurring use.

[Esri's published emergency-management solution](https://www.esri.com/en-us/industries/blog/articles/new-emergency-management-operations-solution) already covers situational awareness and briefing workflows; that rejects broad dashboard novelty, but does not prove whether it implements this exact approval protocol. Spreadsheets/documents are another candidate workaround to confirm with users. Competitive response remains unknown; no comparative product test has occurred.

## Pilot, falsifiers and trust

Observe an authorized coordinator on matched static/fresh-evidence tasks. Freeze labels before comparison; report raw denominators, disagreements, missed changes, review time, unsupported claims and confusion. Kill or rethink the wedge if consequential changes are rare or the new review adds no useful advantage. Expand only after critical negative tests pass and actual recurring value is observed; one positive demo is insufficient.

Five early failure risks: no recurring problem, wrong interpretation, brittle providers, unsafe authority and no purchasing path. Address them through observed handoffs, frozen semantic labels, visible failure/recovery, fenced human decisions and a real sponsor/procurement discussion. No field-safety, lives-saved, agency-endorsement or guaranteed-prize claim is supported.

The feedback and export contracts are in [data/API contracts](DATA_AND_API_CONTRACTS.md); offline evaluation is in [evaluation](EVALUATION_AND_TEST_PLAN.md). Learning is optional, separately permissioned and human-reviewed. The public open-source reproduction path requires no private corpus. Re-estimate affected work at the baseline checkpoint; effort is provisional.

## Typed downstream handoff

The seed labels below are unscored handoff categories. [backlog.csv](backlog.csv) owns the implementation tasks, dependencies and estimates; this document does not create a second roadmap or market-sizing estimate.

```yaml
idea_slug: county-inspection-review
source_run: PRODUCT_STRATEGY.md
stop_reason: capped
verdict_tier: Good wedge, not a full company yet.
for_product_vision:
  problem_statement: Official evidence can change after an inspection proposal is reviewed, leaving its dependencies unexamined.
  thesis_candidate: Source-linked human review and portable decision continuity can reduce missed changes if coordinators repeatedly use the workflow.
  target_buyer: County public-works department leader, unvalidated
  target_user: Inspection coordinator
  why_now: "[founder input needed]"
  willingness_to_pay: "[founder input needed]"
  durability_claims:
    - moat_family: Proprietary data & learning loop
      claim: Permissioned real reviewer adjudications may improve evaluated extraction over time; no corpus or exclusivity exists today.
      stage: seed_v1
    - moat_family: Switching costs & workflow lock-in
      claim: Adopted source-bound decision history may make replacement costly to validate while remaining portable; adoption is unproven.
      stage: seed_v1
    - moat_family: Trust, governance & auditability
      claim: Repeated independent review and safe-use evidence may earn confidence; no reference exists today.
      stage: seed_v1
for_product_backlog:
  seed_items:
    - title: Capture source-linked reviewer adjudications and separate reuse permission
      acceptance_criteria: Typed original/corrected claim and reason bind to scoped immutable source/review IDs; absent permission excludes learning use; no automatic model or policy update.
      effort: S
      seeds_moat_family: Proprietary data & learning loop
    - title: Export complete decision and evidence continuity
      acceptance_criteria: Authorized JSON includes original revision, permitted evidence lineage, constraints, actor and receipt; later validity is separate and rights limitations explicit.
      effort: M
      seeds_moat_family: Switching costs & workflow lock-in
    - title: Preserve independently attributable verification evidence
      acceptance_criteria: Reports bind reviewer scope, frozen subject/corpus, raw counts, failures and actual test status; absent review stays provisional.
      effort: S
      seeds_moat_family: Trust, governance & auditability
```

## Improve-mode adoption assessment

### October 28 Stage 2 applicability check

The retained county-inspection-review idea and existing capped moat review still match the current candidate. This is a revalidation of the existing review, not another design/scoring round: the eight-family scores above remain historical proposed-design scores, with zero established moats. The current synthetic three-role receipt/export rehearsal demonstrates scoped decision continuity; it does not demonstrate demand, a proprietary learning corpus, competitive superiority or earned agency trust. The real-provider receipt demonstrates retrieval/interpretation and an unresolved/rejected export, not an approved incident plan.

Retain one primary journey: analyst inspects a registered evidence change, coordinator reviews affected tasks and bounded crew constraints, then the authorized recipient verifies the committed briefing and its limits. Keep the five feature groups and current exclusions. Broader dashboards/chat and route optimization remain rejected alternatives; no new feature is added to improve a moat score. The existing Esri source was refreshed October 28: its incident awareness and briefing capabilities still defeat broad dashboard novelty claims; no exact approval-protocol comparison or product superiority is established.

The three structural hypotheses keep separate falsifiers. Permissioned adjudications matter only if independently labeled repeated reviews improve held-out results; no improvement or no reuse permission defeats that hypothesis. Decision continuity matters only if recipients actually reuse accurate prior decisions with lower total review burden; portable exports deliberately constrain switching friction. Earned trust needs repeat independent evidence and safe interpretation; any consequential unsupported conclusion or misunderstanding defeats a positive trust claim. Public sources, model access, prompts and a copied UI remain replicable.

Feasibility checkpoints are ordered before dependent work: (1) receive the selected Gifford historical case's actual independent findings, consent scope and unresolved times; (2) review source rights, immutable capture and truthful version-series identity before registration; (3) admit a separately bounded $0 provider campaign only after fresh funding/expiry controls, then qualify the approved plan and paid-response recovery; (4) measure the matched static/fresh first and repeat tasks under the existing pilot contract. No checkpoint is waived for the submission date. Retaining the idea is a scope decision; the checkpoints remain uncompleted product acceptance.

October 13, 2026. Scope: current local Sentinel candidate and private test preparation. Evidence inputs: current source, canonical documents, retained automated receipts and the owner's constraints. No interviews, analytics, adoption, procurement or independent human demonstration were conducted. Persona definitions live in [discovery](DOMAIN_DISCOVERY.md#participant-catalog-and-task-context), complete operations in [UX](UX_SPEC.md#end-to-end-persona-operations), scenario execution in [evaluation](EVALUATION_AND_TEST_PLAN.md#adoption-and-lifecycle-validation), and gate decisions in the [status owner](DECISIONS_AND_BUILD_GATE.md#current-strict-personaworkflowtest-review). Do not treat the fictional golden scenario as a customer story.

### Findings, needs and action trace

Every finding uses the date/scope above. Source code establishes mechanism, not demand or emotion. No contrary human research exists; absence is not corroboration. Candidate needs remain HYPOTHESIS unless supported by subsequent real task observation.

| Finding / evidence class / source | Need and expected experience | Requirement / workflow / technical control | Priority, execution and next validation | Outcome measure, including contrary evidence |
| --- | --- | --- | --- | --- |
| AD-F01 OBSERVED: pre-change `sentinel-workspace.tsx` Overview offered two generic links and no ordered role handoff. | AD-N01: a first-time user should know where to begin, what their role can do and when to hand off. | SEN-R020; UJ-01/03/04/09; AD-X01 role-specific ordered links with incident/mode preserved; existing server authority unchanged. | P1 local fix EXECUTED: Start here for your role on Overview; AD-T01 role/scope/no-call checks. Human first-use observation AD-T02 remains NOT_RUN. | Correct independent first handoff, assistance count and first-value duration. Existing generic navigation was present; no observed human confusion was claimed. |
| AD-F02 OBSERVED: manual guide described repaired asset/export defects as still open and conflated historical provider deferral with present evidence. | AD-N02: testers need an accurate environment/fixture boundary rather than a stale stop instruction. | SEN-R018/020/021; UJ-08/11/12; AD-X02 current status links and blocked Auth distinction. | P1 documentation fix EXECUTED; update F1/F5/F6 guide and preserve failed historical receipts. Run document/suite checks. | Zero contradictory current defect statements; tester correctly identifies blocked setup. Unit/embedded repairs still do not prove repaired authenticated UI. |
| AD-F03 HYPOTHESIS: catalog previously merged buyer with operator/evaluator; actual buyer authority UNKNOWN (`DOMAIN_DISCOVERY`, strategy). | AD-N03: buyer must compare whole-workflow effort and authorize pilot independently of judging or technical setup. | SEN-R018/021; UJ-13/14/15; AD-X03 distinct buyer/governance/support handoff; external authority not an app role. | P1 definitions/operations/pilot decision package EXECUTED; AD-T05 buyer/operator/governance walkthrough NOT_RUN. | Accountable owner and actual allowed purpose/cost confirmed, or informed decline. Technical owner may also be buyer, but that cannot be assumed. |
| AD-F04 UNKNOWN: no matched current-process comparison, repeat-use trial or demand evidence (`DOMAIN_DISCOVERY`). | AD-N04: coordinators and analysts need useful recurring improvement, not an additional reporting obligation. | SEN-R005/011/013/017; UJ-02/04/07/13; AD-X04 matched baseline plus second-update trial. | P0 before adoption: research protocol EXECUTED as plan; AD-T03 trials NOT_RUN. No speculative automation added. | Raw missed material changes, total active human time, assistance, rework and unsupported claims for both tasks/alternatives. Existing unit counts cannot disconfirm lack of customer value. |
| AD-F05 UNKNOWN: no recipient/domain/accessibility human acceptance; all UT cards NOT_RUN. | AD-N05: recipients must distinguish decision, age, limitation and clarification authority; reviewers must assess meaning independently. | SEN-R009/017/020; UJ-06/10/11; AD-X05 comprehension/semantic/accessibility checks layered below handoff. | P0 before operational reliance: AD-T04 and UT-12/14/17 remain NOT_RUN; bounded question/oracle plan EXECUTED. | Four comprehension answers correct, domain disagreements recorded, critical barriers absent. Successful offline rendering is contrary to a rendering-failure claim, not evidence of comprehension. |
| AD-F06 SELF_REPORTED: owner says $0, hosted/deployment held, Docker unavailable; OBSERVED prior local Auth failure and incomplete Nebius funding qualification (decision register). | AD-N06: operator can explain available tests and stop safely without another resource or paid fallback. | SEN-R016/018/021; UJ-08/12/13; AD-X06 readiness/financial stop conditions and same-command recovery. | P0 preserve boundary EXECUTED; do not restart Docker, provision, deploy, charge or request keys in reports. AD-T06 environment handoff BLOCKED for authenticated work. | No out-of-scope action; independent ability to diagnose the blocker, original command/usage retained. Live Tavily adapter passes do not remove persistent-worker or Nebius qualification gaps. |
| AD-F07 OBSERVED: portable role-permitted briefing is a retained view, not a complete DB/auth/storage migration; retention/exit authority UNKNOWN (contracts/runbook). | AD-N07: buyer/data owner/integrator need an honest exit path without unsupported portability claims. | SEN-R017/018/025; UJ-06/14/16; AD-X07 separate briefing portability from backup/deletion/migration obligations. | P1 exit/support contract EXECUTED in runbook; AD-T07 receiving-tool/retention trial NOT_RUN. No destructive data operation added. | Selected export independently verified and unresolved retention/access obligations named. Existing byte/hash checks support artifact integrity only. |

### Representative demonstration and pilot contract

Intended users: UP-01/02 performing one evidence-bound inspection review, UP-06 receiving the handoff, UP-07 independently labeling applicability, supported by UP-04/14. UP-12/13 decide whether a later pilot is allowed. Use one isolated synthetic incident, named three stored assets, two crews, one eight-hour UTC shift, two notice versions, an affected and an unaffected task, and fresh terminal branches. Disclose authored fixtures, preparation, assistance, missing live qualification and inherited/new attribution before evaluation. No field action is part of the trial.

Baseline: participant's actual authorized source-and-document/notebook/spreadsheet process; obtain an example with permission, otherwise label baseline NOT_AVAILABLE and withhold comparative benefit. Freeze complete-source labels and acceptable allocation before either condition. Use matched tasks with counterbalanced condition order where possible; preserve skill, training and task-difficulty differences. Log full setup, source reading, authoring, review, handoff, clarification, recovery and exit effort for **all** participants, not just commander clicks. Do not hide work transferred to analyst/operator/recipient. Invite one lapsed/non-adopter if available with consent; no contact is currently authorized.

First verified value: participant correctly identifies the changed dependency, explains evidence uncertainty, hands off a complete proposal, records a confirmed decision under appropriate authority and supplies an understood permitted briefing. Then give a second changed-evidence task: preserve original decision/export, re-review only on a current basis and demonstrate uncertainty recovery. Proposed comprehension questions: Which incident/mode/revision is this? Is this a proposal or confirmed decision, and does it authorize field work? How old/limited is the supporting evidence? Who receives your question when evidence is missing or changes? Record actual answers and assistance, not a checkbox of claimed understanding.

Proposed stopping criteria, to be agreed/frozen before any pilot: any consequential missed change, unsupported safe-access instruction, unauthorized exposure/mutation, unconfirmed success or paid request beyond authority stops the trial. Four comprehension questions must be correctly answered without correction at the final check; critical accessibility and recovery tasks must succeed. To advance a **usability pilot** rather than claim population efficacy, both first and second tasks must meet correctness, and total active human effort must be no greater than the matched baseline with no new critical burden. Record raw per-task durations/counts; if no baseline or no improvement, decide revise/decline rather than claiming savings. Single-team success is not statistically representative, production readiness or adoption.

Good-fit hypothesis: a coordinator/analyst team has recurring official changes, permitted reusable sources, explicit inspection constraints and an accountable reviewer. Poor fit: public evacuation/routing, autonomous dispatch, field completion capture, unsupported counties/formats, absent source/data authority, or a team whose existing process already serves the task better. Staying with the current process is a valid decision.

### Implementation and adoption costs

| Obligation | Owner / required evidence | Current condition |
| --- | --- | --- |
| Subscription, hosting/database and model/search | Buyer/operator verifies actual account tariff, credit balance/expiry and disabled paid fallback/top-up. | $0 cash ceiling; no new spend authority. No inference funding or hosted provision/deploy admitted. |
| Setup and integration | Operator/builder supplies isolated identities, qualified sources/native signing, fixtures and compatible receiving workflow. | Human effort unmeasured; Docker blocks current authenticated handoff. No new connector promised. |
| Training and ordinary review | Trainer records help/time; analyst/commander record complete source and task-review effort. | Role checklist/doc improvements local; human burden UNKNOWN. |
| Operation and support | Named operator maintains source/worker/budget health and owns support escalation. | No verified support capacity, service level or scheduled delivery. |
| Governance, retention and exit | UP-13 defines lawful permissions, export recipients, retention/legal holds; UP-15 validates chosen artifacts; operator implements approved access changes. | Organizational decisions UNKNOWN; no complete migration or deletion capability claim. |

Practical sequence: local documents/checklist and automated mechanism checks now → existing Docker/Auth/fixture recovery when owner can provide it → consented first/second task and independent labels → buyer/governance decision on a bounded non-operational pilot → separate hosted/deployment/provider qualification only when holds are lifted. Dates and recurring labor budget are unagreed; do not invent a launch timeline. Training material is the role checklist plus canonical UT cards and a redacted fixture handoff; no testimonials, endorsements or user-savings headline is permitted.

### Claim controls and improvement record

| Claim ID / exact current wording | State / evidence / context and limit | Author, separate review and dependent assets |
| --- | --- | --- |
| AD-C01: “Sentinel provides an ordered role-specific review checklist with scoped navigation.” | SUPPORTED by AD-T01 component checks; build verification is recorded in the status owner; says nothing about actual onboarding success. | Codex author; independent product/user review pending. README, UX and private demo; exact source hash in adoption evidence, revisit on role/navigation changes. |
| AD-C02: “The current local review candidate has automated checks for source-bound decisions, recovery and permitted briefing integrity.” | SUPPORTED by version-bound regression receipts in status owner; fixtures and limitations explicit, no universal behavior or human outcome claim. | Codex author; independent review pending. Test guide/demonstration; historic receipts remain historic, reassess after relevant code/contract changes. |
| AD-C03: “Sentinel saves review time and improves recurring inspection decisions.” | HELD: matched baseline, domain labels and actual first/repeat human trials absent. | Product owner; independent user/domain evidence required. Exclude from demo, submission headlines and buyer material until supported/reviewed. |
| AD-C04: “Sentinel is ready for operational adoption or independently endorsed.” | HELD: human, hosted, governance, provider and support qualification missing; no genuine endorsement. | Product owner; separate approver required. No public reuse or publication authorized; reassess only on exact target/evidence. |

No claim is APPROVED by its own author. Review due at the next manual trial or relevant source/config/authority change, whichever comes first. On contradiction hold affected claim and private asset reuse, record the failure in the decision register, repair within local authority and seek independent reassessment; historical evidence is not deleted. Public correction/contact needs authorization for its destination.

Improve record AD-I01: Observe AD-F01–07 → assess needs and lifecycle coverage → prioritize comprehension/current-test handoff before speculative features → execute checklist, corrected guide, participant/lifecycle/test/support/pilot/claim records → validate local controls and document contracts → record scoped results/gates in the decision register. Learn from actual next trials rather than manufactured user feedback; stop this local iteration when required checks pass. Human/research/provider/hosted blockers stay owned and visible instead of being marked complete.

## Strict-review improvement record

AD-I02, October 13, 2026, `user-first-product-adoption` Improve/Test. Authorized action: review and repair canonical documents only. All findings below are OBSERVED documentary gaps against the pre-audit26-case structured suite, source catalog and existing requirement/test owners saved in `output/verification/sentinel-adoption-audit-20261013/`. Human needs/value remain HYPOTHESIS/UNKNOWN. Runtime code, source/case oracles and earlier failed/passing receipts are preserved; the definitions are extended without manufactured execution. No new final-document versions are created.

| Finding / source and contrary-evidence boundary | Repair, need/journey/test trace and owner | Acceptance / next real evidence |
| --- | --- | --- |
| AD-A01: UP-10/11 existed in the catalog but had no structured need/journey/test. Existing prose recognized them, so they were not missing from all documents. | UN-17/18, UJ-17/18, UT-27/28; affected-person communication and publisher lifecycle remain external, no app portal. Data owner/source steward. | Every catalog participant reaches a meaningful scoped need, journey and scenario; human context/rights still NOT_RUN. |
| AD-A02: ten of39 E cases had no UT link; SEN-R023 had no UT requirement link; UT-11 incorrectly linked E19 expiry. Other source tests may exist, so this is not proof of a runtime coverage defect. | Explicit source/temporal/provider/adversarial/expiry UT-28–31/33, corrected UT-11, all39 E and25 requirement coverage tables. QA. | No orphan case/requirement, all24 RT definitions linked to unchanged independent oracles; actual execution separately NOT_RUN/BLOCKED. |
| AD-A03: UT-23–26 used judge-only SEN-R018 and inherited generic fixture/owner fields. External adoption text was present but trace was inaccurate. | Buyer usefulness/cost, governance permission, trainer recovery/access and integrator integrity mapped to appropriate requirements/controls; exact external owner and fixture boundary. UP-12–15. | No false judge-only requirement closure or implied portal/authority; actual buyer/governance/receiving proof remains absent. |
| AD-A04: every original scenario required one trial despite multiple roles/variants; structured access gaps still called repaired defects open; evidence versions claimed current under the older commit. Original failed receipts remain valid history. | Named mandatory branches, preserved assertions, complete-case accounting, current repair/Auth/provider boundaries and current audit hashes; all34 execution records stay NOT_RUN. QA/operator. | A favorable branch cannot complete missing branches; no stale “defect open” guidance, rewritten historical result or inflated human evidence. |
| AD-A05: structured journeys lacked explicit trigger/input/progress/authority/effect/recovery/limit/completion fields. Broader UX prose covered parts of them. | Complete unique contracts for20 UJ IDs in UX and structured suite, including UJ-17–20, exact output/handoff owner and limits. Product owner. | All20 contracts and scenario links present; material changes still require current review, not invisible permission reuse. |
| AD-A06: baseline/repeat/comprehension protocols existed as prose but lacked dedicated structured first/repeat/access trials and returning/non-adopter contexts. No empirical value evidence existed. | UN-19/20, UJ-19/20, UT-32/34, six contextual hypothesis profiles; all-role effort, four comprehension questions, actual baseline and informed decline. Trainer/reviewer/buyer. | Record real matched first/repeat outcomes and human assistance; no task-time, sustained-use or population claim from plan/counts. |
| AD-A07: requirements implied public Sentinel viewer access and listed selected name/targets/$0 as undecided; red-team cash wording was stale. Existing status owner held the correct boundary. | Authenticated viewer explicitly separated from foundation public routes, selected/unresolved decisions corrected, future campaign versus current zero-network/$0 authority explicit. Product/resource owner. | Cross-document role/resource/status agreement; no public portal, paid action, deploy/provision or original-app write introduced. |
| AD-A08: inherited25-capability UT-18 bundled many checks; aggregate corpus90%/10% targets and strict human pilot stops needed explicit scope separation. Neither was a measured result. | Named capability-specific assertions/branches and G/AD/CHECK coverage; critical/semantic/expiry/access cases remain blocking independently of averages. QA/domain reviewer. | All25 inherited IDs have a planned check, supporting catalog paths exist, and unavailable-state proof never closes successful operation; freeze actual labels/thresholds before trials. |

Current strategy decision: the bounded documentary gaps above are repaired subject to recorded structural/document checks. No guarantee of unknown real-world coverage is made; revise after an actual omitted participant/handoff/device/source format emerges. AD-C01/02 remain scoped to prior local mechanism/evidence subjects; AD-C03 savings and AD-C04 operational readiness/endorsement remain HELD. These new plans do not upgrade any claim or approve publication. The status owner preserves the earlier iteration's hashes/counts as historical and records this review separately.
