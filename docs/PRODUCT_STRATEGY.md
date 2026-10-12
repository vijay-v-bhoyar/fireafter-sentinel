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
