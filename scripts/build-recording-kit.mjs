import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const runtime = process.env.ARTIFACT_TOOL_MODULE;
const skill = process.env.PRESENTATION_SKILL_DIR;
const python = process.env.PRESENTATION_PYTHON;
if (!runtime || !skill || !python) throw new Error("Set bundled presentation runtime, skill and Python paths.");
const { FileBlob, PresentationFile } = await import(pathToFileURL(runtime).href);
const { finalizePresentation } = await import(pathToFileURL(path.join(skill, "container_tools/artifact_tool_utils.mjs")).href);
const require = createRequire(import.meta.url);
const { validateDemoScript } = require("./build-judge-deck.cjs");
const build = path.join(root, "output/judge-recording-kit-20261002");
const final = path.join(root, "docs/FireAfter-Judge-Presentation-2026-10-02-final.pptx");
await fs.mkdir(build, { recursive: true });
const source = path.join(build, "base-nine-slides.pptx");
const presentation = await PresentationFile.importPptx(await FileBlob.load(source));
const inspect = await presentation.inspect({ kind: "slide,textbox,shape,image,notes", maxChars: 400000 });
await fs.writeFile(path.join(build, "before.ndjson"), inspect.ndjson);
const records = inspect.ndjson.split("\n").filter(Boolean).map(line => JSON.parse(line));
const originalSlides = records.filter(record => record.kind === "slide");
if (originalSlides.length !== 9) throw new Error("Expected the nine-slide source deck, not a previous appended output.");
const script = await fs.readFile(path.join(root, "docs/demo-script.md"), "utf8");
const notes = validateDemoScript(script);
for (const [index, record] of originalSlides.entries()) {
  presentation.resolve(record.id).speakerNotes.textFrame.setText(notes[index] +
    "\n\nSlide capture provenance: October 2, 2026, 12:40 UTC. Live app rechecked October 2, 17:50 UTC. These screenshot pixels remain historical. App source: https://fireafter-app.vercel.app/?incidentId=incident-monterey-county-ca\nAppendix slides follow the five-minute closing hold and are not part of its timing.");
}
const replacements = new Map([
  ["OCT 2, 2026, 12:40 UTC SNAPSHOT | CORE PATH VERIFIED | UNKNOWN IS NOT LOW RISK | FULL FEATURE CERTIFICATION INCOMPLETE",
    "CAPTURES: OCT 2, 12:40 UTC | LIVE RECHECK: 17:50 UTC | UNKNOWN RISK | FIELD VALIDATION PENDING"],
  ["One evidence model. New regions, same workflow.", "One workflow across two saved counties"],
  ["Source adapters can change without changing how responders review, decide, and audit.",
    "Monterey: 682 items and 197 basins. Okanogan: 226 items, with different source coverage."],
  ["Direct permissioned responder validation remains pending.", "Next step: a permissioned responder pilot with measured review outcomes."],
  ["LIVE REHEARSAL RESULT", "DATED REHEARSAL RESULT"],
  ["A named road, bridge, crossing, facility, or local asset.", "A named asset and its source."],
  ["Missing and proxy-only inputs reduce confidence.", "Missing inputs limit confidence."],
  ["A review step for a human responder to consider.", "A review step for a responder."],
  ["MTBS boundaries do not provide measured burn severity. Missing measurements remain missing.", "MTBS boundaries supply context only. Measured burn severity remains unavailable."],
  ["CSV or GeoJSON can add local inventory. Uploads stay unverified; successful live import is not yet rehearsed.", "CSV / GeoJSON adds local records. Uploads remain unverified; live import rehearsal is pending."],
  ["Creation, refresh, evidence linkage, export and audit readback passed. All 682 risks remain Unknown; missing burn and terrain evidence stays visible.", "Saved creation, refresh, export and audit readback passed. All 682 risks remain Unknown."],
]);
for (const record of records.filter(record => record.kind === "textbox" && replacements.has(record.text))) {
  presentation.resolve(record.id).text.replace(record.text, replacements.get(record.text));
}
const spacedBodies = new Set([
  "MTBS boundaries do not provide measured burn severity. Missing measurements remain missing.",
  "CSV or GeoJSON can add local inventory. Uploads stay unverified; successful live import is not yet rehearsed.",
  "Creation, refresh, evidence linkage, export and audit readback passed. All 682 risks remain Unknown; missing burn and terrain evidence stays visible.",
]);
for (const record of records.filter(record => record.kind === "textbox" && spacedBodies.has(record.text))) {
  const [left, top, width, height] = record.bbox;
  const shape = presentation.resolve(record.id);
  shape.position = { left, top: top + 10, width, height: height - 10 };
  shape.text.style = { fontSize: 18, autoFit: "none" };
}

const colors = { bg: "#071725", text: "#F4F8FB", muted: "#A5BED0", orange: "#FF7A18", cyan: "#43D6FF", border: "#21445D" };
function text(slide, value, x, y, w, h, size = 24, color = colors.text, bold = false, face = "Arial") {
  const shape = slide.shapes.add({ geometry: "textbox", position: { left: x, top: y, width: w, height: h }, fill: "none", line: { fill: "none", width: 0 } });
  shape.text = value;
  shape.text.style = { typeface: face, fontSize: size, color, bold, autoFit: "none" };
  return shape;
}
function appendix(title, subtitle, number, note) {
  const slide = presentation.slides.add();
  slide.background.fill = colors.bg;
  text(slide, "JUDGE Q&A APPENDIX", 54, 32, 1000, 28, 16, colors.orange, true);
  text(slide, title, 54, 78, 1160, 72, 42, colors.text, true, "Cambria");
  text(slide, subtitle, 54, 153, 1160, 55, 23, colors.muted);
  text(slide, "FIREAFTER   /   October 2, 2026   /   Outside the five-minute recording", 54, 674, 1110, 27, 14, colors.muted);
  text(slide, String(number), 1190, 674, 40, 27, 14, colors.muted);
  slide.speakerNotes.textFrame.setText(note);
  return slide;
}
function node(slide, title, body, x, y, w, h) {
  slide.shapes.add({ geometry: "rect", position: { left: x, top: y, width: w, height: h }, fill: "#0C2232", line: { fill: colors.border, width: 1 } });
  text(slide, title, x + 16, y + 14, w - 32, 40, 24, colors.cyan, true);
  text(slide, body, x + 16, y + 65, w - 32, h - 76, 21, colors.text);
}
function arrow(slide, x, y, w = 42, h = 22) {
  slide.shapes.add({ geometry: "rightArrow", position: { left: x, top: y, width: w, height: h }, fill: colors.orange, line: { fill: "none", width: 0 } });
}

{
  const slide = appendix("System architecture", "A server-owned evidence pipeline with an authenticated human review boundary", 10,
    "Sources: repository pkg.json, docs/architecture.md, src/lib/live-sources.ts, src/lib/fireafter-supabase.ts, src/lib/operational-write-security.ts. Diagram describes implementation, not independent certification. Supabase Auth and membership checks precede authorized mutations. Public views receive redacted projections. No service credentials reach client components.");
  node(slide, "Public sources", "Weather and fire context\nUSGS basins and terrain\nRoads, bridges, facilities", 54, 236, 300, 196);
  arrow(slide, 363, 320);
  node(slide, "Next.js on Vercel", "Bounded adapters\nGeometry validation\nDeterministic review model", 416, 236, 390, 196);
  arrow(slide, 815, 320);
  node(slide, "Supabase", "Postgres / PostGIS\nAtomic incident inventory\nSource and score snapshots", 868, 236, 356, 196);
  text(slide, "Browser", 60, 474, 280, 35, 27, colors.orange, true);
  text(slide, "Queue, map, assets, history\nRestricted details redacted in public views", 60, 522, 440, 84, 24);
  text(slide, "Authorized decisions", 534, 474, 560, 35, 27, colors.orange, true);
  text(slide, "Auth + role + incident ownership checks\nAppend-only action and evidence history", 534, 522, 670, 84, 24);
}
{
  const slide = appendix("Refresh and decision data flow", "Incomplete evidence stays explicit at every step", 11,
    "Sources: src/lib/refresh-operation.ts, src/lib/live-sources.ts, src/lib/scoring.ts, src/lib/fireafter-supabase.ts. Default root refresh: 120 seconds, 96 MiB cumulative inbound budget, bounded concurrency and requests. Whole-inventory reads remain 30 seconds. New scoped inventory transport permits 20 seconds per complete page without raising its eight-MiB byte cap. Optional source failure is not permission to fabricate evidence. Human decisions preserve the reviewed snapshot separately.");
  const steps = [
    ["1  Select", "County identity\nPublished fire context"],
    ["2  Acquire", "Bounded public queries\nSource age and status"],
    ["3  Validate", "Complete inventory\nExact basin geometry"],
    ["4  Review", "Explainable order\nUnknown if incomplete"],
    ["5  Persist", "Atomic saved bundle\nReloadable workspace"],
    ["6  Decide", "Authorized human\nRetained audit snapshot"],
  ];
  steps.forEach(([title, body], index) => {
    const x = 54 + index * 197;
    node(slide, title, body, x, 245, 176, 222);
    if (index < 5) arrow(slide, x + 179, 336, 15, 16);
  });
  text(slide, "Unavailable source", 60, 510, 355, 35, 25, colors.orange, true);
  text(slide, "Visible limitation; no replacement values", 60, 554, 355, 70, 23);
  text(slide, "Incomplete inventory", 440, 510, 380, 35, 25, colors.orange, true);
  text(slide, "Reject the operation; no silent truncation", 440, 554, 360, 70, 23);
  text(slide, "Changed evidence", 855, 510, 355, 35, 25, colors.orange, true);
  text(slide, "New queue explanation; old decision preserved", 855, 554, 355, 70, 23);
}
{
  const slide = appendix("Feature coverage", "Eleven capabilities, with clear boundaries on what today's rehearsal proves", 12,
    "Source: docs/features.md and src/lib/feature-graph.ts. Feature availability is not equivalent to live certification. The timed demo focuses on the existing saved county, one public bridge, map, retained review and status. Successful live import and every action/recovery variant remain unverified. Crossings require both road and hydrography evidence, absent in this rehearsal.");
  const features = [
    ["Ranked queue", "Six evidence questions on each card"],
    ["Public data integration", "Source identities and coverage stay visible"],
    ["Degraded mode", "Missing measurements remain missing"],
    ["Crossing inference", "Screening candidates where geometry exists"],
    ["Local import", "CSV / GeoJSON; uploaded records stay unverified"],
    ["Human review", "Decision, note and original evidence snapshot"],
    ["Restricted-data redaction", "Public views omit restricted facility details"],
    ["Change explanation", "Rank, score and source-status differences"],
    ["County workspaces", "Monterey and Okanogan survive reload"],
    ["GeoJSON export", "GIS data with limitations and provenance"],
    ["Health and promise checks", "Coverage and workflow gaps are inspectable"],
  ];
  features.forEach(([title, body], index) => {
    const column = index < 6 ? 0 : 1;
    const row = index < 6 ? index : index - 6;
    const x = 54 + column * 610, y = 223 + row * 70;
    text(slide, `${index + 1}. ${title}`, x, y, 570, 30, 24, colors.cyan, true);
    text(slide, body, x + 26, y + 31, 544, 32, 20, colors.text);
  });
}
{
  const slide = appendix("Validation and next steps", "A working review demonstration, with a defined path toward agency evaluation", 13,
    "Evidence: docs/demo-rehearsal-2026-10-02.md, docs/model-card.md and docs/recording-kit-2026-10-02.md. Proposed pilot measures are future evaluation targets, not achieved results. No agency endorsement, emergency readiness, calibrated prediction performance or prize outcome is asserted. Full automated test run: 1439 Vitest tests plus 143 Node tests passed; one opt-in test skipped. Those are local test results, separate from browser/provider evidence.");
  text(slide, "Demonstrated", 54, 233, 530, 44, 30, colors.cyan, true);
  text(slide, "Two saved counties\nPublic-source bridge and basin linkage\nRefresh, reload and retained review\nVisible uncertainty and GIS export", 54, 297, 540, 228, 27);
  text(slide, "Still required", 675, 233, 545, 44, 30, colors.orange, true);
  text(slide, "Measured fire-linked burn severity\nResponder calibration and field validation\nReliable background source acquisition\nComplete import / recovery assurance", 675, 297, 545, 228, 27);
  text(slide, "Proposed pilot measures", 54, 551, 1150, 36, 27, colors.cyan, true);
  text(slide, "Time to justified review   /   Missed assets   /   Incorrect links   /   Audit completeness", 54, 604, 1160, 36, 23);
}

const candidatePath = path.join(build, "candidate.pptx");
await (await PresentationFile.exportPptx(presentation)).save(candidatePath);
await finalizePresentation({
  workspaceDir: root, candidatePath, finalPath: final, pythonExecutable: python,
  integrityValidatorPath: path.join(skill, "container_tools/inspect_presentation_package_integrity.py"),
  layoutValidatorPath: path.join(skill, "container_tools/inspect_presentation_layout_geometry.py"),
  layoutArgs: ["--expected-slide-size-emu", "12192000,6858000", "--validate-heading-fit"],
  explicitTotalSlideCount: 13,
  requiredNativeTableOwnerSlides: [], requiredNativeChartOwnerSlides: [],
  fontPolicy: { basis: "design", families: ["Cambria", "Arial"] },
  verifyArtifactToolImport: true,
  receiptPath: path.join(build, "validation-final.json"),
});
console.log(JSON.stringify({ final, slides: 13, mainSlides: 9, appendixSlides: 4 }));
