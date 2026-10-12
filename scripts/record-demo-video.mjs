import { mkdirSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { assertDemoPasswordNotCompromised } from "./demo-credential-policy.mjs";
import { admitAppTarget } from "./sentinel-target.mjs";

const baseUrl = admitAppTarget(process.env.FIREAFTER_DEMO_BASE_URL ?? process.env.SENTINEL_TARGET_APP_URL ?? "http://127.0.0.1:3020");
const email = requiredEnv("FIREAFTER_DEMO_EMAIL");
const password = requiredEnv("FIREAFTER_DEMO_PASSWORD");
const outputDir = resolve("output/playwright/backup-video");
const staleFallbackLabel = "Recent/year-to-date fire perimeter fallback";

assertDemoPasswordNotCompromised(password, "FIREAFTER_DEMO_PASSWORD");

mkdirSync(outputDir, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  recordVideo: {
    dir: outputDir,
    size: { width: 1440, height: 1000 },
  },
});

const page = await context.newPage();

try {
  await page.goto(`${baseUrl}/login`, { waitUntil: "networkidle" });
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign In" }).click();
  await page.waitForURL(`${baseUrl}/`, { timeout: 30000 });
  await page.waitForLoadState("networkidle");

  await expectVisibleText(page, "Action Queue");
  await expectVisibleText(page, "Review Recommendation");
  await assertTextAbsent(page, staleFallbackLabel);
  await page.waitForTimeout(1800);

  await page.goto(`${baseUrl}/map`, { waitUntil: "networkidle" });
  await expectVisibleText(page, "Map Layers");
  await assertTextAbsent(page, staleFallbackLabel);
  await page.waitForTimeout(1400);

  await page.goto(`${baseUrl}/history`, { waitUntil: "networkidle" });
  await expectVisibleText(page, "History & Audit");
  await expectVisibleText(page, "Recommendation snapshot");
  await page.waitForTimeout(1800);

  await page.goto(`${baseUrl}/settings`, { waitUntil: "networkidle" });
  await expectVisibleText(page, "Product Promise Check");
  await expectVisibleText(page, "Operational Health");
  await expectVisibleText(page, "Export GeoJSON");
  await assertTextAbsent(page, staleFallbackLabel);
  await page.waitForTimeout(1800);
} finally {
  await context.close();
  await browser.close();
}

const latestVideo = newestFile(outputDir, ".webm");
if (!latestVideo) {
  throw new Error(`No .webm recording found in ${outputDir}`);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      baseUrl,
      video: latestVideo,
    },
    null,
    2,
  ),
);

async function expectVisibleText(page, text) {
  await page.getByText(text).first().waitFor({ state: "visible", timeout: 30000 });
}

async function assertTextAbsent(page, text) {
  const count = await page.getByText(text).count();
  if (count > 0) {
    throw new Error(`Unexpected stale demo text found: ${text}`);
  }
}

function newestFile(directory, extension) {
  return readdirSync(directory)
    .filter((name) => name.endsWith(extension))
    .map((name) => {
      const path = resolve(directory, name);
      return { path, mtimeMs: statSync(path).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.path;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
