import { assertDemoPasswordNotCompromised } from "./demo-credential-policy.mjs";
import { accountEmailHash, assertReceiptBinding, getOperatorAccountIssuance, issuanceRpc, validateAttemptId, validateOperatorUserId } from "./operator-account-coordinator.mjs";

export const DEFAULT_ORGANIZATION_ID =
  "f5cabbf4-8e88-5f01-af0c-15e201847c49";
export const DEFAULT_ORGANIZATION_NAME = "FireAfter Operations";
export const OPERATOR_CONFIRMATION = "ISSUE";

const AUTH_USER_PAGE_SIZE = 1000;
const MAX_AUTH_USER_PAGES = 100;
const EMAIL_MAX_LENGTH = 320;
const PASSWORD_MAX_LENGTH = 1024;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const roleDefinitions = Object.freeze({
  reviewer: { databaseRole: "analyst", access: "operational_write" },
  responder: { databaseRole: "incident_commander", access: "operational_write" },
  viewer: { databaseRole: "viewer", access: "read_only" },
});

export function normalizeOperatorRole(value) {
  const role = String(value ?? "").trim().toLowerCase();
  const definition = Object.hasOwn(roleDefinitions, role) ? roleDefinitions[role] : undefined;
  if (!definition) {
    throw new Error(
      "FIREAFTER_OPERATOR_ACCOUNT_ROLE must be reviewer, responder, or viewer.",
    );
  }

  return {
    requestedRole: role,
    databaseRole: definition.databaseRole,
    access: definition.access,
  };
}

export function validateOperatorAccountInput(input) {
  if (!input || typeof input !== "object") {
    throw new Error("Operator account input is required.");
  }

  const email = String(input.email ?? "").trim().toLowerCase();
  if (
    !email ||
    email.length > EMAIL_MAX_LENGTH ||
    !EMAIL_PATTERN.test(email)
  ) {
    throw new Error("FIREAFTER_OPERATOR_ACCOUNT_EMAIL must be a valid email address.");
  }

  const password = typeof input.password === "string" ? input.password : "";
  if (password.length < 12 || password.length > PASSWORD_MAX_LENGTH) {
    throw new Error(
      "FIREAFTER_OPERATOR_ACCOUNT_PASSWORD must be between 12 and 1024 characters.",
    );
  }
  assertDemoPasswordNotCompromised(
    password,
    "FIREAFTER_OPERATOR_ACCOUNT_PASSWORD",
  );

  const role = normalizeOperatorRole(input.role);
  const attemptId = validateAttemptId(input.attemptId);
  const operatorUserId = validateOperatorUserId(input.operatorUserId);

  if (String(input.confirmation ?? "").trim().toUpperCase() !== OPERATOR_CONFIRMATION) {
    throw new Error(
      `Account issuance is fail-closed. Set FIREAFTER_OPERATOR_CONFIRM=${OPERATOR_CONFIRMATION} to continue.`,
    );
  }

  const organizationId = String(
    input.organizationId ?? DEFAULT_ORGANIZATION_ID,
  ).trim().toLowerCase();
  if (!UUID_PATTERN.test(organizationId)) {
    throw new Error(
      "FIREAFTER_OPERATOR_ORGANIZATION_ID must be a valid UUID when provided.",
    );
  }

  return {
    attemptId,
    email,
    password,
    ...role,
    operatorUserId,
    operatorIdentity: operatorUserId,
    operatorIdentitySource: "authenticated_supabase_user",
    organizationId,
    organizationName:
      String(input.organizationName ?? DEFAULT_ORGANIZATION_NAME).trim() ||
      DEFAULT_ORGANIZATION_NAME,
  };
}

export async function issueOperatorAccount({ supabase, operatorClient, verificationClient, ...input }) {
  const account = validateOperatorAccountInput(input);
  const coordinator = operatorClient ?? verificationClient;
  if (!coordinator?.rpc) {
    throw new Error("Account issuance requires an authenticated public Supabase client for the operator coordinator.");
  }
  if (!verificationClient?.auth?.signInWithPassword) {
    throw new Error(
      "Account issuance requires a separate public Supabase Auth client to verify the issued credentials.",
    );
  }

  try {
    const existingUser = await findAuthUser(supabase, account.email);
    const intent = await issuanceRpc(coordinator, "fireafter_begin_account_issuance_as_operator", {
      p_attempt_id: account.attemptId, p_email: account.email,
      p_organization_id: account.organizationId, p_organization_name: account.organizationName,
      p_requested_role: account.requestedRole,
      p_existing_user_id: existingUser?.id ?? null,
    });
    assertReceiptBinding(intent, account);
    if (!intent.claimed || intent.state !== "auth_pending") {
      throw new Error("This attempt already exists. Use status/reconcile; an Auth mutation must not be repeated.");
    }
    const appMetadata = {
      ...(existingUser?.app_metadata ?? {}),
      fireafter_account_issued: true,
      fireafter_account_type: account.requestedRole,
      fireafter_role: account.databaseRole,
      fireafter_issued_by: account.operatorIdentity,
      fireafter_issued_at: intent.startedAt,
      fireafter_issuance_attempt_id: account.attemptId,
      fireafter_issuance_email_hash: accountEmailHash(account.email),
    };

    const user = existingUser
      ? await updateAuthUser(supabase, existingUser, account, appMetadata)
      : await createAuthUser(supabase, account, appMetadata);
    assertAuthAttempt(user, account);
    return await finishIssuance(supabase, coordinator, verificationClient, account, user.id);
  } catch (error) {
    throw pendingIssuance(error, account.attemptId);
  }
}

export async function reconcileOperatorAccount({ supabase, operatorClient, verificationClient, ...input }) {
  const account = validateOperatorAccountInput(input);
  const coordinator = operatorClient ?? verificationClient;
  if (!coordinator?.rpc) throw new Error("Reconciliation requires an authenticated public Supabase client for the operator coordinator.");
  if (!verificationClient?.auth?.signInWithPassword) throw new Error("Reconciliation requires a separate public Supabase Auth client.");
  try {
    const receipt = await getOperatorAccountIssuance({ supabase: coordinator, attemptId: account.attemptId });
    assertReceiptBinding(receipt, account);
    if (receipt.state === "succeeded") return issuanceReport(receipt, account, true);
    const user = await findAuthUser(supabase, account.email);
    assertAuthAttempt(user, account);
    return await finishIssuance(supabase, coordinator, verificationClient, account, user.id);
  } catch (error) {
    throw pendingIssuance(error, account.attemptId);
  }
}

function assertAuthAttempt(user, account) {
  if (!UUID_PATTERN.test(user?.id ?? "") || user?.email?.toLowerCase() !== account.email ||
    user.app_metadata?.fireafter_issuance_attempt_id !== account.attemptId ||
    user.app_metadata?.fireafter_issuance_email_hash !== accountEmailHash(account.email) ||
    user.app_metadata?.fireafter_role !== account.databaseRole) {
    throw new Error("Auth outcome is unconfirmed or superseded. Stop and ask the operator to inspect this original attempt; do not repeat password or account mutation.");
  }
}

async function finishIssuance(supabase, coordinator, verificationClient, account, userId) {
  const advance = async (phase) => {
    const receipt = await issuanceRpc(coordinator, "fireafter_advance_account_issuance_as_operator", {
      p_attempt_id: account.attemptId, p_user_id: userId, p_phase: phase,
    });
    assertReceiptBinding(receipt, account);
    if (receipt.claimed || receipt.userId !== userId) throw new Error("Issuance transition identity is invalid.");
    return receipt;
  };
  const membership = await advance("membership");
  if (membership.state === "succeeded") return issuanceReport(membership, account, true);
  if (membership.state !== "membership_committed") throw new Error("Membership commit is unconfirmed.");
  await verifyMembership(supabase, account, userId);
  await verifyPasswordLogin(verificationClient, account, userId);
  const receipt = await advance("succeeded");
  if (receipt.state !== "succeeded" || !receipt.completedAt) throw new Error("Issuance success is unconfirmed.");
  return issuanceReport(receipt, account, false);
}

function issuanceReport(receipt, account, receiptOnly) {
  return {
    ok: true, attemptId: receipt.attemptId, state: receipt.state, receiptOnly,
    currentAccessVerified: !receiptOnly, created: receipt.created, email: account.email,
    userId: receipt.userId, organizationId: receipt.organizationId,
    requestedRole: receipt.requestedRole, databaseRole: receipt.databaseRole, access: account.access,
    operatorIdentity: receipt.operatorIdentity, operatorUserId: receipt.operatorUserId,
    operatorIdentitySource: receipt.operatorIdentitySource,
    passwordIssued: true, membershipVerified: !receiptOnly, loginVerified: !receiptOnly,
    authenticatedMembershipVerified: !receiptOnly, issuanceAuditRecorded: true,
    issuedAt: receipt.completedAt,
  };
}

function pendingIssuance(error, attemptId) {
  console.error(JSON.stringify({ event: "fireafter.operator_account.unconfirmed", attemptId }));
  const failure = new Error(`${error.message} Outcome is unconfirmed; preserve attempt ${attemptId} and use status/reconcile. A failure does not mean rollback.`);
  failure.code = "ISSUANCE_UNCONFIRMED";
  failure.attemptId = attemptId;
  return failure;
}

async function findAuthUser(supabase, email) {
  for (let page = 1; page <= MAX_AUTH_USER_PAGES; page += 1) {
    const data = await providerStep("Supabase Auth user lookup", () =>
      supabase.auth.admin.listUsers({
        page,
        perPage: AUTH_USER_PAGE_SIZE,
      }),
    );
    if (!Array.isArray(data?.users)) throw new Error("Supabase Auth user lookup returned an invalid directory response.");
    const users = data.users;
    const existing = users.find(
      (candidate) => candidate.email?.toLowerCase() === email,
    );
    if (existing) return existing;
    if (users.length < AUTH_USER_PAGE_SIZE) return null;
  }

  throw new Error(
    "Supabase Auth user lookup exceeded the supported page limit. Resolve the directory size before retrying.",
  );
}

async function createAuthUser(supabase, account, appMetadata) {
  const data = await providerStep("Supabase Auth user creation", () =>
    supabase.auth.admin.createUser({
      email: account.email,
      password: account.password,
      email_confirm: true,
      app_metadata: appMetadata,
    }),
  );
  if (!data?.user?.id) {
    throw new Error("Supabase Auth user creation returned no user id.");
  }
  return data.user;
}

async function updateAuthUser(supabase, existingUser, account, appMetadata) {
  const data = await providerStep("Supabase Auth user update", () =>
    supabase.auth.admin.updateUserById(existingUser.id, {
      password: account.password,
      email_confirm: true,
      app_metadata: appMetadata,
    }),
  );
  if (!data?.user?.id) {
    throw new Error("Supabase Auth user update returned no user id.");
  }
  return data.user;
}

async function verifyMembership(supabase, account, userId) {
  const membership = await providerStep(
    "organization membership verification",
    () =>
      supabase
        .from("organization_members")
        .select("organization_id,user_id,role")
        .eq("organization_id", account.organizationId)
        .eq("user_id", userId)
        .maybeSingle(),
  );
  if (
    !membership ||
    membership.organization_id !== account.organizationId ||
    membership.user_id !== userId ||
    membership.role !== account.databaseRole
  ) {
    throw new Error(
      "Organization membership verification failed. Confirm the target organization and role before retrying.",
    );
  }
}

async function verifyPasswordLogin(verificationClient, account, expectedUserId) {
  const data = await providerStep(
    "Supabase Auth password verification",
    () =>
      verificationClient.auth.signInWithPassword({
        email: account.email,
        password: account.password,
      }),
    "Confirm the public Supabase Auth key and the operator-issued credentials before retrying.",
  );
  if (!data?.user?.id || data.user.id !== expectedUserId) {
    throw new Error(
      "Supabase Auth password verification returned an unexpected user. Confirm the issued account before retrying.",
    );
  }
  if (!data.session?.access_token) {
    throw new Error(
      "Supabase Auth password verification returned no authenticated session. Confirm the issued credentials and public Auth configuration before retrying.",
    );
  }
  await verifyAuthenticatedMembership(verificationClient, account, expectedUserId);
}

async function verifyAuthenticatedMembership(verificationClient, account, expectedUserId) {
  const membership = await providerStep(
    "authenticated organization membership verification",
    () =>
      verificationClient
        .from("organization_members")
        .select("organization_id,user_id,role")
        .eq("organization_id", account.organizationId)
        .eq("user_id", expectedUserId)
        .maybeSingle(),
    "Confirm the authenticated self-read policy and target organization before retrying.",
  );
  if (
    !membership ||
    membership.organization_id !== account.organizationId ||
    membership.user_id !== expectedUserId ||
    membership.role !== account.databaseRole
  ) {
    throw new Error(
      "Authenticated organization membership verification failed. Confirm the authenticated self-read policy and target role before retrying.",
    );
  }
}

async function providerStep(step, operation, remediation) {
  try {
    const result = await operation();
    if (result?.error) {
      throw result.error;
    }
    return result?.data ?? result;
  } catch {
    console.error(
      JSON.stringify({
        event: "fireafter.operator_account.failure",
        step,
        errorType: "ProviderFailure",
      }),
    );
    throw new Error(
      `${step} failed. ${
        remediation ??
        "Verify Supabase connectivity, SUPABASE_SERVICE_ROLE_KEY, and the organization schema before retrying."
      }`,
    );
  }
}
