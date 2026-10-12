import { readFileSync, realpathSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { SentinelTargetError, requireAppTarget, requireSupabaseTarget } from "../src/lib/sentinel/target-policy.mjs";

function requireRepository(remoteRequired) {
  const root = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
  if (realpathSync(process.cwd()) !== root ||
      JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).name !== "fireafter-sentinel") throw new SentinelTargetError();
  if (!remoteRequired) return;
  if (!statSync(path.join(root, ".git")).isDirectory()) throw new SentinelTargetError();
  if (!process.env.SENTINEL_TARGET_REPO_ROOT || realpathSync(process.env.SENTINEL_TARGET_REPO_ROOT) !== root ||
      !process.env.SENTINEL_TARGET_REPOSITORY_URL) throw new SentinelTargetError();
  let actual;
  try { actual = execFileSync("git", ["-c", `safe.directory=${root}`, "remote", "get-url", "origin"],
    { cwd: root, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  catch { throw new SentinelTargetError(); }
  if (actual !== process.env.SENTINEL_TARGET_REPOSITORY_URL || /(?:[:/])vijay-v-bhoyar\/FireAfter(?:\.git)?\/?$/i.test(actual)) throw new SentinelTargetError();
}

export function admitSupabaseTarget(url) {
  const origin = requireSupabaseTarget(url);
  requireRepository(true);
  return origin;
}

export function admitAppTarget(url) {
  const origin = requireAppTarget(url);
  requireRepository(!["127.0.0.1", "[::1]"].includes(new URL(origin).hostname));
  return origin;
}
