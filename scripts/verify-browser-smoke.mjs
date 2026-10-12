import { inspect } from "node:util";
import { chromium } from "playwright";
import { bindReleasePage, verifyReleaseIdentity } from "./release-artifact.mjs";
import { admitAppTarget } from "./sentinel-target.mjs";

const baseUrl = admitAppTarget(process.env.FIREAFTER_TEST_BASE || process.env.SENTINEL_TARGET_APP_URL || "http://127.0.0.1:3020").replace(
  /\/$/,
  "",
);
const compactOutput = process.env.FIREAFTER_BROWSER_COMPACT === "true";
const requireHsts =
  process.env.FIREAFTER_REQUIRE_HSTS === "true" ||
  new URL(baseUrl).protocol === "https:";
const staleFallbackLabel = "Recent/year-to-date fire perimeter fallback";
const routes = [
  {
    path: "/",
    navLabel: "Action Queue",
    requiredText: ["Action Queue", "What should we review first, and why?", "Sign in"],
  },
  {
    path: "/map",
    navLabel: "Map View",
    requiredText: ["Map View", "Selected Map Priorities"],
  },
  {
    path: "/assets",
    navLabel: "Assets",
    requiredText: ["County Assets", "Local Asset Upload"],
  },
  {
    path: "/history",
    navLabel: "History & Audit",
    requiredText: ["History & Audit", "Audit Trail"],
  },
  {
    path: "/settings",
    navLabel: "Settings",
    requiredText: [
      "Operational Health",
      "Product Promise Check",
      "Recent fire perimeter fallback",
      "Export GeoJSON",
    ],
  },
  {
    path: "/features",
    requiredText: ["Product feature graph", "EVIDENCE FLOW", "RELEVANT TESTS", "LIMIT AND EVIDENCE BOUNDARY", "Explore the implementation code graph"],
  },
  {
    path: "/login",
    requiredText: [
      "Responder workspace login",
      "Private responder access",
      "Forgot password?",
      "Continue read-only",
    ],
  },
  {
    path: "/recover",
    requiredText: ["Recover your account", "Send recovery link", "Return to sign in"],
  },
  {
    path: "/reset-password",
    requiredText: ["Set a new password", "Update password", "Request a new recovery link"],
  },
];
const viewports = [
  { name: "mobile", width: 390, height: 844 },
  { name: "desktop", width: 1440, height: 1000 },
];

const identity = await verifyReleaseIdentity(baseUrl);
const browser = await chromium.launch();
const results = [];
const issues = [];

function isBenignAbortedRequest(request) {
  const failure = request.failure();
  if (failure?.errorText !== "net::ERR_ABORTED" || request.method() !== "GET") {
    return false;
  }

  try {
    return new URL(request.url()).searchParams.has("_rsc");
  } catch {
    return false;
  }
}

function isTrustedCallbackOrigin(actualUrl, expectedUrl) {
  if (actualUrl.origin === expectedUrl.origin) return true;

  const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
  return (
    loopbackHosts.has(actualUrl.hostname) &&
    loopbackHosts.has(expectedUrl.hostname) &&
    actualUrl.protocol === expectedUrl.protocol &&
    actualUrl.port === expectedUrl.port
  );
}

try {
  for (const viewport of viewports) {
    for (const route of routes) {
      const page = await browser.newPage({ viewport });
      await bindReleasePage(page, baseUrl, issues);
      const scope = `${viewport.name} ${route.path}`;
      const runtimeIssues = [];

      page.on("console", (message) => {
        if (["error", "warning"].includes(message.type())) {
          runtimeIssues.push(`console ${message.type()}: ${message.text()}`);
        }
      });
      page.on("pageerror", (error) => runtimeIssues.push(`page error: ${error.message}`));
      page.on("requestfailed", (request) => {
        if (isBenignAbortedRequest(request)) return;
        runtimeIssues.push(
          `request failed: ${request.method()} ${request.url()} (${request.failure()?.errorText})`,
        );
      });
      page.on("response", (response) => {
        if (response.status() >= 400) {
          runtimeIssues.push(
            `HTTP ${response.status()}: ${response.request().method()} ${response.url()}`,
          );
        }
      });

      const response = await page.goto(`${baseUrl}${route.path}`, {
        waitUntil: "networkidle",
        timeout: 30000,
      });
      const result = await page.evaluate(
        ({ requiredText, staleFallbackLabel, expectedPath, expectsDashboardNav }) => {
          const bodyText = document.body.innerText;
          const overflowing = [...document.querySelectorAll("body *")]
            .filter(
              (element) => {
                const overflowX = getComputedStyle(element).overflowX;
                return (
                  element.clientWidth > 0 &&
                  element.scrollWidth > element.clientWidth + 1 &&
                  !["auto", "scroll", "hidden", "clip"].includes(overflowX)
                );
              },
            )
            .slice(0, 10)
            .map((element) => ({
              tag: element.tagName,
              text: (element.textContent || "").trim().slice(0, 120),
              scrollWidth: element.scrollWidth,
              clientWidth: element.clientWidth,
            }));
          const duplicateIds = [...document.querySelectorAll("[id]")]
            .map((element) => element.id)
            .filter((id, index, ids) => id && ids.indexOf(id) !== index);
          const imagesWithoutAlt = [...document.querySelectorAll("img:not([alt])")].map(
            (image) => image.getAttribute("src"),
          );
          const activeLinks = [...document.querySelectorAll('nav a[aria-current="page"]')].map(
            (link) => {
              const href = link.getAttribute("href") ?? "";
              const destination = new URL(href, window.location.origin);
              return { href, origin: destination.origin, path: destination.pathname };
            },
          );
          const sourceLinks = [...document.querySelectorAll("a[data-source-link]")].map((link) => ({
            href: link.getAttribute("href"),
            target: link.getAttribute("target"),
            rel: link.getAttribute("rel"),
            name: link.getAttribute("aria-label"),
          }));
          const sourceRows = document.querySelectorAll("[data-source-row]").length;
          const loginLinks = [...document.querySelectorAll('a[href^="/login"]')].map((link) => ({
            href: link.getAttribute("href"),
            text: (link.textContent || "").trim(),
          }));
          const unnamedControls = [
            ...document.querySelectorAll(
              'button, a[href], input, select, textarea, [role="button"], [role="link"]',
            ),
          ]
            .filter((element) => element.getAttribute("type") !== "hidden")
            .filter((element) => {
              const labelledBy = element.getAttribute("aria-labelledby");
              const referencedText = labelledBy
                ? labelledBy
                    .split(/\s+/)
                    .map((id) => document.getElementById(id)?.textContent || "")
                    .join(" ")
                : "";
              const labelText = "labels" in element
                ? [...(element.labels ?? [])].map((label) => label.textContent || "").join(" ")
                : "";
              return ![
                element.getAttribute("aria-label"),
                referencedText,
                element.getAttribute("title"),
                labelText,
                element.textContent,
                element.getAttribute("alt"),
              ].some((value) => value?.trim());
            })
            .slice(0, 10)
            .map((element) => ({
              tag: element.tagName,
              type: element.getAttribute("type"),
              name: element.getAttribute("name"),
            }));

          return {
            path: window.location.pathname,
            bodyScrollWidth: document.body.scrollWidth,
            documentScrollWidth: document.documentElement.scrollWidth,
            viewportWidth: window.innerWidth,
            missingText: requiredText.filter((text) => !bodyText.includes(text)),
            staleFallbackTextPresent: bodyText.includes(staleFallbackLabel),
            overflowing,
            duplicateIds: [...new Set(duplicateIds)],
            imagesWithoutAlt,
            unnamedControls,
            loginLinks,
            sourceLinks,
            sourceRows,
            activeLinks: expectsDashboardNav ? activeLinks : [],
            expectedPath,
          };
        },
        {
          requiredText: route.requiredText,
          staleFallbackLabel,
          expectedPath: route.path,
          expectsDashboardNav: Boolean(route.navLabel),
        },
      );

      if (!response || !response.ok()) {
        runtimeIssues.push(`navigation returned ${response?.status() ?? "no response"}`);
      }
      if (result.path !== route.path) {
        runtimeIssues.push(`URL path ${result.path} does not match ${route.path}`);
      }
      if (result.bodyScrollWidth > result.viewportWidth) {
        runtimeIssues.push(
          `body scroll width ${result.bodyScrollWidth} exceeds viewport ${result.viewportWidth}`,
        );
      }
      if (result.documentScrollWidth > result.viewportWidth) {
        runtimeIssues.push(
          `document scroll width ${result.documentScrollWidth} exceeds viewport ${result.viewportWidth}`,
        );
      }
      if (result.overflowing.length > 0) {
        runtimeIssues.push(`overflowing elements: ${JSON.stringify(result.overflowing)}`);
      }
      if (result.staleFallbackTextPresent) {
        runtimeIssues.push(`stale fallback label visible: ${staleFallbackLabel}`);
      }
      for (const text of result.missingText) runtimeIssues.push(`missing text: ${text}`);
      if (result.duplicateIds.length > 0) {
        runtimeIssues.push(`duplicate element ids: ${result.duplicateIds.join(", ")}`);
      }
      if (result.imagesWithoutAlt.length > 0) {
        runtimeIssues.push(`images missing alt text: ${result.imagesWithoutAlt.join(", ")}`);
      }
      if (result.unnamedControls.length > 0) {
        runtimeIssues.push(`controls missing accessible names: ${JSON.stringify(result.unnamedControls)}`);
      }
      if (route.path === "/") {
        if (result.loginLinks.length === 0) {
          runtimeIssues.push("public dashboard exposes no sign-in link");
        }
        for (const link of result.loginLinks) {
          const destination = new URL(link.href ?? "", baseUrl);
          if (
            destination.origin !== new URL(baseUrl).origin ||
            destination.pathname !== "/login" ||
            destination.searchParams.get("returnTo") !== "/"
          ) {
            runtimeIssues.push(`sign-in link does not preserve the current internal route: ${JSON.stringify(link)}`);
          }
        }
        if (result.sourceRows > 0 && result.sourceLinks.length === 0) {
          runtimeIssues.push("source freshness panel exposes no validated source links");
        }
        for (const link of result.sourceLinks) {
          if (!/^https?:\/\//.test(link.href ?? "")) {
            runtimeIssues.push(`source link is not HTTP(S): ${JSON.stringify(link)}`);
          }
          if (link.target !== "_blank" || !/\bnoopener\b/.test(link.rel ?? "")) {
            runtimeIssues.push(`source link is missing safe external-link attributes: ${JSON.stringify(link)}`);
          }
          if (!link.name) {
            runtimeIssues.push(`source link is missing an accessible name: ${JSON.stringify(link)}`);
          }
        }
      }
      if (
        route.navLabel &&
        (result.activeLinks.length !== 1 ||
          result.activeLinks[0].origin !== new URL(baseUrl).origin ||
          result.activeLinks[0].path !== route.path)
      ) {
        runtimeIssues.push(
          `active navigation mismatch: ${JSON.stringify(result.activeLinks)} expected ${route.path}`,
        );
      }

      if (route.path === "/") {
        const emptyQueueMessage = page.getByText(
          "No source-backed recommendations yet. Refresh live sources or upload county assets to create auditable action candidates.",
          { exact: true },
        );
        const hasRealRecommendation = (await emptyQueueMessage.count()) === 0;
        const actionNote = page.getByLabel("Action note", { exact: true });
        const refreshButton = page.getByRole("button", { name: "Refresh", exact: true });
        if ((await refreshButton.count()) !== 1 || !(await refreshButton.isDisabled())) {
          runtimeIssues.push("public incident refresh is not disabled");
        }
        if (hasRealRecommendation) {
          if ((await actionNote.count()) !== 1 || (await actionNote.inputValue()) !== "") {
            runtimeIssues.push("responder action note is prefilled with unverified operational text");
          }
          for (const label of ["Accept", "Modify", "Reject"]) {
            const buttons = page.getByRole("button", { name: label, exact: true });
            const count = await buttons.count();
            if (count === 0) runtimeIssues.push(`missing responder action: ${label}`);
            for (let index = 0; index < count; index += 1) {
              if (!(await buttons.nth(index).isDisabled())) {
                runtimeIssues.push(`public responder action is enabled: ${label}`);
              }
            }
          }
        } else if ((await emptyQueueMessage.count()) !== 1) {
          runtimeIssues.push("empty action queue does not explain that real recommendations are unavailable");
        }
        if (viewport.name === "desktop") {
          const countySearch = page.getByLabel("Search any U.S. county", {
            exact: true,
          });
          if ((await countySearch.getAttribute("maxlength")) !== "80") {
            runtimeIssues.push("county search input is missing its 80-character cap");
          }
          await countySearch.fill("a");
          const minimumGuidanceVisible = await page
            .getByText("Enter at least 2 characters to search.", { exact: true })
            .waitFor({ state: "visible", timeout: 2000 })
            .then(() => true)
            .catch(() => false);
          if (!minimumGuidanceVisible) {
            runtimeIssues.push("county search does not explain its two-character minimum");
          }
          const invalidSearchResponse = await page.request.get(
            `${baseUrl}/api/search?query=a`,
          );
          const invalidSearchBody = await invalidSearchResponse.json().catch(() => null);
          if (
            invalidSearchResponse.status() !== 400 ||
            !invalidSearchBody ||
            !Array.isArray(invalidSearchBody.results) ||
            invalidSearchBody.results.length !== 0
          ) {
            runtimeIssues.push("served county search does not reject undersized queries");
          }
        }
      }
      if (route.path === "/assets") {
        const importButton = page.getByRole("button", { name: "Import Assets", exact: true });
        if ((await importButton.count()) !== 1 || !(await importButton.isDisabled())) {
          runtimeIssues.push("public asset import is not disabled");
        }
      }
      if (route.path === "/features") {
        const feature = page.getByRole("button", { name: /Any-county coverage/ });
        await feature.focus();
        await feature.press("Enter");
        if (!(await page.getByRole("heading", { name: "Any-county coverage" }).isVisible())) {
          runtimeIssues.push("keyboard selection did not update the feature detail panel");
        }
        if (viewport.name === "desktop") {
          const graphPage = await browser.newPage({ viewport });
          const graphResponse = await graphPage.goto(`${baseUrl}/code-graph.html`, {
            waitUntil: "networkidle",
            timeout: 30000,
          });
          if (!graphResponse?.ok()) runtimeIssues.push(`code graph returned ${graphResponse?.status() ?? "no response"}`);
          if (!(await graphPage.locator("#graph canvas").count())) {
            runtimeIssues.push("code graph viewer did not render a graph canvas; verify the vis-network CDN dependency and CSP");
          }
          const graphSearch = graphPage.locator("#search");
          await graphSearch.fill("FireAfterDashboard");
          const match = graphPage.locator("#search-results .search-item").first();
          await match.waitFor({ state: "visible", timeout: 5000 }).catch(() => {
            runtimeIssues.push("code graph search returned no FireAfterDashboard result");
          });
          if (await match.isVisible().catch(() => false)) {
            await match.click();
            if (!(await graphPage.locator("#info-content").innerText()).includes("fireafter-dashboard.tsx")) {
              runtimeIssues.push("code graph search result did not open node implementation details");
            }
          }
          await graphPage.close();
        }
      }

      results.push({ scope, result, issues: runtimeIssues });
      issues.push(...runtimeIssues.map((issue) => `${scope}: ${issue}`));
      await page.close();
    }
  }

  const navigationPage = await browser.newPage({ viewport: viewports[1] });
  await bindReleasePage(navigationPage, baseUrl, issues);
  const navigationIssues = [];
  navigationPage.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) {
      navigationIssues.push(`console ${message.type()}: ${message.text()}`);
    }
  });
  navigationPage.on("pageerror", (error) => {
    navigationIssues.push(`page error: ${error.message}`);
  });
  await navigationPage.goto(`${baseUrl}/`, { waitUntil: "networkidle", timeout: 30000 });
  const queueLink = navigationPage.getByRole("link", { name: "Action Queue", exact: true });
  const expectedQueueHref = await queueLink.getAttribute("href");
  const expectedMapHref = await navigationPage.getByRole("link", { name: "Map View", exact: true }).getAttribute("href");
  const queueUrl = new URL(expectedQueueHref, baseUrl);
  const mapUrl = new URL(expectedMapHref, baseUrl);
  const incidentId = queueUrl.searchParams.get("incidentId");
  if (!incidentId || queueUrl.origin !== new URL(baseUrl).origin || queueUrl.pathname !== "/" ||
      mapUrl.origin !== queueUrl.origin || mapUrl.pathname !== "/map" || mapUrl.searchParams.get("incidentId") !== incidentId) {
    navigationIssues.push("workspace navigation did not preserve one same-origin incident");
  }
  await navigationPage.getByRole("link", { name: "Map View", exact: true }).click();
  await navigationPage.waitForURL(mapUrl.href);
  await navigationPage.getByText("Selected Map Priorities", { exact: true }).waitFor();
  const mapActiveHref = await navigationPage.evaluate(() =>
    document.querySelector('nav a[aria-current="page"]')?.getAttribute("href") ?? null,
  );
  if (mapActiveHref !== expectedMapHref) {
    navigationIssues.push("client navigation did not activate Map View");
  }
  await navigationPage.goBack({ waitUntil: "networkidle" });
  const queueRestored = await navigationPage
    .getByText("What should we review first, and why?", { exact: true })
    .isVisible({ timeout: 5000 })
    .catch(() => false);
  const queueActiveHref = await navigationPage.evaluate(() =>
    document.querySelector('nav a[aria-current="page"]')?.getAttribute("href") ?? null,
  );
  if (
    navigationPage.url() !== `${baseUrl}/` ||
    queueActiveHref !== expectedQueueHref ||
    !queueRestored
  ) {
    navigationIssues.push("browser Back did not restore Action Queue state and URL");
  }
  await navigationPage.getByRole("link", { name: "Feature Graph", exact: true }).click();
  await navigationPage.waitForURL(`${baseUrl}/features?incidentId=${encodeURIComponent(incidentId)}`);
  await navigationPage.getByRole("heading", { name: "Product feature graph", exact: true }).waitFor();
  const returnLink = navigationPage.getByRole("link", { name: "Return to the live app", exact: true });
  if (await returnLink.getAttribute("href") !== expectedQueueHref) {
    navigationIssues.push("feature graph return link discarded the selected incident");
  }
  await returnLink.click();
  await navigationPage.waitForURL(queueUrl.href);
  await navigationPage.getByText("What should we review first, and why?", { exact: true }).waitFor();
  results.push({ scope: "desktop client navigation and Back", issues: navigationIssues });
  issues.push(...navigationIssues.map((issue) => `desktop navigation: ${issue}`));
  await navigationPage.close();

  const readinessPage = await browser.newPage({ viewport: viewports[1] });
  await bindReleasePage(readinessPage, baseUrl, issues);
  const readinessIssues = [];
  const readinessResponse = await readinessPage.request.get(`${baseUrl}/api/readiness`);
  const readiness = await readinessResponse.json().catch(() => null);
  if (!readinessResponse.ok() || !readiness) {
    readinessIssues.push(
      `/api/readiness returned ${readinessResponse.status()} or invalid JSON`,
    );
  } else {
    const statusLabels = {
      operational: "OPERATIONAL",
      needs_attention: "NEEDS ATTENTION",
      blocked: "BLOCKED",
    };
    const statusLabel = statusLabels[readiness.overallStatus];
    if (!statusLabel || typeof readiness.overallScore !== "number") {
      readinessIssues.push("readiness API returned an invalid status or score");
    } else {
      await readinessPage.goto(`${baseUrl}/settings`, {
        waitUntil: "networkidle",
        timeout: 30000,
      });
      const expectedBadge = `${readiness.overallScore.toFixed(1)} / 5 ${statusLabel}`;
      const badgeVisible = await readinessPage
        .getByText(expectedBadge, { exact: true })
        .isVisible()
        .catch(() => false);
      if (!badgeVisible) {
        readinessIssues.push(`Settings does not show API status badge: ${expectedBadge}`);
      }
      const bodyText = await readinessPage.locator("body").innerText();
      const blockers = Array.isArray(readiness.deployment?.blockers)
        ? readiness.deployment.blockers.filter((value) => typeof value === "string")
        : [];
      for (const blocker of blockers) {
        if (!bodyText.includes(blocker)) {
          readinessIssues.push(`Settings does not show API deployment blocker: ${blocker}`);
        }
      }
      if (readiness.overallStatus === "operational" && blockers.length > 0) {
        readinessIssues.push("operational readiness still contains deployment blockers");
      }
    }
  }
  results.push({
    scope: "readiness UI/API consistency",
    result: readiness
      ? {
          overallStatus: readiness.overallStatus,
          overallScore: readiness.overallScore,
          deploymentBlockerCount: Array.isArray(readiness.deployment?.blockers)
            ? readiness.deployment.blockers.length
            : null,
        }
      : null,
    issues: readinessIssues,
  });
  issues.push(...readinessIssues.map((issue) => `readiness consistency: ${issue}`));
  await readinessPage.close();

  const readinessOutagePage = await browser.newPage({ viewport: viewports[1] });
  await bindReleasePage(readinessOutagePage, baseUrl, issues);
  let readinessRequests = 0;
  readinessOutagePage.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/readiness") readinessRequests += 1;
  });
  await readinessOutagePage.route("**/api/readiness*", (route) => route.abort("failed").catch(() => undefined));
  const outageIssues = [];
  await readinessOutagePage.goto(`${baseUrl}/settings`, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  try {
    await readinessOutagePage.getByText("Operational Health is unavailable.").waitFor({ timeout: 10000 });
    await readinessOutagePage.getByRole("button", { name: "Retry health check" }).waitFor({ timeout: 10000 });
  } catch {
    outageIssues.push("Settings does not expose a clear readiness outage and retry action");
  }
  const requestsBeforeRetry = readinessRequests;
  if (outageIssues.length === 0) {
    await readinessOutagePage
      .getByRole("button", { name: "Retry health check" })
      .click();
    await readinessOutagePage.waitForTimeout(250);
    if (readinessRequests <= requestsBeforeRetry) {
      outageIssues.push("Retry health check did not issue another readiness request");
    }
  }
  results.push({
    scope: "readiness outage recovery UI",
    result: {
      unavailableMessageVisible: outageIssues.length === 0,
      retryRequests: readinessRequests,
    },
    issues: outageIssues,
  });
  issues.push(...outageIssues.map((issue) => `readiness outage recovery: ${issue}`));
  await readinessOutagePage.close();

  const securityPage = await browser.newPage({ viewport: viewports[1] });
  await bindReleasePage(securityPage, baseUrl, issues);
  const securityIssues = [];
  const securityResponse = await securityPage.goto(`${baseUrl}/`, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  const securityHeaders = securityResponse?.headers() ?? {};
  const expectedHeaders = {
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
  };
  for (const [name, expected] of Object.entries(expectedHeaders)) {
    if (securityHeaders[name] !== expected) {
      securityIssues.push(
        `${name} is ${securityHeaders[name] ?? "missing"}; expected ${expected}`,
      );
    }
  }
  const csp = securityHeaders["content-security-policy"] ?? "";
  for (const directive of [
    "default-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ]) {
    if (!csp.includes(directive)) {
      securityIssues.push(`content-security-policy is missing ${directive}`);
    }
  }
  if (requireHsts) {
    const hsts = securityHeaders["strict-transport-security"] ?? "";
    const maxAge = Number(/(?:^|;)\s*max-age=(\d+)/i.exec(hsts)?.[1]);
    if (!Number.isFinite(maxAge) || maxAge < 31536000) {
      securityIssues.push(
        "strict-transport-security is missing at least a one-year max-age",
      );
    }
  }
  results.push({
    scope: "response security headers",
    result: {
      cspPresent: Boolean(csp),
      hstsRequired: requireHsts,
      hstsPresent: Boolean(securityHeaders["strict-transport-security"]),
    },
    issues: securityIssues,
  });
  issues.push(...securityIssues.map((issue) => `security headers: ${issue}`));
  await securityPage.close();

  const callbackPage = await browser.newPage({ viewport: viewports[1] });
  await bindReleasePage(callbackPage, baseUrl, issues);
  const callbackIssues = [];
  let externalNavigationAttempted = false;
  await callbackPage.route("https://attacker.invalid/**", async (route) => {
    externalNavigationAttempted = true;
    await route.abort();
  });
  try {
    await callbackPage.goto(
      `${baseUrl}/auth/callback?next=${encodeURIComponent("https://attacker.invalid/phish")}`,
      { waitUntil: "networkidle", timeout: 30000 },
    );
  } catch (error) {
    callbackIssues.push(
      `callback navigation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const callbackUrl = new URL(callbackPage.url());
  const expectedCallbackOrigin = new URL(baseUrl);
  if (externalNavigationAttempted) {
    callbackIssues.push("auth callback attempted an off-origin redirect");
  }
  if (!isTrustedCallbackOrigin(callbackUrl, expectedCallbackOrigin)) {
    callbackIssues.push(`auth callback ended on untrusted origin ${callbackUrl.origin}`);
  }
  if (callbackUrl.pathname !== "/login") {
    callbackIssues.push(`auth callback ended on ${callbackUrl.pathname} instead of /login`);
  }
  const callbackErrorVisible = await callbackPage
    .getByText("Invalid sign-in callback", { exact: true })
    .isVisible()
    .catch(() => false);
  if (!callbackErrorVisible) {
    callbackIssues.push("missing explicit invalid callback error");
  }
  const crossOriginMutationResponse = await callbackPage.request.post(
    `${baseUrl}/api/incident`,
    {
      headers: {
        "content-type": "application/json",
        origin: "https://attacker.invalid",
      },
      data: { locationId: "utah-county-ut" },
    },
  );
  const crossOriginMutationBody = await crossOriginMutationResponse
    .json()
    .catch(() => null);
  if (
    crossOriginMutationResponse.status() !== 403 ||
    crossOriginMutationBody?.error !== "Cross-origin request rejected"
  ) {
    callbackIssues.push("served incident mutation did not reject attacker origin");
  }
  results.push({
    scope: "cross-origin auth and mutation guards",
    result: {
      finalUrl: callbackPage.url(),
      externalNavigationAttempted,
      crossOriginMutationStatus: crossOriginMutationResponse.status(),
    },
    issues: callbackIssues,
  });
  issues.push(...callbackIssues.map((issue) => `auth callback: ${issue}`));
  await callbackPage.close();

  await verifyReleaseIdentity(baseUrl, identity.releaseId);
  const report = {
    ok: issues.length === 0,
    releaseId: identity.releaseId,
    baseUrl,
    routes: routes.length,
    viewports: viewports.map(({ name, width, height }) => ({ name, width, height })),
    results,
    issues,
  };
  console.log(
    JSON.stringify(
      compactOutput
        ? {
            ok: report.ok,
            releaseId: report.releaseId,
            baseUrl: report.baseUrl,
            routes: report.routes,
            viewports: report.viewports,
            checks: report.results.length,
            issues: report.issues,
          }
        : report,
      null,
      2,
    ),
  );

  if (issues.length > 0) process.exitCode = 1;
} catch (error) {
  console.error(
    "Browser smoke failed:",
    error instanceof Error ? error.message : inspect(error),
  );
  process.exitCode = 1;
} finally {
  await browser.close();
}
