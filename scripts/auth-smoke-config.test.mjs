import assert from "node:assert/strict";
import test from "node:test";
import { resolveAuthenticatedSmokeCredentials } from "./auth-smoke-config.mjs";

test("prefers explicit authenticated smoke credentials", () => {
  const result = resolveAuthenticatedSmokeCredentials({
    FIREAFTER_AUTH_SMOKE_EMAIL: " smoke@example.com ",
    FIREAFTER_AUTH_SMOKE_PASSWORD: "smoke password",
    FIREAFTER_OPERATOR_ACCOUNT_EMAIL: "operator@example.com",
    FIREAFTER_OPERATOR_ACCOUNT_PASSWORD: "operator password",
  });

  assert.deepEqual(result, {
    email: "smoke@example.com",
    password: "smoke password",
    credentialSource: "FIREAFTER_AUTH_SMOKE_*",
  });
});

test("reuses operator-issued credentials when smoke variables are absent", () => {
  const result = resolveAuthenticatedSmokeCredentials({
    FIREAFTER_OPERATOR_ACCOUNT_EMAIL: "operator@example.com",
    FIREAFTER_OPERATOR_ACCOUNT_PASSWORD: "operator password",
  });

  assert.deepEqual(result, {
    email: "operator@example.com",
    password: "operator password",
    credentialSource: "FIREAFTER_OPERATOR_ACCOUNT_*",
  });
});

test("fails closed when only one explicit smoke credential is present", () => {
  assert.throws(
    () => resolveAuthenticatedSmokeCredentials({
      FIREAFTER_AUTH_SMOKE_EMAIL: "smoke@example.com",
    }),
    /Set both FIREAFTER_AUTH_SMOKE_EMAIL and FIREAFTER_AUTH_SMOKE_PASSWORD together/,
  );
});

test("fails closed when only one operator credential is present", () => {
  assert.throws(
    () => resolveAuthenticatedSmokeCredentials({
      FIREAFTER_OPERATOR_ACCOUNT_EMAIL: "operator@example.com",
    }),
    /Set both FIREAFTER_OPERATOR_ACCOUNT_EMAIL and FIREAFTER_OPERATOR_ACCOUNT_PASSWORD together/,
  );
});

test("fails with an actionable missing-pair error without requiring password output", () => {
  assert.throws(
    () => resolveAuthenticatedSmokeCredentials({}),
    /Set FIREAFTER_AUTH_SMOKE_EMAIL and FIREAFTER_AUTH_SMOKE_PASSWORD/,
  );
});
