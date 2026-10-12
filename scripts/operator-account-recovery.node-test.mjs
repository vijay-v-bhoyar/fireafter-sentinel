import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { issueOperatorAccount, reconcileOperatorAccount } from "./operator-account.mjs";
import { createOperatorFetch, getOperatorAccountIssuance, issuanceRpc } from "./operator-account-coordinator.mjs";
import { createIssuanceFixture, EXISTING_USER_ID, OPERATOR_USER_ID } from "./operator-account-fixture.mjs";
import { hasValidPostgresSyntax, buildMigrationContractReport, loadMigrationContractFiles } from "./migration-contract-verifier.mjs";

const input = { email: "responder@example.com", password: "A new password 123!", role: "responder",
  operatorIdentity: "caller-controlled@example.com", operatorUserId: OPERATOR_USER_ID, confirmation: "ISSUE", attemptId: "93b741aa-77a6-4b12-a111-123456789012" };
const invoke = (fixture, values = input) => issueOperatorAccount({ supabase: fixture, operatorClient: fixture, verificationClient: fixture, ...values });
const recover = (fixture, values = input) => reconcileOperatorAccount({ supabase: fixture, operatorClient: fixture, verificationClient: fixture, ...values });
const authWrites = fixture => fixture.calls.filter(call => ["createUser", "updateUserById"].includes(call.type)).length;
const terminal = fixture => fixture.calls.filter(call => call.table === "operator_account_issuance_events" && call.values.event_type === "succeeded").length;

for (const stage of ["createUser", "updateUserById", "membership", "succeeded"]) {
  for (const after of [false, true]) {
    test(`${stage}: ${after ? "after" : "before"}-commit failure preserves reference and prevents Auth replay`, async () => {
      const fixture = createIssuanceFixture(stage === "updateUserById" ? { id: EXISTING_USER_ID, email: input.email, app_metadata: {} } : null);
      fixture.failNext(stage, after);
      await assert.rejects(invoke(fixture), error => error.code === "ISSUANCE_UNCONFIRMED" && error.attemptId === input.attemptId && !error.message.includes("internal database detail"));
      const writes = authWrites(fixture);
      await assert.rejects(invoke(fixture), /status\/reconcile/);
      assert.equal(authWrites(fixture), writes);
      const authFailedBeforeCommit = ["createUser", "updateUserById"].includes(stage) && !after;
      if (authFailedBeforeCommit) {
        await assert.rejects(recover(fixture), /unconfirmed or superseded/);
        assert.equal(terminal(fixture), 0);
      } else {
        const result = await recover(fixture);
        assert.equal(result.state, "succeeded");
        assert.equal(result.attemptId, input.attemptId);
        assert.equal(terminal(fixture), 1);
        assert.equal((await recover(fixture)).receiptOnly, true);
      }
      assert.equal(authWrites(fixture), writes);
      assert.equal(fixture.calls.some(call => call.values?.event_type === "failed"), false);
    });
  }
}

for (const after of [false, true]) test(`begin response failure ${after}: no Auth dispatch`, async () => {
  const fixture = createIssuanceFixture(); fixture.failNext("begin", after);
  await assert.rejects(invoke(fixture), /coordinator/);
  assert.equal(authWrites(fixture), 0);
  if (after) {
    await assert.rejects(invoke(fixture), /already exists/);
    await assert.rejects(recover(fixture), /unconfirmed or superseded/);
  }
  assert.equal(authWrites(fixture), 0);
});

test("one pending email excludes a different cooperative attempt across organizations", async () => {
  const fixture = createIssuanceFixture(); fixture.failNext("createUser", true);
  await assert.rejects(invoke(fixture));
  await assert.rejects(invoke(fixture, { ...input, attemptId: "93b741aa-77a6-4b12-a111-123456789013",
    organizationId: "93b741aa-77a6-4b12-a111-123456789014" }), /coordinator/);
  assert.equal(authWrites(fixture), 1);
});

test("reconcile does not restore a concurrently changed membership", async () => {
  const fixture = createIssuanceFixture(); fixture.failNext("membership", true);
  await assert.rejects(invoke(fixture));
  fixture.state.memberVersion++;
  await assert.rejects(recover(fixture), /coordinator/);
  assert.equal(authWrites(fixture), 1); assert.equal(terminal(fixture), 0);
});

test("changed request and superseded Auth marker cannot reconcile", async () => {
  const fixture = createIssuanceFixture(); fixture.failNext("createUser", true);
  await assert.rejects(invoke(fixture));
  await assert.rejects(recover(fixture, { ...input, role: "viewer" }), /different request/);
  fixture.state.user.app_metadata.fireafter_issuance_attempt_id = "other-attempt";
  await assert.rejects(recover(fixture), /unconfirmed or superseded/);
  assert.equal(terminal(fixture), 0); assert.equal(authWrites(fixture), 1);
});

test("a successful historical receipt never regrants access or claims a current login", async () => {
  const fixture = createIssuanceFixture(); await invoke(fixture);
  fixture.state.password = "rotated outside issuer"; fixture.state.memberVersion++;
  const calls = fixture.calls.length;
  const result = await recover(fixture);
  assert.equal(result.receiptOnly, true); assert.equal(result.currentAccessVerified, false);
  assert.equal(result.loginVerified, false); assert.equal(result.operatorIdentitySource, "authenticated_supabase_user");
  assert.deepEqual(fixture.calls.slice(calls).map(call => call.stage), ["status"]);
});

test("password verification failure preserves committed membership without false success", async () => {
  const fixture = createIssuanceFixture(); fixture.failNext("login");
  await assert.rejects(invoke(fixture), /password verification/);
  const receipt = await getOperatorAccountIssuance({ supabase: fixture, attemptId: input.attemptId });
  assert.equal(receipt.state, "membership_committed"); assert.equal(terminal(fixture), 0);
  assert.equal((await recover(fixture)).currentAccessVerified, true);
});

test("new coordinator RPC calls use the real SDK with explicit fixture HTTP and no retries", async () => {
  const fixture = createIssuanceFixture(); await invoke(fixture);
  const receipt = await getOperatorAccountIssuance({ supabase: fixture, attemptId: input.attemptId });
  const requests = [];
  const supabase = createClient("https://fixture.invalid", "nonsecret-test-key", { global: { fetch: async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init.body) });
    return Response.json(receipt);
  } } });
  assert.equal((await getOperatorAccountIssuance({ supabase, attemptId: input.attemptId })).state, "succeeded");
  assert.equal(requests.length, 1); assert.match(requests[0].url, /\/rest\/v1\/rpc\/fireafter_get_account_issuance_as_operator$/);
  assert.deepEqual(requests[0].body, { p_attempt_id: input.attemptId });
  const broken = createClient("https://fixture.invalid", "nonsecret-test-key", { global: { fetch: async () => Response.json({ message: "private diagnostic" }, { status: 500 }) } });
  await assert.rejects(issuanceRpc(broken, "fireafter_get_account_issuance_as_operator", { p_attempt_id: input.attemptId }), error => !error.message.includes("private diagnostic"));
});

test("malformed coordinator response never grants dispatch", async () => {
  const fixture = createIssuanceFixture();
  fixture.rpc = () => ({ abortSignal() { return this; }, retry: async () => ({ data: { claimed: true } }) });
  await assert.rejects(invoke(fixture), /coordinator/); assert.equal(authWrites(fixture), 0);
});

test("UUID inputs are canonical before a durable intent can be committed", async () => {
  const fixture = createIssuanceFixture();
  const result = await invoke(fixture, { ...input, attemptId: input.attemptId.toUpperCase(),
    organizationId: "F5CABBf4-8E88-5F01-AF0C-15E201847C49" });
  assert.equal(result.attemptId, input.attemptId);
  assert.equal(result.organizationId, "f5cabbf4-8e88-5f01-af0c-15e201847c49");
});

test("candidate preserves membership generations across absent-row grant/revoke", () => {
  const sql = readFileSync("supabase/migrations/20260914140000_operator_account_recovery.sql", "utf8");
  assert.ok(sql.includes("operator_account_membership_versions"));
  assert.ok(sql.includes("after insert or update or delete on public.organization_members"));
  assert.ok(sql.includes("member_generation is distinct from a.membership_generation"));
});

test("aggregate migration gate rejects deleted fences, bypasses, grants and missing coordinator", () => {
  const files = loadMigrationContractFiles();
  const path = "supabase/migrations/20260914140000_operator_account_recovery.sql";
  assert.equal(buildMigrationContractReport(files).ok, true);
  for (const sql of [null, files[path].replace("member_generation is distinct from a.membership_generation then", "false then"),
    files[path] + "\ngrant all on table public.operator_account_issuance_attempts to authenticated;",
    files[path].replace("enable always trigger fireafter_account_membership_generation", "disable trigger fireafter_account_membership_generation")]) {
    const report = buildMigrationContractReport({ ...files, [path]: sql });
    assert.equal(report.ok, false);
    assert.equal(report.migrations.find(migration => migration.id === "operatorAccountRecovery").ok, false);
  }
});

test("real Auth and PostgREST SDK recover a lost Auth response using only explicit fixture transport", async () => {
  const fixture = createIssuanceFixture();
  let loseAuthResponse = true;
  const requests = [];
  const transport = async (inputUrl, init) => {
    const url = new URL(inputUrl);
    assert.equal(url.hostname, "fixture.invalid");
    requests.push(`${init.method} ${url.pathname}`);
    const body = init.body ? JSON.parse(init.body) : {};
    if (url.pathname === "/auth/v1/admin/users" && init.method === "GET") return Response.json({ users: fixture.state.user ? [fixture.state.user] : [], total: fixture.state.user ? 1 : 0 });
    if (url.pathname === "/auth/v1/admin/users" && init.method === "POST") {
      const result = await fixture.auth.admin.createUser(body);
      if (loseAuthResponse) { loseAuthResponse = false; return Response.json({ msg: "private diagnostic" }, { status: 502 }); }
      return Response.json(result.data.user);
    }
    if (url.pathname === "/auth/v1/token") {
      const result = await fixture.auth.signInWithPassword(body);
      if (result.error) return Response.json({ msg: "invalid test credentials" }, { status: 400 });
      return Response.json({ user: result.data.user, access_token: "test-only-access-token", refresh_token: "test-only-refresh-token", expires_in: 3600, token_type: "bearer" });
    }
    if (url.pathname.startsWith("/rest/v1/rpc/")) {
      const result = await fixture.rpc(url.pathname.split("/").at(-1), body).abortSignal().retry(false);
      return Response.json(result.error ? { message: "test conflict" } : result.data, { status: result.error ? 409 : 200 });
    }
    if (url.pathname === "/rest/v1/organization_members") return Response.json((await fixture.from("organization_members").select().maybeSingle()).data);
    throw new Error(`Unexpected test endpoint: ${url.pathname}`);
  };
  const options = { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: createOperatorFetch(transport) } };
  const supabase = createClient("https://fixture.invalid", "test-only-service", options);
  const operatorClient = createClient("https://fixture.invalid", "test-only-public", options);
  const verificationClient = createClient("https://fixture.invalid", "test-only-public", options);
  await operatorClient.auth.signInWithPassword({ email: "operator@example.com", password: "operator password 123!" });
  await assert.rejects(issueOperatorAccount({ supabase, operatorClient, verificationClient, ...input }), /unconfirmed/);
  const report = await reconcileOperatorAccount({ supabase, operatorClient, verificationClient, ...input });
  assert.equal(report.currentAccessVerified, true);
  assert.equal(requests.filter(request => request === "POST /auth/v1/admin/users").length, 1);
  assert.equal(requests.filter(request => request === "POST /auth/v1/token").length, 2);
  assert.equal(terminal(fixture), 1);
});

test("the operation deadline cancels a stalled body rather than accepting a partial response", async () => {
  const controller = new AbortController();
  let canceled = false;
  const response = new Response(new ReadableStream({ cancel() { canceled = true; } }));
  const work = createOperatorFetch(async () => response, controller.signal)("https://fixture.invalid");
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(work);
  assert.equal(canceled, true);
});

test("operator HTTP transport bounds complete bodies and retains provider status", async () => {
  const bounded = createOperatorFetch(async () => Response.json({ message: "unavailable" }, { status: 503 }));
  const result = await bounded("https://fixture.invalid"); assert.equal(result.status, 503);
  assert.deepEqual(await result.json(), { message: "unavailable" });
  const oversized = createOperatorFetch(async () => new Response(new Uint8Array(2 * 1024 * 1024 + 1)));
  await assert.rejects(oversized("https://fixture.invalid"), /byte budget/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(createOperatorFetch(async () => new Response("late"), abort.signal)("https://fixture.invalid"));
});

test("CLI rejects invalid mode before provider access", () => {
  const result = spawnSync(process.execPath, ["scripts/issue-account.mjs"], {
    encoding: "utf8", env: { ...process.env, FIREAFTER_OPERATOR_MODE: "invalid-test-mode" }, timeout: 10_000,
  });
  assert.equal(result.status, 1); assert.match(result.stderr, /must be issue, status, or reconcile/);
});

test("candidate SQL syntax and explicit boundaries are present, not runtime SQL proof", () => {
  const sql = readFileSync("supabase/migrations/20260914140000_operator_account_recovery.sql", "utf8");
  assert.equal(hasValidPostgresSyntax(sql), true);
  for (const fragment of ["set local lock_timeout = '2s'", "enable row level security", "from public, anon, authenticated, service_role",
    "operator_account_issuance_one_pending_email", "pg_advisory_xact_lock", "member_generation is distinct from a.membership_generation",
    "fireafter_issuance_attempt_id", "for update", "for share", "on conflict(id) do nothing", "event_type = 'started'"]) assert.ok(sql.includes(fragment), fragment);
  assert.equal(/\b(?:update|delete from)\s+auth\./i.test(sql), false);
  assert.equal(sql.includes("'failed'"), false);
});
