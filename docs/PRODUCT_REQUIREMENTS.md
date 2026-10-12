# Product requirements

Final planning specification. [requirements.csv](requirements.csv) owns all 25 acceptance IDs. This document owns the supported product scope; [architecture](ARCHITECTURE.md) owns implementation protocols; [strategy](PRODUCT_STRATEGY.md) owns buyer and durability hypotheses.

**Problem:** a coordinator can read a briefing and approve an inspection proposal, then miss a later bulletin that changes the assumptions behind that proposal. A map or conversational answer alone does not maintain the relationship between evidence and an approved revision.

**Outcome:** preserve that relationship and make its validity visible. A user selects an incident, reviews new official evidence, sees affected proposal items, checks constraints, records a decision, and shares a source-linked briefing.

**Audience:** county emergency-management/public-works coordinators and supporting GIS analysts. Public viewers receive redacted information. Actual commander/analyst/viewer permissions are resolved server-side; judges use an isolated commander account, not a new role. Practitioner needs are hypotheses until discovery is completed.

**Complete product:** retain the inherited incident/map/asset/source/history/export experience under its actual availability limits, then integrate Changes, Plan, Evidence and Briefing surfaces. Offer live retrieval and a separately labeled reproducible replay. Provide onboarding, error recovery, immutable history, constrained proposals, technical traces, usage limits, and judge access.

**Core scenario:** a labeled scenario starts with three inspection candidates and two crews. An official document version changes an access assumption for one candidate. Sentinel presents the old/new excerpt, identifies the affected item, marks the proposal for review, creates a feasible revised draft, and records a coordinator's decision. Scenario task/crew values are authored demo inputs unless explicitly supplied by an agency; no field authorization is implied.

**Requirement groups:**

- SEN-R001-R004: derivative baseline, incident onboarding, explicit data mode, honest source times/coverage.
- SEN-R005-R009: immutable versions, Tavily runtime retrieval, Nemotron runtime interpretation, supported claims, change/conflict classification.
- SEN-R010-R016: evidence dependencies, stale approval rejection, deterministic constraints, human review, retained history, briefing, durable recovery.
- SEN-R017-R022: authorization/redaction, judge experience, evaluation, accessibility, usage/observability, submission provenance.
- SEN-R023-R025: scoped adversarial regression, supported release bounds and safe optional reviewer feedback capture.

**Product invariants:** missing hazard evidence remains Unknown; document text cannot change permissions or invoke arbitrary actions; a newer retrieval does not by itself establish a newer authoritative notice; issuer/version/interval/jurisdiction determine applicability; ambiguous identity or conflict requires review; a new source never overwrites old decisions; plan approval checks current evidence and constraints inside the same commit boundary; operational assignments remain proposals until human approval.

**Success evidence:** independently checked source support, accurate material-change detection on frozen cases, correct affected-item identification, fewer missed changes than a static-evidence comparison, reproducible human decisions, acceptable measured time/cost, and relevant user feedback. No lives-saved claim, field accuracy claim or practitioner endorsement is assumed.

**Not yet decided:** name, ownership/license, account access, cloud targets, paid budget, intended data retention, demo county, actual staffing availability, domain thresholds and practitioner participation. See [decision register](DECISIONS_AND_BUILD_GATE.md). These decisions have phase-specific impact; they do not prevent authoring or local design preparation.

## Supported first release

One deliberately selected county/fire in a dedicated demonstration organization. Preserve FireAfter's 25 capabilities and their real source/operator availability labels. The new path supports a full retrieval -> evidence comparison -> plan review -> decision -> retained history -> briefing journey. Changing county stays an inherited capability; Sentinel qualifies one incident end to end before adding further source registries.

| Dimension | Required release bound | Behavior beyond bound |
| --- | --- | --- |
| Notice input | English text from at most five registered HTTPS URLs per run | Unsupported language/format or capacity status; no silent truncation |
| Discovery | One domain-filtered Tavily Search; at most five candidates | Unregistered candidates require source-registry admission before extraction |
| Extraction | One Tavily Extract batch of registered URLs | Account for each success/failure separately; incomplete acquisition remains visible |
| Plan | Up to ten inspection items, two crews, one UTC shift of at most eight hours | Return INPUT_INVALID/capacity error; do not silently drop tasks |
| Task data | Authored capability, duration, constant travel allowance and time window; verified inputs require separate evidence | Missing values remain incomplete; no invented estimates or road-routing inference |
| Scheduling | Deterministic complete search over the bounded selected task set; priority breaks ties | Assign every selected task exactly once or return incomplete/infeasible with no partial assignment; no physical-routing or fastest-plan claim |
| Evidence support | Source-local claims; explicit same-issuer revisions, applicability and conflicts | Uncertain identity/semantics require review before dependency promotion |
| Decision | incident_commander accepts/rejects; incident_commander or analyst modifies/annotates | Analyst cannot accept/reject; viewer cannot issue review commands |
| Delivery | Source-linked printable HTML and bounded JSON for one committed revision | Browser print can save PDF; automatic server PDF generation is later work |
| Monitoring | Manual runs first; one gated 30-minute scheduled workflow later | Disabled until manual acceptance and named-target/budget/cadence configuration |

The three-candidate/two-crew demonstration fits inside these bounds. Crew names and travel allowances are labeled demo inputs, never agency assignments. A reproduced official notice sequence may be replayed without implying a present-day closure. Missing live hazard inputs stay Unknown even when document retrieval succeeds.

Public viewers receive redacted read-only views. A judge who must exercise decisions receives an isolated demo account with the actual incident_commander role, separately from public browsing. "Judge" is an access purpose, not a new database role. Source-registry editing is initially an operator-reviewed configuration change, not a model tool or unrestricted settings form.

## Release requirements and extensions

All 25 requirements and the complete bounded workflow remain release requirements. Source-dependent inherited features may honestly remain limited; they cannot be displayed as verified. Scheduled monitoring is an operational capability gated after the manual workflow passes; the judge journey does not depend on an unpredictable notice arriving during the video.

Voice, multimodal/OCR ingestion, arbitrary uploads to inference, free-form assistant chat, additional counties, extra model providers, a separate Nebius GPU worker, automatic optimal routing and unattended physical action are extensions. They do not enter the build by adding a sponsor checkbox. Use Nemotron through Token Factory and Tavily as meaningful runtime components; retain the inherited frontend/database/worker stack unless a measured requirement forces a change.

## Feedback and portability

SEN-R025 requires a safe optional correction capability in the existing review flow. Providing learning permission is not required to use the product. No automatic training or policy promotion is included. [Data/API contracts](DATA_AND_API_CONTRACTS.md) own the record and portable briefing fields. All 25 inherited capabilities remain accounted for in the [baseline](FIREAFTER_BASELINE.md). Five added feature groups remain: retrieval/versioning; comparison/dependencies; constrained proposals; decisions/corrections/history; portable briefings/review evidence.

## Success and feasibility

Field usefulness and buyer authority require real discovery. [Evaluation](EVALUATION_AND_TEST_PLAN.md) owns metrics and evidence; [BUILD_PLAN](../BUILD_PLAN.md) owns feasibility checkpoints. No lives-saved, field-accuracy, endorsement or prize probability is assumed.
