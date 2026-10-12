import assert from "node:assert/strict";
import test from "node:test";
import { createIssuanceFixture, NEW_USER_ID, EXISTING_USER_ID, OPERATOR_USER_ID } from "./operator-account-fixture.mjs";
import {
  DEFAULT_ORGANIZATION_ID,
  issueOperatorAccount,
  normalizeOperatorRole,
  validateOperatorAccountInput,
} from "./operator-account.mjs";

const validInput = {
  email: "Responder@example.com",
  password: "A new password 123!",
  role: "responder",
  operatorIdentity: "caller-controlled@example.com",
  operatorUserId: OPERATOR_USER_ID,
  confirmation: "ISSUE",
  attemptId: "93b741aa-77a6-4b12-a111-123456789012",
};

test("requires operator-known attempt identity before any mutation", async () => {
  const fake = createFakeSupabase();
  await assert.rejects(issueOperatorAccount({ supabase: fake, verificationClient: fake,
    ...validInput, attemptId: undefined }), /ATTEMPT_ID/);
  assert.equal(fake.calls.length, 0);
});

test("partial issuance is not recorded as failed or rolled back", async () => {
  const fake = createFakeSupabase(null, "organization_members");
  await assert.rejects(issueOperatorAccount({ supabase: fake, verificationClient: fake, ...validInput }));
  assert.equal(fake.calls.some(call => call.type === "createUser"), true);
  assert.equal(fake.calls.some(call => call.table === "operator_account_issuance_events" && call.values?.event_type === "failed"), false);
});

test("maps human-facing roles to canonical database roles", () => {
  assert.deepEqual(normalizeOperatorRole("responder"), {
    requestedRole: "responder",
    databaseRole: "incident_commander",
    access: "operational_write",
  });
  assert.deepEqual(normalizeOperatorRole("reviewer"), {
    requestedRole: "reviewer",
    databaseRole: "analyst",
    access: "operational_write",
  });
  assert.deepEqual(normalizeOperatorRole("viewer"), {
    requestedRole: "viewer",
    databaseRole: "viewer",
    access: "read_only",
  });
});

test("requires explicit operator confirmation and rejects weak credentials", () => {
  assert.throws(
    () => validateOperatorAccountInput({ ...validInput, confirmation: "" }),
    /fail-closed/,
  );
  assert.throws(
    () => validateOperatorAccountInput({ ...validInput, password: "short" }),
    /between 12 and 1024/,
  );
  assert.throws(
    () => validateOperatorAccountInput({ ...validInput, role: "admin" }),
    /reviewer, responder, or viewer/,
  );
});

test("requires authenticated operator identity and ignores caller-supplied attribution", async () => {
  assert.throws(
    () => validateOperatorAccountInput({ ...validInput, operatorUserId: undefined }),
    /Authenticated operator identity is missing or invalid/,
  );
  const fake = createFakeSupabase();
  const report = await issueOperatorAccount({ supabase: fake, operatorClient: fake, verificationClient: fake, ...validInput });
  assert.equal(report.operatorUserId, OPERATOR_USER_ID);
  assert.equal(report.operatorIdentity, OPERATOR_USER_ID);
  assert.equal(report.operatorIdentitySource, "authenticated_supabase_user");
});

test("issues a new account and persists its organization membership", async () => {
  const fake = createFakeSupabase();
  const report = await issueOperatorAccount({
    supabase: fake,
    verificationClient: fake,
    ...validInput,
  });

  assert.equal(report.ok, true);
  assert.equal(report.created, true);
  assert.equal(report.databaseRole, "incident_commander");
  assert.equal(report.access, "operational_write");
  assert.equal(report.passwordIssued, true);
  assert.equal(report.membershipVerified, true);
  assert.equal(report.loginVerified, true);
  assert.equal(report.authenticatedMembershipVerified, true);
  assert.equal(report.issuanceAuditRecorded, true);
  assert.equal("password" in report, false);

  const organizationWrite = fake.calls.find(
    (call) => call.table === "organizations",
  );
  assert.equal(organizationWrite.values.id, DEFAULT_ORGANIZATION_ID);

  const membershipWrite = fake.calls.find(
    (call) => call.table === "organization_members",
  );
  assert.equal(membershipWrite.values.role, "incident_commander");
  assert.equal(membershipWrite.values.user_id, NEW_USER_ID);

  const issuanceEvents = fake.calls.filter(
    (call) => call.type === "insert" && call.table === "operator_account_issuance_events",
  );
  assert.deepEqual(issuanceEvents.map((call) => call.values.event_type), [
    "started",
    "succeeded",
  ]);
  assert.equal(issuanceEvents[0].values.account_email_hash.length, 64);
  assert.equal("password" in issuanceEvents[0].values, false);
  assert.equal(
    fake.calls.filter(
      (call) => call.type === "maybeSingle" && call.table === "organization_members",
    ).length,
    2,
  );
});

test("updates an existing account and changes its membership to viewer when requested", async () => {
  const fake = createFakeSupabase({
    id: EXISTING_USER_ID,
    email: validInput.email.toLowerCase(),
    app_metadata: { existing_flag: true },
  }, null, "viewer");
  const report = await issueOperatorAccount({
    supabase: fake,
    verificationClient: fake,
    ...validInput,
    role: "viewer",
  });

  assert.equal(report.created, false);
  assert.equal(report.databaseRole, "viewer");
  assert.equal(fake.calls.some((call) => call.type === "createUser"), false);
  assert.equal(fake.calls.some((call) => call.type === "updateUserById"), true);
  assert.equal(
    fake.calls.find((call) => call.table === "organization_members").values.role,
    "viewer",
  );
  assert.equal(report.issuanceAuditRecorded, true);
});

test("fails closed with a redacted error when membership persistence fails", async () => {
  const fake = createFakeSupabase(null, "organization_members");

  await assert.rejects(
    issueOperatorAccount({
      supabase: fake,
      verificationClient: fake,
      ...validInput,
    }),
    (error) =>
      error.message.includes("Issuance coordinator outcome") &&
      !error.message.includes("internal database detail"),
  );
  assert.equal(fake.calls.some((call) => call.type === "upsert" && call.table === "organization_members"), true);
  assert.deepEqual(
    fake.calls
      .filter((call) => call.type === "insert" && call.table === "operator_account_issuance_events")
      .map((call) => call.values.event_type),
    ["started"],
  );
});

test("fails closed before Auth mutation when issuance audit persistence is unavailable", async () => {
  const fake = createFakeSupabase(null, "operator_account_issuance_events");

  await assert.rejects(
    issueOperatorAccount({
      supabase: fake,
      verificationClient: fake,
      ...validInput,
    }),
    /Issuance coordinator outcome/,
  );
  assert.equal(fake.calls.some((call) => call.type === "createUser"), false);
  assert.equal(fake.calls.some((call) => call.type === "updateUserById"), false);
});

test("requires a separate verification client before mutating the account", async () => {
  const fake = createFakeSupabase();

  await assert.rejects(
    issueOperatorAccount({ supabase: fake, operatorClient: fake, ...validInput }),
    /separate public Supabase Auth client/,
  );
  assert.equal(fake.calls.length, 0);
});

test("fails closed when the issued password cannot sign in", async () => {
  const fake = createFakeSupabase();
  fake.auth.signInWithPassword = async () => ({
    data: null,
    error: { name: "AuthApiError", message: "provider password detail" },
  });

  await assert.rejects(
    issueOperatorAccount({
      supabase: fake,
      verificationClient: fake,
      ...validInput,
    }),
    (error) =>
      error.message.includes("Supabase Auth password verification failed") &&
      !error.message.includes("provider password detail"),
  );
  assert.deepEqual(
    fake.calls
      .filter((call) => call.type === "insert" && call.table === "operator_account_issuance_events")
      .map((call) => call.values.event_type),
    ["started"],
  );
});

test("fails closed when password verification returns no authenticated session", async () => {
  const fake = createFakeSupabase();
  fake.auth.signInWithPassword = async () => ({
    data: {
      user: { id: NEW_USER_ID, email: validInput.email },
      session: null,
    },
    error: null,
  });

  await assert.rejects(
    issueOperatorAccount({
      supabase: fake,
      verificationClient: fake,
      ...validInput,
    }),
    /returned no authenticated session/,
  );
});

test("fails closed when the authenticated role cannot read its issued membership", async () => {
  const fake = createFakeSupabase(null, null, "incident_commander", "viewer");

  await assert.rejects(
    issueOperatorAccount({
      supabase: fake,
      verificationClient: fake,
      ...validInput,
    }),
    /Authenticated organization membership verification failed/,
  );
});

test("fails closed when the persisted role does not match the requested role", async () => {
  const fake = createFakeSupabase(null, null, "viewer");

  await assert.rejects(
    issueOperatorAccount({
      supabase: fake,
      verificationClient: fake,
      ...validInput,
    }),
    /Organization membership verification failed/,
  );
});

function createFakeSupabase(
  existingUser = null,
  failingTable = null,
  membershipRole = "incident_commander",
  authenticatedMembershipRole = membershipRole,
) {
  return createIssuanceFixture(existingUser, failingTable, membershipRole, authenticatedMembershipRole);
}
