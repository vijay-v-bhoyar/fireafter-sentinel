# New app, new repository, new database

Final planning specification. This is a mandatory implementation constraint from the user, not an optional hosting choice. A 444-file local baseline import exists; new private Git and separate Vercel project exist; full hosted target-guard acceptance remains pending. Requirement SEN-R001 owns this boundary.

## Protected source and destinations

FireAfter checkout: C:/Users/vijay/OneDrive/Documents/FireAfter. Protected remote: https://github.com/vijay-v-bhoyar/FireAfter.git. Protected deployment: https://fireafter-app.vercel.app/. Its database/auth/storage/project identifiers must be placed in a private deny-list before credentialed work; do not discover them by calling production or copying secret values. Owner-supplied identifiers are sufficient. Missing protected identifiers or destination identity means live writes cannot start.

Sentinel project root: C:/Users/vijay/OneDrive/Documents/ChatGPT/Nebius nvidia. This workspace has its own independent initialized Git repository; current commit/push evidence belongs to the decision register. Its new private remote is https://github.com/vijay-v-bhoyar/fireafter-sentinel.git, created and linked October12. Source is committed and pushed privately on main; verified local/remote commit receipts belong to the decision register. Separate Vercel project fireafter-sentinel exists in selected team vijayvbhoyar-8312s-projects; no deployment/domain binding yet. A separate local Supabase database exists; hosted Supabase org xegngvhpnyggiwsvupji is selected but at its active-free-project limit. No existing project is paused/upgraded, and authorized spend is $0. Public source licensing/publication remains pending. A separate schema or organization in FireAfter's database does not satisfy this requirement.

| Resource | Required new identity | Current status |
| --- | --- | --- |
| Git | Independent .git and new remote; no shared worktree/submodule/origin | Independent local .git; new private vijay-v-bhoyar/fireafter-sentinel remote linked; commit/push evidence belongs to the decision register |
| App | Separate hosting project, app URL and deployment binding | Separate Vercel Hobby project created; deployment pending |
| Database | Fresh Supabase project/database and migrations | Separate local Postgres17/PostGIS database, complete chain plus forward recovery repair applied; hosted fresh project blocked by free capacity and explicitly on hold; local build/CI continues |
| Auth | New project's users, sessions, issuer and redirect URLs | Not created |
| Storage | New project's buckets and policies | Not created |
| Automation | Separate workflow, cron and webhook targets | Disabled/not created |
| Secrets | New-purpose credentials, securely configured | Not copied/configured |

## Baseline import protocol

Read FireAfter source and its graph/instructions without rebuilding its graph or changing files. Record selected tracked hashes and deliberately reviewed dirty fixes. Copy only owned source needed for the complete inherited feature inventory into Sentinel. Preserve ownership/third-party notices and exact baseline; copying is attribution-bearing reuse, not a claim of wholly new code.

Exclude .git, .env files, .vercel/.supabase link state, production connection strings, credentials, generated dependencies/builds, private exports and user records. Initialize app metadata and graph roots only in Sentinel. Inspect inherited scripts/configuration for hard-coded FireAfter domains, IDs, ingestion defaults and deploy targets before running them. Do not run a generic FireAfter deployment/smoke/migration script against its default.

Re-ingest permitted public sources or create clearly labeled synthetic/replay fixtures in the new database. Do not clone FireAfter's database, users, sessions, private operational records or storage. Do not write a compatibility patch, migration or feature change into existing FireAfter.

## Fail-before-call target contract

The implementation must maintain a private environment target registry with expected Sentinel repo remote, hosting project ID/app URL, Supabase project reference/database host, auth issuer, storage endpoint and workflow/webhook destination. Unknown values are unset, never FireAfter defaults. Public docs contain names and safe placeholders only; the deny-list contains resource identifiers, not secret values.

Before deployment, migration, ingestion, smoke, storage or reset commands: resolve the real current repo path/remote and bound target metadata; require an explicit matching Sentinel registry entry; compare against every protected FireAfter identity; reject absent, conflicting or protected identity before any network/write call. Authentication success alone does not establish destination ownership. Use provider metadata readback where available on the authorized new target; do not probe FireAfter to verify a guard. Credentials that can access FireAfter are excluded. Development and test must never fall back to production on missing configuration.

Isolation tests E37 use disposable stubs for FireAfter-looking destinations. Assert zero calls on missing/old/wrong IDs and a permitted call only for the explicitly named new target. After import and each coherent implementation batch, compare original FireAfter working-tree status and reviewed source fingerprints to the pre-action record. Any unexplained original-tree change stops the batch for investigation. Such checks do not prove that remote production was unchanged; production mutation is prevented by resource isolation and no FireAfter credentials/calls.

## Judge environment

Provision the judge organization and incident_commander account only inside the new database. Provide dedicated credentials in Devpost testing instructions if private, never in public source/video. Judges must be able to use the complete submitted workflow without payment, waitlist or manual approval through the end of judging. Public viewers remain redacted. Reserve sufficient new-target capacity; ordinary safety validation must not become an artificial restriction on judge evaluation.

Acceptance: distinct repo/app/database identities, import/provenance receipts, target-guard negative tests, new-target readback and unchanged original-source fingerprints. Local guard and transport checks have started; full isolation acceptance remains PENDING. New-target identity readback and credentialed integration have not run. The decision register owns the observed local-check status.
