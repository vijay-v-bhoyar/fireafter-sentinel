# Domain discovery and cognitive demands

No domain expert interview or field validation has occurred. This document translates known software behavior and explicit product requirements into hypotheses; the [cognitive demands table](cognitive_demands.csv) marks evidence sources and assumptions.

**Objective:** validate what a coordinator notices, which evidence can change a proposal, what requires escalation, and which constraints matter before model outputs are trusted. Primary mode: application design with targeted discovery support.

**Suggested participant:** emergency-management/public-works coordinator, GIS analyst supporting incident command, or comparable practitioner. The user arranges contact and permission. This pack contains an unsent interview agenda, not an authorization to message anyone.

**45-minute session:** 5 minutes establish role/workflow and data boundaries; 10 minutes map current notice-to-inspection steps; 15 minutes walk one real change and compare the proposed screens; 10 minutes introduce stale/conflicting/unavailable-source cases; 5 minutes prioritize improvements and confirm quote/recording permission.

| Prompt | Decision it informs | Evidence to seek |
| --- | --- | --- |
| What changed in your last briefing that made an earlier action unsuitable? | Materiality and dependency types | Concrete source, timing and affected task |
| How do you confirm a bulletin applies to the right road/county/fire? | Identity/jurisdiction gate | Identifiers, landmarks, issuer rules and ambiguity |
| What makes one notice override another, and what do you do when they conflict? | Supersession/conflict policy | Actual revision conventions; human escalation |
| Which missing inputs stop approval versus allow a limited review? | Unknown and approval boundary | Explicit task-specific stop conditions |
| How do you estimate crew/time/capability requirements? | Deterministic constraints | Existing inputs and acceptable uncertainty |
| When a source changes while someone is reviewing, what should happen? | Concurrent-update UX | Required acknowledgment and preserved decisions |
| What must a handoff briefing contain? | Export and history | Existing template and reviewer obligations |
| What data may leave your environment or appear in a public demo? | Data destination/disclosure | Organizational permissions and restrictions |
| Which failures are tolerable, and how do you recover today? | Retry/escalation/recovery | Concrete outage story and acceptable delay |
| Can you complete this task without help, and what would you change? | Usability/usefulness | Observed actions, errors and task time |

**Reasoning mapping:** stable retrieval/extraction uses plan-and-execute with bounded tool calls; conflicting alternatives use structured candidate comparison; verification separates schema/identity/temporal checks from semantic judgment; uncertain or consequential proposals hand off to the reviewer. Episodic feedback becomes reviewed cases, never automatic policy learning.

**Observability review:** ask the practitioner which source/assumption changes require immediate visibility, which status summaries are useful, and which detail belongs behind an evidence panel. **Threat/exception walkthrough:** test wrong county, superseded notice, source outage, ambiguous access, and concurrent review. These exercises are designs until actually conducted.

**Synthesis after session:** update cognitive_demands.csv with observed cues and evidence provenance; distinguish quotes, paraphrases and inferred rules; resolve materiality/escalation/constraint decisions in the register; update affected requirements and frozen labels; obtain permission before public attribution. Record disconfirming feedback rather than forcing it into the proposed architecture.
