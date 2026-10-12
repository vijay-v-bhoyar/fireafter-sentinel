import { existsSync, readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { admitSupabaseTarget } from "./sentinel-target.mjs";
import {
  DEFAULT_ORGANIZATION_ID,
  DEFAULT_ORGANIZATION_NAME,
  issueOperatorAccount,
  reconcileOperatorAccount,
} from "./operator-account.mjs";
import { createOperatorFetch, getOperatorAccountIssuance, validateAttemptId, validateOperatorUserId } from "./operator-account-coordinator.mjs";

const originalEnv = new Set(Object.keys(process.env));

loadEnvFile(".env");
loadEnvFile(".env.local");

try {
  await main();
} catch (error) {
  console.error(
    `[fireafter] Account issuance blocked: ${error instanceof Error ? error.message : "unknown error"}`,
  );
  process.exitCode = 1;
}

async function main() {
  const mode = process.env.FIREAFTER_OPERATOR_MODE || "issue";
  if (!["issue", "status", "reconcile"].includes(mode)) throw new Error("FIREAFTER_OPERATOR_MODE must be issue, status, or reconcile.");
  const attemptId = validateAttemptId(process.env.FIREAFTER_OPERATOR_ATTEMPT_ID);
  const supabaseUrl = admitSupabaseTarget(requiredEnv("NEXT_PUBLIC_SUPABASE_URL"));
  const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const boundedFetch = createOperatorFetch();
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: boundedFetch },
  });
  const publicKey =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!publicKey) {
    throw new Error(
      "Missing required environment variable: NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY or NEXT_PUBLIC_SUPABASE_ANON_KEY",
    );
  }
  const operatorClient = createClient(supabaseUrl, publicKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: boundedFetch },
  });
  const operatorUser = await authenticateOperator(
    operatorClient,
    requiredEnv("FIREAFTER_OPERATOR_AUTH_EMAIL"),
    requiredEnv("FIREAFTER_OPERATOR_AUTH_PASSWORD"),
  );
  if (mode === "status") {
    const receipt = await getOperatorAccountIssuance({ supabase: operatorClient, attemptId });
    console.log(JSON.stringify({ ...receipt, operatorUserId: validateOperatorUserId(operatorUser.id),
      receiptOnly: true, currentAccessVerified: false }, null, 2));
    return;
  }
  const account = {
    attemptId,
    email: requiredEnv("FIREAFTER_OPERATOR_ACCOUNT_EMAIL"),
    password: requiredEnv("FIREAFTER_OPERATOR_ACCOUNT_PASSWORD"),
    role: requiredEnv("FIREAFTER_OPERATOR_ACCOUNT_ROLE"),
    operatorUserId: validateOperatorUserId(operatorUser.id),
    confirmation: process.env.FIREAFTER_OPERATOR_CONFIRM,
    organizationId:
      process.env.FIREAFTER_OPERATOR_ORGANIZATION_ID || DEFAULT_ORGANIZATION_ID,
    organizationName: DEFAULT_ORGANIZATION_NAME,
  };

  const verificationClient = createClient(supabaseUrl, publicKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: { fetch: boundedFetch },
  });

  console.error(JSON.stringify({ event: "fireafter.operator_account.start", mode, attemptId }));
  const report = await (mode === "reconcile" ? reconcileOperatorAccount : issueOperatorAccount)({
    supabase,
    operatorClient,
    verificationClient,
    ...account,
  });
  console.log(JSON.stringify(report, null, 2));
}

async function authenticateOperator(client, email, password) {
  try {
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error || !data?.user?.id || !data.session?.access_token) throw new Error("operator authentication failed");
    validateOperatorUserId(data.user.id);
    return data.user;
  } catch {
    throw new Error("Operator authentication failed. Verify FIREAFTER_OPERATOR_AUTH_EMAIL/PASSWORD and ensure the account is allowlisted for issuance.");
  }
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value?.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function loadEnvFile(path) {
  if (!existsSync(path)) return;

  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) continue;

    const key = line.slice(0, equalsIndex).trim();
    let value = line.slice(equalsIndex + 1).trim();
    if (!key || originalEnv.has(key)) continue;

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}
