import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function validateStoryboard(source) {
  const start = "<!-- sentinel-video-storyboard -->";
  const end = "<!-- /sentinel-video-storyboard -->";
  if (source.split(start).length !== 2 || source.split(end).length !== 2 || source.indexOf(end) < source.indexOf(start)) {
    throw new Error("Use one complete canonical storyboard table.");
  }
  const table = source.split(start)[1].split(end)[0];
  const lines = table.trim().split(/\r?\n/);
  if (lines.length !== 9 || lines[0] !== "| Start | End | On screen | Narration / evidence |" ||
      lines[1] !== "| --- | --- | --- | --- |") throw new Error("Storyboard requires seven complete segments.");
  let elapsed = 0;
  const segments = lines.slice(2).map(line => {
    const match = line.match(/^\| (\d+):([0-5]\d) \| (\d+):([0-5]\d) \| ([^|]+) \| ([^|]+) \|$/);
    if (!match) throw new Error("Invalid segment timing or missing screen/narration.");
    const from = Number(match[1]) * 60 + Number(match[2]);
    const to = Number(match[3]) * 60 + Number(match[4]);
    if (from !== elapsed || to <= from) throw new Error("Segments must start at zero and be contiguous in order.");
    elapsed = to;
    return { startSeconds: from, endSeconds: to, screen: match[5].trim(), narration: match[6].trim() };
  });
  if (elapsed >= 180) throw new Error("The public demo must be under three minutes.");
  if (segments.some(segment => !segment.screen || !segment.narration)) throw new Error("Missing presenter content.");
  const headings = [...source.matchAll(/^### (\d+):([0-5]\d)–(\d+):([0-5]\d) — /gm)];
  if (headings.length !== segments.length || headings.some((heading, index) =>
    Number(heading[1]) * 60 + Number(heading[2]) !== segments[index].startSeconds ||
    Number(heading[3]) * 60 + Number(heading[4]) !== segments[index].endSeconds)) {
    throw new Error("Recording narration headings must match the canonical storyboard.");
  }
  return segments;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const segments = validateStoryboard(readFileSync(new URL("../docs/SUBMISSION_PLAN.md", import.meta.url), "utf8"));
  console.log(JSON.stringify({ segments, totalSeconds: segments.at(-1).endSeconds,
    scope: "Storyboard structure only; no captured footage, sponsor execution or rehearsal proven" }, null, 2));
}
