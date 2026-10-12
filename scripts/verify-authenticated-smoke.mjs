import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { bindReleasePage, releaseTarget, verifyReleaseIdentity } from "./release-artifact.mjs";
import { admitAppTarget } from "./sentinel-target.mjs";
import { assertDemoPasswordNotCompromised } from "./demo-credential-policy.mjs";
import { resolveAuthenticatedSmokeCredentials } from "./auth-smoke-config.mjs";
import { closeAuthenticatedSmokeSession } from "./logout-cleanup.mjs";
import {
  validateAuthenticatedReadinessEvidence,
  validateAuthenticatedRefreshEvidence,
} from "./authenticated-refresh-contract.mjs";

const identity = releaseTarget(admitAppTarget(process.env.FIREAFTER_AUTH_SMOKE_BASE_URL ?? process.env.SENTINEL_TARGET_APP_URL ?? "http://127.0.0.1:3020"));
const baseUrl = identity.baseUrl;
let credentials;
try {
  credentials = resolveAuthenticatedSmokeCredentials();
} catch (error) {
  console.error(
    `[fireafter] Authenticated verification blocked: ${error instanceof Error ? error.message : "missing credentials"}`,
  );
  process.exit(1);
}
const { email, password, credentialSource } = credentials;
const writeMode = process.env.FIREAFTER_AUTH_SMOKE_WRITE === "CONFIRMED";
const refreshMode = process.env.FIREAFTER_AUTH_SMOKE_REFRESH === "CONFIRMED";
const refreshIncidentId = process.env.FIREAFTER_AUTH_SMOKE_INCIDENT_ID?.trim();
if (refreshMode && !refreshIncidentId) {
  console.error(
    "[fireafter] Authenticated refresh blocked: Set FIREAFTER_AUTH_SMOKE_INCIDENT_ID to the persisted incident id before enabling FIREAFTER_AUTH_SMOKE_REFRESH=CONFIRMED.",
  );
  process.exit(1);
}
const issues = [];
const checks = [];

assertDemoPasswordNotCompromised(
  password,
  credentialSource === "FIREAFTER_AUTH_SMOKE_*"
    ? "FIREAFTER_AUTH_SMOKE_PASSWORD"
    : "FIREAFTER_OPERATOR_ACCOUNT_PASSWORD",
);

await verifyReleaseIdentity(baseUrl, identity.releaseId);
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage();
await bindReleasePage(page, baseUrl, issues);

page.on("pageerror", (error) => issues.push(`page error: ${error.message}`));
page.on("console", (message) => {
  if (message.type() === "error") {
    issues.push(`console error: ${message.text()}`);
  }
});
page.on("requestfailed", (request) => {
  if (!isBenignAbortedRequest(request)) {
    issues.push(
      `request failed: ${request.method()} ${request.url()} ${request.failure()?.errorText ?? "unknown"}`,
    );
  }
});

try {
  await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });
  if (issues.length) throw new Error("Login document did not match the reviewed release; no credentials submitted.");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await Promise.all([
    page.waitForURL((url) => url.origin === baseUrl && url.pathname === "/", {
      timeout: 30000,
    }),
    page.getByRole("button", { name: "Sign In", exact: true }).click(),
  ]);
  await page.getByText(/^(incident_commander|analyst)$/).waitFor({
    timeout: 30000,
  });
  checks.push("operator-issued account authenticated");

  await assertEnabled(page.getByRole("button", { name: "Refresh", exact: true }), "incident refresh");
  for (const label of ["Accept", "Modify", "Reject"]) {
    await assertEnabled(page.getByRole("button", { name: label, exact: true }), `${label} action`);
  }
  checks.push("commander/analyst mutation controls enabled");

  if (refreshMode) {
    await verifyAuthorizedRefresh(page, context, refreshIncidentId);
    checks.push("authorized refresh persisted validated PWFDF basin and linked recommendation evidence");
  }

  await page.goto(`${baseUrl}/assets`, { waitUntil: "domcontentloaded" });
  const importInput = page.getByLabel("Local asset CSV or GeoJSON");
  await importInput.fill("name,type,lat,lon\nCapability probe,Culvert,0,0");
  await assertEnabled(
    page.getByRole("button", { name: "Import Assets", exact: true }),
    "asset import",
  );
  await importInput.fill("");
  checks.push("authorized asset-import control enabled without submitting data");

  await page.goto(`${baseUrl}/settings`, { waitUntil: "domcontentloaded" });
  await page.getByText("operational write access", { exact: false }).waitFor({
    timeout: 30000,
  });
  checks.push("settings reports operational write access");

  if (writeMode) {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    const marker = `Authenticated release smoke ${new Date().toISOString()} ${randomUUID().slice(0, 8)}`;
    await page.getByRole("textbox", { name: "Action note", exact: true }).fill(marker);
    await assertEnabled(page.getByRole("button", { name: "Annotate", exact: true }), "annotation with durable recovery");
    const responsePending = page.waitForResponse(response => response.url() === `${baseUrl}/api/actions` && response.request().method() === "POST");
    await page.getByRole("button", { name: "Annotate", exact: true }).click();
    const actionResponse = await responsePending;
    const sentCommand = actionResponse.request().postDataJSON();
    const recommendationId = sentCommand.recommendationId;
    if (!sentCommand.commandId || !sentCommand.expectedRevision || !recommendationId ||
      !actionResponse.request().headers()["x-fireafter-actor"] || !actionResponse.request().headers()["x-fireafter-organization"]) {
      throw new Error("Annotation did not carry displayed revision, command and expected authority.");
    }
    if (!actionResponse.ok()) {
      const body = await actionResponse.text();
      throw new Error(
        `Append-only action smoke failed with ${actionResponse.status()}: ${body.slice(0, 300)}`,
      );
    }
    const action = await actionResponse.json();
    if (
      action?.action !== "annotate" ||
      action?.note !== marker ||
      typeof action?.id !== "string" ||
      typeof action?.auditEvent?.id !== "string" ||
      action?.auditEvent?.recommendationId !== recommendationId ||
      action?.auditEvent?.payload?.commandId !== sentCommand.commandId ||
      action?.auditEvent?.payload?.expectedRevision !== sentCommand.expectedRevision ||
      action?.auditEvent?.payload?.action !== "annotate"
    ) {
      throw new Error("Action response did not include the expected action/audit pair.");
    }

    await page.goto(`${baseUrl}/history`, { waitUntil: "domcontentloaded" });
    await page.getByText(marker, { exact: true }).waitFor({ timeout: 30000 });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByText(marker, { exact: true }).waitFor({ timeout: 30000 });
    checks.push("append-only annotation and audit pair persisted across reload");
  } else {
    checks.push("write smoke skipped; set FIREAFTER_AUTH_SMOKE_WRITE=CONFIRMED only with production-data approval");
  }

  if (issues.length > 0) {
    throw new Error(issues.join("\n"));
  }
} finally {
  await closeAuthenticatedSmokeSession(context, browser, baseUrl);
}

await verifyReleaseIdentity(baseUrl, identity.releaseId);
console.log(
  JSON.stringify(
    {
      ok: true,
      releaseId: identity.releaseId,
      baseUrl,
      credentialSource,
      mode: refreshMode
        ? "approved_refresh"
        : writeMode
          ? "approved_append_only_write"
          : "authenticated_read_only",
      checks,
      issues: [],
    },
    null,
    2,
  ),
);

async function assertEnabled(locator, label) {
  if ((await locator.count()) !== 1) {
    throw new Error(`Expected exactly one ${label} control.`);
  }
  if (await locator.isDisabled()) {
    throw new Error(`${label} remains disabled for an authorized account.`);
  }
}

async function verifyAuthorizedRefresh(page, context, incidentId) {
  const refreshResponse = await context.request.post(
    `${baseUrl}/api/refresh/${encodeURIComponent(incidentId)}`,
    { headers: { accept: "application/json" }, maxRedirects: 0 },
  );
  if (!refreshResponse.ok()) {
    throw new Error(
      `Authorized refresh failed with ${refreshResponse.status()}. Confirm the target incident, live sources, migration probes, and Supabase access before retrying.`,
    );
  }

  const refreshed = await responseJson(refreshResponse, "Authorized refresh");
  const refreshEvidence = validateAuthenticatedRefreshEvidence(refreshed, incidentId);
  if (!refreshEvidence.ok) {
    throw new Error(
      `Authorized refresh did not produce the required real PWFDF evidence (${refreshEvidence.failure}). No fallback data is accepted; inspect source status and retry.`,
    );
  }

  const readinessResponse = await context.request.get(
    `${baseUrl}/api/readiness?incidentId=${encodeURIComponent(incidentId)}`,
    { headers: { accept: "application/json" }, maxRedirects: 0 },
  );
  if (!readinessResponse.ok()) {
    throw new Error(
      `Readiness verification failed with ${readinessResponse.status()} after refresh.`,
    );
  }
  const readiness = await responseJson(readinessResponse, "Readiness verification");
  const readinessEvidence = validateAuthenticatedReadinessEvidence(readiness);
  if (!readinessEvidence.ok) {
    throw new Error(
      `Readiness did not confirm basin-to-asset linkage after refresh (${readinessEvidence.failure}).`,
    );
  }

  await page.goto(`${baseUrl}/settings`, { waitUntil: "domcontentloaded" });
  await page.getByText("Basin-to-asset linkage", { exact: true }).waitFor({ timeout: 30000 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("Basin-to-asset linkage", { exact: true }).waitFor({ timeout: 30000 });
}

async function responseJson(response, label) {
  if (new URL(response.url()).origin !== baseUrl || response.headers()["x-fireafter-release-id"] !== identity.releaseId) {
    throw new Error(`${label} did not match the reviewed release.`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
}

function isBenignAbortedRequest(request) {
  return (
    request.method() === "GET" &&
    request.failure()?.errorText === "net::ERR_ABORTED" &&
    new URL(request.url()).searchParams.has("_rsc")
  );
}
