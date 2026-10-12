import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { admitAppTarget } from "./sentinel-target.mjs";

const baseUrl = admitAppTarget(process.env.FIREAFTER_TEST_BASE || process.env.SENTINEL_TARGET_APP_URL || "http://127.0.0.1:3020").replace(
  /\/$/,
  "",
);
const outputDir = resolve("output/playwright/judge-deck-current");
const captures = [
  { path: "/", file: "queue-current.png", requiredText: "Action Queue" },
  { path: "/map", file: "map-current.png", requiredText: "Selected Map Priorities" },
  { path: "/history", file: "history-current.png", requiredText: "History & Audit" },
  { path: "/settings", file: "settings-current.png", requiredText: "Product Promise Check" },
];

await mkdir(outputDir, { recursive: true });
const browser = await chromium.launch();
const results = [];

try {
  for (const capture of captures) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const response = await page.goto(`${baseUrl}${capture.path}`, {
      waitUntil: "networkidle",
      timeout: 30000,
    });
    if (!response?.ok()) {
      throw new Error(`${capture.path} returned ${response?.status() ?? "no response"}`);
    }
    await page.getByText(capture.requiredText, { exact: true }).first().waitFor();
    const dimensions = await page.evaluate(() => ({
      bodyWidth: document.body.scrollWidth,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    }));
    if (
      dimensions.bodyWidth > dimensions.viewportWidth ||
      dimensions.documentWidth > dimensions.viewportWidth
    ) {
      throw new Error(`${capture.path} has horizontal overflow`);
    }
    const file = resolve(outputDir, capture.file);
    await page.screenshot({ path: file, fullPage: true });
    results.push({ path: capture.path, file, ...dimensions });
    await page.close();
  }
} finally {
  await browser.close();
}

console.log(
  JSON.stringify(
    {
      ok: true,
      source: "current local worktree preview",
      baseUrl,
      capturedAt: new Date().toISOString(),
      captures: results,
    },
    null,
    2,
  ),
);
