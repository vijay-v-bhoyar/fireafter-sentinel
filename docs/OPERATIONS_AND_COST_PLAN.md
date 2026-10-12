# Operations, environments and cost

Targets and spending are unapproved. This runbook defines future work; it does not deploy or create a monitor.

**Manual run operations:** POST admission now invokes the local Workflow dispatcher. Keep the original command UUID across uncertain admission/startup; dispatchPending means startup is unconfirmed. The same logical run has at most four scheduler claims and never gains a fresh deadline or budget. Known active SDK invocations are reused; unknown outcomes retain conservative holds. The worker uses private stage storage and no automatic transport/step retry; lost paid output is held/failed rather than recharged under the same attempt. Corpus modes require operator-provisioned scoped full-text evidence and a recorded policy clock; they do not call Tavily. Scheduled activation, actual target/runtime recovery, and funded real account qualification remain pending.

**Environment separation:** local development, then a disposable migration/integration target, then a dedicated judge deployment/database. Keep existing FireAfter production separate. Use server-side provider keys, independent project bindings, scoped demo organizations and explicit target checks in every inherited deployment/smoke script. Fixtures/replay/synthetic modes are isolated from live records.

**Configuration inventory:** [.env.example](../.env.example) owns implemented variable names. Target guards use SENTINEL_TARGET_SUPABASE_URL, SENTINEL_PROTECTED_SUPABASE_URLS, SENTINEL_ALLOW_LOCAL_DB, SENTINEL_TARGET_APP_URL, SENTINEL_PROTECTED_APP_URLS, SENTINEL_TARGET_REPO_ROOT and SENTINEL_TARGET_REPOSITORY_URL. Provider configuration uses SENTINEL_NEBIUS_API_KEY, SENTINEL_NEBIUS_BASE_URL, SENTINEL_NEMOTRON_EXTRACTION_MODEL, SENTINEL_NEMOTRON_RECONCILIATION_MODEL, SENTINEL_TAVILY_API_KEY, SENTINEL_BUDGET_CEILING and SENTINEL_TOKENIZER_EVIDENCE_HASH. Native signing names are described below; SENTINEL_MONITOR_ENABLED remains false. Retain required inherited variable names with new-purpose values. Architecture owns fixed code/schema ceilings; no document-only MAX_DOCS, MAX_TOKENS, timeout, cadence or public-URL variable configures them. Secret values never belong in docs, chat, maps or receipts.

**Provisioning:** owner selects exact accounts/projects/regions and budget, verifies credits/expiration, and provides keys through environment configuration. Apply inherited plus new schema on disposable resources, verify authorization and command/recovery semantics, then deploy a source-bound release to the named judge target. Confirm target identity and live readback, not only deploy command success.

**Native signing setup, not yet configured:** the server implementation reads SENTINEL_NATIVE_SIGNING_KEY_ID, SENTINEL_NATIVE_SIGNING_ORGANIZATION_ID and SENTINEL_NATIVE_SIGNING_KEY_HEX. The environment example contains these names with blank values; this does not configure or authorize a key. Configure only this app with a separate 32-byte key (64 lowercase hexadecimal characters) and UUID identifiers, and provision its matching owner-qualified row in sentinel_native_signing_keys on the admitted new database. Keep secret material in secure server/database configuration, never documentation or evidence. Record qualification/validity and key identity, not the key. Runtime cannot read or provision the key table. Missing/revoked/expired authority leaves native snapshots unbound. Rotation needs a reviewed overlap and replay/checkpoint compatibility test; no rotation or key provisioning occurred.

**Cost calculation:** multiply expected inference input/output tokens by the account's actual model prices, and Tavily requests/credits by the verified account tariff; add hosting/database/worker charges and a failed-run/retry allowance. Real price lookup and credit balance are pending. On the admitted new database, its owner must provision exact current operation/model prices in sentinel_provider_prices and absolute cumulative money/unit ceilings in sentinel_provider_funds with actual authority-evidence hashes. Never use fixture prices or evidence hashes. SQL counters cannot reset/refund; any additional funding or replacement qualification needs an owner action. Runtime has no grant/table-write privileges. SENTINEL_TOKENIZER_EVIDENCE_HASH must identify the reviewed account/model/token-bound qualification and match the price record before Nemotron dispatch. No dollar-per-run number is invented. Reserve usage before dispatch; reconcile actual provider usage, conservatively count uncertain attempts, and stop at the owner ceiling. Track spending through December 15, not just build week.

**Monitoring:** proposed 30-minute source cadence and bounded backoff after manual core acceptance. First qualify the inherited Workflow runtime on the new target; persist dispatch/reconciliation and reserve original per-run/organization budgets as [architecture](ARCHITECTURE.md) specifies. UI polling only observes. A later explicit schedule configuration is required. Notify only for actionable failure, budget stop, stale dependencies or recovery needs.

**Health:** expose last successful check per source, worker lease/stage, pending review count, blocked approvals, provider errors/rate limits, budget balance and deployed revision. Internal diagnostics are not release approval. Separate current-source absence from an empty dataset.

**Incident recovery:**

- Provider outage: the current worker holds/fails the attempt without automatic retry; preserve last successful version/age and dependent plan validity. A later qualified monitoring circuit/backoff remains planned.
- Worker crash: reacquire lease with fence; resume original checkpoint/deadline/budget; late worker cannot publish.
- Unknown decision result: status/reconcile original command; never duplicate blindly.
- Bad extraction/version: quarantine and correction event; new draft; retain prior records.
- Failed migration/release: verify backup/restore plan on new target; roll back application to a compatible release; never destructively downgrade schema or rewrite history without a reviewed plan.
- Export interruption: retain the complete server artifact and its hash, discard the incomplete client body, then retry the same authorized revision. Artifact creation and client download preparation have different receipts; browser disk-save confirmation is unavailable.

**Runtime circuit and secret handling:** fixed provider base URLs are server configuration, not request fields. Aggregate attempts/bytes/tokens/credits and durable uncertain-attempt reservations cannot reset with lease takeover or runtime retry. Disable a failing provider stage after its bounded attempts, retain safe trace IDs and show incomplete checks. A monitoring pause does not erase evidence age or authorize an approval. Keep all source-registry activation operator-reviewed.

**Source operator admission:** on the admitted new target, the database owner provisions sentinel_source_operators for the intended operator and organization. This purpose admission is distinct from account-issuance authorization and requires current incident_commander membership for activation. Runtime roles have no table privileges or self-enrollment. The private activation command preserves its original UUID after uncertainty, uses expectedConfigRevision, and fences old workers on configuration change without resetting their usage. No admission or activation has been performed against cloud resources; no browser/model activation endpoint exists.

**Launch evidence:** exact source/config/model versions, applied schema/control versions, provider traces, authorization negatives, recovery rehearsal, public redaction, fresh-browser judge workflow and budget health. The owner reviews a concrete verified deployment candidate before public release.

**Judging availability:** freeze the submitted revision and keep its dedicated demo accessible through the official end of judging. Maintain purpose-scoped credentials on the isolated new demo, with the complete free judge workflow, reproducible labeled replay and live retrieval path; no waitlist or manual admission. Record outages and any organizer-approved changes. Expired source information cannot be relabeled live.

## Target admission and judge capacity

The [target registry](PROJECT_ISOLATION.md) applies to every deploy, migrate, ingest, storage, smoke and schedule command. A schema/org inside FireAfter is insufficient; require distinct project/database/auth/storage identities and new-purpose credentials. Unknown/mismatched identity fails before a call. Reserve sufficient Sentinel capacity through judging; safety/data isolation cannot become an artificial judge-access restriction. Numerical runtime caps belong to [architecture](ARCHITECTURE.md), not independent configuration defaults.

## Recoverable operator account issuance

Use the supported `npm.cmd run issue:account` CLI only after destination and identity guards admit the new Sentinel project. Never issue into FireAfter. Configure FIREAFTER_OPERATOR_AUTH_EMAIL and FIREAFTER_OPERATOR_AUTH_PASSWORD for a separately authorized operator and FIREAFTER_OPERATOR_ACCOUNT_EMAIL, FIREAFTER_OPERATOR_ACCOUNT_PASSWORD and FIREAFTER_OPERATOR_ACCOUNT_ROLE for the intended new-project account; inherited variable names do not authorize inherited credentials. Judge role responder maps to incident_commander. Secrets belong in secure local/server configuration.

Create one original attempt UUID before the first request:

```powershell
$env:FIREAFTER_OPERATOR_ATTEMPT_ID = [guid]::NewGuid().ToString()
```

Set FIREAFTER_OPERATOR_MODE=issue for initial execution. After an uncertain response, retain that same attempt and use status/reconcile; do not mint another identity or assume the password/account mutation failed. Reconcile the original attempt UUID and prove current login/membership separately from the receipt. Rotation uses the same recoverable contract and an intentionally selected new password; no credential is embedded in documentation.

Target-safe bootstrap on a fresh database requires operator_account_issuance_operators admission through the controlled migration/operator process. It is not self-enrollment; do not grant table writes to `service_role`. Required inherited control versions are owned once by [evaluation](EVALUATION_AND_TEST_PLAN.md). No operator or judge account has been issued in Sentinel.

Owner-approved feedback reuse grants are provisioned only on the new target by its database owner, after actual processing authority and retention policy are resolved. Bind the exact data owner, grantee, organization/incident/mode, purpose/destination, grant/expiry, retention revision and authority-evidence hash in sentinel_permission_records. Runtime roles have no raw table or grant-issuance privileges. Revocation is a first, irreversible owner update; a new authorization requires a new grant, not expansion or reactivation of the old record. No real grant has been provisioned; synthetic SQL fixtures do not prove data-owner authority.
