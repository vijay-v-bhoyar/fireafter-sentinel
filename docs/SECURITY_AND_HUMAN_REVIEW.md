# Security, trust and human review

Required controls for the concrete workflow. Some controls are implemented and locally tested; full-target and independent security acceptance remain pending. The decision register owns executed results. This is not an independent security assessment or release approval.

**Trust boundaries:** browser input to server admission; source registry to public retrieval; fetched text to model interpretation; model output to validators; validated draft to human review; decision command to transactional store; private retained evidence to role-filtered response/export. Each boundary rejects untrusted authority and cross-scope identifiers.

| Threat / mistake | Required control | Verification |
| --- | --- | --- |
| Source text instructs the agent to expose keys or approve a task | No model-side privileged tools; allowlisted workflow; source text treated as data | Adversarial page fixture and live-config inspection |
| Malicious extracted URL asks to target local services | Registered HTTPS URL admission; fixed provider endpoints; no arbitrary app fetch; remote crawler hops not attested | No request sent for disallowed URL; returned provenance/partial results held |
| Wrong county, asset or issuer is linked | Incident membership, jurisdiction and identity checks; ambiguous candidate review | Cross-jurisdiction/cross-asset cases |
| A citation exists but does not support the claim | Schema/excerpt checks plus semantic support review; critical demo claims manually checked | Human labels and unsupported-claim cases |
| Evidence changes during approval | Shared incident generation lock; expiry and constraints checked at commit | Real database concurrency test |
| Public role reads private facility details via new endpoint/export | Apply existing redaction to every new projection; private blob authorization | Response, map, briefing and trace probes |
| Service key bypasses caller access | Session/role checks before privileged RPC; scoped records and relationships | Cross-org/cross-incident negative tests |
| Lost response creates duplicate decisions | Actor-scoped operation key; command/audit/receipt atomic; status reconciliation | Replay, conflict and process-interruption tests |
| Leaked prompts/logs expose data | Server-only keys; role-redacted traces; no raw source text in routine logs | Repository/client bundle/log review |
| Monitoring consumes unbounded credits | Reserved cumulative usage, hard stops, rate limits, bounded retries | Budget exhaustion and restart tests |

**Human authority:** use the exact incident_commander, analyst and viewer role matrix in [API contracts](DATA_AND_API_CONTRACTS.md). Only incident_commander accepts/rejects plans. An isolated judge account uses that actual role; public viewing stays redacted/read-only. Model text cannot confer privileges. Modify creates a new draft requiring a subsequent accept. No UI/model action declares a completed field inspection or official closure/evacuation.

**Rendering and disclosure:** source/model text renders as escaped plain text; do not insert returned HTML or executable Markdown links. Bound and validate links separately. New structured export is JSON; if CSV is later introduced, test formula neutralization. Briefing print contains the same safe text and authorized projection. Private notes and facility identifiers stay out of model/Search payloads by default. A source saying something persuasive never hides unresolved evidence or disables review requirements.

**Adversarial acceptance:** [red-team plan](RED_TEAM_PLAN.md) and [probe manifest](red_team_probes.csv) define synthetic canaries, negative database/browser/network oracles and bounded adaptive trajectories. All probes are designed, not executed. Any Critical or unresolved High runtime finding blocks the candidate; a static-only green corpus is insufficient. No probe targets existing FireAfter production.

**Review triggers:** unknown jurisdiction/entity, conflicting issuers, missing effective date that matters, incomplete extraction, uncertain semantic support, missing task/crew estimates, expired evidence, pending materiality, or changed source/constraint revision. Escalation shows the missing evidence and the decision required. Routine low-impact narration may display with an Unverified interpretation label, but cannot support operational approval.

**History and correction:** append corrections/new revisions; preserve prior evidence and reviewer actions. A historical approval stays a historical approval. User deletion/retention policy must be decided before private real-world uploads; the planning pack itself creates no deletion jobs or policy exceptions.

**Proposed retention:** keep decision and source lineage through judging; proposed 90-day permitted source/excerpt retention and 30-day redacted debugging traces, subject to owner/source terms and operational needs. Do not delete dependency evidence while retained decisions require it. Retention values are unapproved defaults and need a coherent archival strategy.

**External execution boundaries:** new cloud/database targets, paid budget, private data-to-provider destination, public source publication and submission are separately identified in the decision register. Public source viewing and local design do not establish authority for production writes or paid calls.

## Source protection and reviewer signals

Native mode authority requires a verified acquisition receipt and stored-row HMAC binding under an organization-scoped owner key. Plain labels, cached/custom content without retained authority, changed row fields and cross-scope receipts cannot authorize approval. Key rows are private to the database owner; secrets never enter browser payloads, project maps or logs. Signing proves the scoped acquisition/storage lineage, not the factual accuracy of the feed. Synthetic local producer integration has test coverage; fresh-target key controls and real concurrency remain unaccepted; see the [architecture](ARCHITECTURE.md#native-acquisition-and-stored-row-authority).

[Isolation](PROJECT_ISOLATION.md) requires a new repo/app/fresh database/auth/storage and target guards before calls. FireAfter remains read-only; its production credentials and private records are excluded. Operational review authority is distinct from owner-authorized offline reuse in [data/API contracts](DATA_AND_API_CONTRACTS.md). Private corrections/canaries stay outside model, Tavily, routine telemetry and unauthorized exports. Missing/revoked permission excludes learning reuse; retained text cannot promote policy. E36/E37 and RT17/RT18 cover these surfaces; execution remains pending.

Inherited database controls must satisfy the [evaluation release requirements](EVALUATION_AND_TEST_PLAN.md#inherited-database-release-controls).
