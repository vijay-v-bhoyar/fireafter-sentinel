import { inspect } from "node:util";
import { spawn } from "node:child_process";
import { fetchReleaseText, verifyReleaseIdentity } from "./release-artifact.mjs";
import { admitAppTarget } from "./sentinel-target.mjs";

const baseUrl = admitAppTarget(process.env.FIREAFTER_PRODUCTION_BASE || process.env.SENTINEL_TARGET_APP_URL || "http://127.0.0.1:3020")
  .replace(/\/$/, "");
const incidentId = process.env.FIREAFTER_PRODUCTION_INCIDENT_ID || "incident-utah-county-ut";
const staleFallbackLabel = "Recent/year-to-date fire perimeter fallback";
const fixedFallbackLabel = "Recent fire perimeter fallback";

async function fetchText(path) {
  return fetchReleaseText(`${baseUrl}${path}`);
}

async function fetchJson(path) {
  const text = await fetchText(path);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${path} did not return JSON`);
  }
}

try {
  const identity = await verifyReleaseIdentity(baseUrl);
  const settings = await fetchText("/settings");
  const readiness = await fetchJson(
    `/api/readiness?incidentId=${encodeURIComponent(incidentId)}`,
  );
  const sources = await fetchJson(
    `/api/sources/status?incidentId=${encodeURIComponent(incidentId)}`,
  );

  const productPromise = Array.isArray(readiness.productPromise)
    ? readiness.productPromise
    : [];
  const coverageMatrix = Array.isArray(sources.coverageMatrix)
    ? sources.coverageMatrix
    : [];
  const issues = [];

  if (settings.includes(staleFallbackLabel)) {
    issues.push(`stale fallback label still visible: ${staleFallbackLabel}`);
  }
  if (!settings.includes(fixedFallbackLabel)) {
    issues.push(`fixed fallback label missing: ${fixedFallbackLabel}`);
  }
  if (readiness.overallStatus !== "operational") {
    issues.push(`readiness overallStatus is ${readiness.overallStatus ?? "missing"}`);
  }
  if (typeof readiness.overallScore !== "number" || readiness.overallScore < 4.8) {
    issues.push(`readiness overallScore is ${readiness.overallScore ?? "missing"}`);
  }
  if (productPromise.length === 0 || productPromise.some((gate) => gate.status !== "pass")) {
    issues.push("productPromise gates are missing or not all passing");
  }
  if (coverageMatrix.length < 14) {
    issues.push(`coverageMatrix has ${coverageMatrix.length} item(s), expected at least 14`);
  }

  let browser = {
    ok: false,
    checks: 0,
    issues: ["Skipped because the API preflight failed."],
  };
  if (issues.length === 0) {
    const browserResult = await runBrowserSmoke();
    browser = browserResult.report;
    if (browserResult.code !== 0 || browser.ok !== true) {
      if (browser.issues.length > 0) {
        issues.push(...browser.issues.map((issue) => `browser: ${issue}`));
      } else {
        issues.push(`browser smoke exited with code ${browserResult.code}`);
      }
    }
  }

  await verifyReleaseIdentity(baseUrl, identity.releaseId);
  const report = {
    ok: issues.length === 0,
    releaseId: identity.releaseId,
    baseUrl,
    incidentId,
    readiness: {
      overallStatus: readiness.overallStatus,
      overallScore: readiness.overallScore,
      productPromisePassCount: productPromise.filter((gate) => gate.status === "pass").length,
      productPromiseCount: productPromise.length,
    },
    sources: {
      coverageMatrixCount: coverageMatrix.length,
    },
    labels: {
      staleFallbackLabelPresent: settings.includes(staleFallbackLabel),
      fixedFallbackLabelPresent: settings.includes(fixedFallbackLabel),
    },
    browser,
    issues,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
} catch (error) {
  console.error(
    "[verify:production] failed:",
    error instanceof Error ? error.message : inspect(error),
  );
  process.exitCode = 1;
}

function runBrowserSmoke() {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(process.execPath, ["scripts/verify-browser-smoke.mjs"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        FIREAFTER_TEST_BASE: baseUrl,
        FIREAFTER_BROWSER_COMPACT: "true",
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.on("error", reject);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => {
      let report;
      try {
        report = JSON.parse(stdout);
      } catch {
        reject(
          new Error(
            `production browser smoke returned invalid JSON${stderr ? `: ${stderr.trim()}` : ""}`,
          ),
        );
        return;
      }
      resolve({ code, report });
    });
  });
}
