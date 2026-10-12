export function resolveAuthenticatedSmokeCredentials(env = process.env) {
  const explicitEmail = nonBlank(env.FIREAFTER_AUTH_SMOKE_EMAIL);
  const operatorEmail = nonBlank(env.FIREAFTER_OPERATOR_ACCOUNT_EMAIL);
  const explicitPassword = present(env.FIREAFTER_AUTH_SMOKE_PASSWORD);
  const operatorPassword = present(env.FIREAFTER_OPERATOR_ACCOUNT_PASSWORD);

  if (Boolean(explicitEmail) !== Boolean(explicitPassword)) {
    throw new Error(
      "Set both FIREAFTER_AUTH_SMOKE_EMAIL and FIREAFTER_AUTH_SMOKE_PASSWORD together, or clear both to use the operator-issued pair.",
    );
  }
  if (Boolean(operatorEmail) !== Boolean(operatorPassword)) {
    throw new Error(
      "Set both FIREAFTER_OPERATOR_ACCOUNT_EMAIL and FIREAFTER_OPERATOR_ACCOUNT_PASSWORD together.",
    );
  }

  if (explicitEmail && explicitPassword) {
    return {
      email: explicitEmail,
      password: explicitPassword,
      credentialSource: "FIREAFTER_AUTH_SMOKE_*",
    };
  }
  if (operatorEmail && operatorPassword) {
    return {
      email: operatorEmail,
      password: operatorPassword,
      credentialSource: "FIREAFTER_OPERATOR_ACCOUNT_*",
    };
  }

  throw new Error(
    "Set FIREAFTER_AUTH_SMOKE_EMAIL and FIREAFTER_AUTH_SMOKE_PASSWORD, or the operator-issued credential pair, in the current shell.",
  );
}

function nonBlank(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function present(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
