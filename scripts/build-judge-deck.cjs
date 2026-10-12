/* eslint-disable @typescript-eslint/no-require-imports -- PptxGenJS build tool runs as explicit CommonJS. */
const fs = require("node:fs");
const path = require("node:path");
const PptxGenJS = require("pptxgenjs");
const sharp = require("sharp");

const ROOT = path.resolve(__dirname, "..");
const OUTPUT = path.join(ROOT, "docs", "FireAfter-Judge-Presentation.pptx");
const LEGACY_OUTPUT = path.join(ROOT, "output", "judge-deck", "FireAfter-Judge-Deck.pptx");
const DEMO_SCRIPT = path.join(ROOT, "docs", "demo-script.md");
const GENERATED_DIR = path.join(ROOT, "output", "judge-deck", "generated-assets");
const CAPTURE_DIR = path.join(ROOT, "output", "judge-deck", "captures-20261002");
const RAW = {
  queue: path.join(CAPTURE_DIR, "queue-current.jpg"),
  map: path.join(CAPTURE_DIR, "map-current.jpg"),
  settings: path.join(CAPTURE_DIR, "settings-current.jpg"),
};
const IMG = {
  queueHero: path.join(GENERATED_DIR, "queue-hero.png"),
  queueWide: path.join(GENERATED_DIR, "queue-wide.png"),
  queueDetail: path.join(GENERATED_DIR, "queue-detail.png"),
  map: path.join(GENERATED_DIR, "map-wide.png"),
  settings: path.join(GENERATED_DIR, "settings-proof.png"),
  logo: path.join(ROOT, "public", "brand", "fireafter-logo.jpg"),
};
const imageDimensions = new Map();

const pptx = new PptxGenJS();
pptx.layout = "LAYOUT_WIDE";
pptx.author = "FireAfter";
pptx.company = "FireAfter";
pptx.subject = "Five-minute judge presentation";
pptx.title = "FireAfter - Post-Wildfire Storm Risk. Action First.";
pptx.lang = "en-US";
pptx.theme = {
  headFontFace: "Cambria",
  bodyFontFace: "Arial",
  lang: "en-US",
};
pptx.defineSlideMaster({
  title: "FIREAFTER",
  background: { color: "071725" },
  objects: [],
});

const C = {
  bg: "071725",
  panel: "0C2232",
  panel2: "0A1A2B",
  border: "21445D",
  white: "F4F8FB",
  muted: "A5BED0",
  cyan: "43D6FF",
  blue: "0EA5E9",
  green: "16D69A",
  orange: "FF7A18",
  yellow: "F4C95D",
  red: "FF5E6C",
};

let notes = [];
let rehearsalLabel = "REHEARSAL EVIDENCE NOT VERIFIED";
const REHEARSAL = Object.freeze({
  date: "Oct 2, 2026, 12:40 UTC",
  assets: "682",
  basins: "197",
  promise: "6/6",
  linkedRecommendations: "1",
  health: "4.7/5 Needs Attention",
  auditNote: "Demo rehearsal only: accepting the recommendation to review missing evidence, not a hazard rating or field validation. No dispatch, closure, or evacuation is authorized.",
});

function addTitle(slide, kicker, title, subtitle, titleX = 0.55) {
  slide.addText(kicker.toUpperCase(), {
    x: 0.55, y: 0.38, w: 3.4, h: 0.28, fontFace: "Arial", fontSize: 10,
    bold: true, charSpacing: 1.8, color: C.orange, margin: 0,
  });
  const titleSize = title.length > 50 ? 20 : title.length > 42 ? 21 : title.length > 34 ? 22 : 25;
  slide.addText(title, {
    x: titleX, y: 0.72, w: 11.55 - titleX, h: 0.72, fontFace: "Cambria", fontSize: titleSize,
    bold: true, color: C.white, margin: 0, align: "left", fit: "shrink",
  });
  if (subtitle) {
    slide.addText(subtitle, {
      x: 0.57, y: 1.39, w: 11.9, h: 0.42, fontFace: "Arial", fontSize: 12.5,
      color: C.muted, margin: 0, fit: "shrink",
    });
  }
}

function addTime(slide, time) {
  slide.addShape(pptx.ShapeType.roundRect, {
    x: 11.45, y: 0.34, w: 1.28, h: 0.38, rectRadius: 0.08,
    fill: { color: "172B3D" }, line: { color: C.border, width: 1 },
  });
  slide.addText(time, {
    x: 11.45, y: 0.4, w: 1.28, h: 0.24, align: "center", fontFace: "Arial",
    fontSize: 9, bold: true, color: C.cyan, margin: 0, valign: "mid",
  });
}

function addImageCard(slide, file, x, y, w, h, altText) {
  slide.addShape(pptx.ShapeType.roundRect, {
    x, y, w, h, rectRadius: 0.08,
    fill: { color: C.panel2 }, line: { color: C.border, width: 1.2 },
    shadow: { type: "outer", color: "000000", opacity: 0.24, blur: 2, angle: 45, distance: 1 },
  });
  slide.addImage({
    path: file, ...pptxgenSizing(file, x + 0.08, y + 0.08, w - 0.16, h - 0.16),
    altText,
  });
}

function pptxgenSizing(file, x, y, w, h) {
  const { width, height } = imageDimensions.get(file);
  const scale = Math.min(w / width, h / height);
  const fittedW = width * scale;
  const fittedH = height * scale;
  return { x: x + (w - fittedW) / 2, y: y + (h - fittedH) / 2, w: fittedW, h: fittedH };
}

function addCallout(slide, x, y, w, h, label, body, accent = C.cyan) {
  slide.addShape(pptx.ShapeType.roundRect, {
    x, y, w, h, rectRadius: 0.08,
    fill: { color: C.panel }, line: { color: C.border, width: 1 },
  });
  slide.addShape(pptx.ShapeType.rect, {
    x, y, w: 0.08, h, fill: { color: accent }, line: { color: accent },
  });
  slide.addText(label.toUpperCase(), {
    x: x + 0.22, y: y + 0.18, w: w - 0.35, h: 0.2, fontFace: "Arial", fontSize: 9,
    bold: true, color: accent, charSpacing: 1.1, margin: 0,
  });
  slide.addText(body, {
    x: x + 0.22, y: y + 0.48, w: w - 0.38, h: h - 0.62, fontFace: "Arial",
    fontSize: 14, bold: true, color: C.white, margin: 0, breakLine: false, fit: "shrink",
  });
}

function addMetric(slide, x, y, w, value, label, accent) {
  slide.addShape(pptx.ShapeType.roundRect, {
    x, y, w, h: 1.05, rectRadius: 0.08,
    fill: { color: C.panel }, line: { color: C.border, width: 1 },
  });
  slide.addText(value, {
    x: x + 0.15, y: y + 0.15, w: w - 0.3, h: 0.38, fontFace: "Cambria", fontSize: 24,
    bold: true, color: accent, margin: 0, fit: "shrink",
  });
  slide.addText(label, {
    x: x + 0.15, y: y + 0.62, w: w - 0.3, h: 0.22, fontFace: "Arial", fontSize: 9.5,
    bold: true, color: C.muted, margin: 0, fit: "shrink",
  });
}

function addStep(slide, n, x, y, title, body, accent = C.cyan) {
  slide.addShape(pptx.ShapeType.ellipse, {
    x, y, w: 0.48, h: 0.48, fill: { color: accent }, line: { color: accent },
  });
  slide.addText(String(n), {
    x, y: y + 0.1, w: 0.48, h: 0.16, align: "center", fontFace: "Arial", fontSize: 11,
    bold: true, color: C.bg, margin: 0,
  });
  slide.addText(title, {
    x: x + 0.66, y: y - 0.02, w: 2.45, h: 0.25, fontFace: "Arial", fontSize: 13,
    bold: true, color: C.white, margin: 0,
  });
  slide.addText(body, {
    x: x + 0.66, y: y + 0.27, w: 2.4, h: 0.45, fontFace: "Arial", fontSize: 9.5,
    color: C.muted, margin: 0, fit: "shrink",
  });
}

function addNotes(slide, index, withFooter = true) {
  slide.background = { color: C.bg };
  if (rehearsalLabel) {
    slide.addText(rehearsalLabel, {
      x: 0.55, y: 6.96, w: 12.2, h: 0.16, align: "center", fontFace: "Arial",
      fontSize: 8, bold: true, color: C.yellow, margin: 0,
    });
  }
  if (withFooter) {
    slide.addShape(pptx.ShapeType.line, { x: 0.48, y: 7.15, w: 12.36, h: 0, line: { color: "183750", width: 1 } });
    slide.addText("FIREAFTER", { x: 0.52, y: 7.17, w: 1.4, h: 0.25, fontFace: "Arial", fontSize: 7, bold: true, color: C.orange, margin: 0, valign: "mid" });
    slide.addText("Post-Wildfire Storm Risk. Action First.", { x: 2.0, y: 7.17, w: 3.0, h: 0.25, fontFace: "Arial", fontSize: 7, color: C.muted, margin: 0, valign: "mid" });
    slide.addText("fireafter-app.vercel.app", { x: 10.52, y: 7.17, w: 2.3, h: 0.25, fontFace: "Arial", fontSize: 7, color: C.muted, align: "right", margin: 0, valign: "mid" });
    slide.addText(String(index + 1), { x: 12.9, y: 7.17, w: 0.16, h: 0.25, fontFace: "Arial", fontSize: 7, color: C.muted, align: "right", margin: 0, valign: "mid" });
  }
  slide.addNotes(notes[index]);
}

async function prepareAssets() {
  for (const [name, file] of Object.entries({ ...RAW, logo: IMG.logo })) {
    if (!fs.existsSync(file)) {
      throw new Error(`Missing ${name} presentation asset: ${file}`);
    }
  }
  fs.mkdirSync(GENERATED_DIR, { recursive: true });
  const crop = async (source, destination, requested) => {
    const { width, height } = await sharp(source).metadata();
    if (!width || !height || requested.left >= width || requested.top >= height) {
      throw new Error(`Capture is too small for its presentation crop: ${source}`);
    }
    await sharp(source).extract({ ...requested,
      width: Math.min(requested.width, width - requested.left),
      height: Math.min(requested.height, height - requested.top),
    }).png().toFile(destination);
  };
  await Promise.all([
    crop(RAW.queue, IMG.queueHero, { left: 264, top: 20, width: 1048, height: 720 }),
    crop(RAW.queue, IMG.queueWide, { left: 264, top: 20, width: 1048, height: 720 }),
    crop(RAW.queue, IMG.queueDetail, { left: 264, top: 20, width: 430, height: 466 }),
    sharp(RAW.map).png().toFile(IMG.map),
    sharp(RAW.settings).png().toFile(IMG.settings),
  ]);
  for (const file of Object.values(IMG)) imageDimensions.set(file, await sharp(file).metadata());
}

const TIMINGS = ["0:00-0:25", "0:25-0:50", "0:50-1:35", "1:35-2:20", "2:20-3:00", "3:00-3:45", "3:45-4:25", "4:25-4:50", "4:50-5:00"];

function validateDemoScript(source) {
  const sections = [...source.matchAll(/^### (\d:\d{2}-\d:\d{2}) - ([^\r\n]+)\r?\n([\s\S]*?)(?=^## |^### |$(?![\s\S]))/gm)];
  if (sections.length !== TIMINGS.length || sections.some((section, i) => section[1] !== TIMINGS[i])) {
    throw new Error("Judge script must have the nine ordered five-minute sections.");
  }
  if (sections.some(section => !section[3].includes("**On screen:**") || !section[3].includes("**Say:**"))) {
    throw new Error("Every slide needs screen instructions and speaker narration.");
  }
  return sections.map(section => `${section[1]} - ${section[2]}\n${section[3].trim()}`);
}

function rehearsalFooter(source) {
  if (source.includes("**Rehearsal status: CORE PATH VERIFIED, FULL FEATURE CERTIFICATION INCOMPLETE.**")) {
    return "OCT 2, 2026, 12:40 UTC SNAPSHOT | CORE PATH VERIFIED | UNKNOWN IS NOT LOW RISK | FULL FEATURE CERTIFICATION INCOMPLETE";
  }
  if (source.includes("**Rehearsal status: VERIFIED.**")) return "DATED REHEARSAL EVIDENCE | NOT FIELD VALIDATION";
  return "REHEARSAL EVIDENCE NOT VERIFIED | DO NOT CLAIM LIVE DEMO READINESS";
}

function buildSlides() {

const newSlide = () => {
  const slide = pptx.addSlide("FIREAFTER");
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.333333, h: 7.5, fill: { color: C.bg }, line: { color: C.bg, transparency: 100 } });
  return slide;
};

// 1. Problem
{
  const slide = newSlide();
  addTime(slide, "0:00-0:25");
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 5.05, h: 7.15, fill: { color: "081D2C" }, line: { color: "081D2C" } });
  slide.addShape(pptx.ShapeType.roundRect, { x: 0.55, y: 0.52, w: 0.82, h: 0.82, rectRadius: 0.08, fill: { color: "FFFFFF" }, line: { color: C.border, width: 1 } });
  slide.addImage({ path: IMG.logo, x: 0.62, y: 0.59, w: 0.68, h: 0.68, altText: "FireAfter logo" });
  slide.addText("FIREAFTER", { x: 1.48, y: 0.72, w: 2.7, h: 0.3, fontFace: "Arial", fontSize: 20, bold: true, color: C.orange, margin: 0 });
  slide.addText("A second emergency begins when rain meets burned ground.", {
    x: 0.62, y: 1.72, w: 3.9, h: 1.5, fontFace: "Cambria", fontSize: 28, bold: true,
    color: C.white, margin: 0, breakLine: false, fit: "shrink",
  });
  slide.addText("FireAfter turns scattered public evidence into one explainable question:", {
    x: 0.62, y: 3.5, w: 3.65, h: 0.65, fontFace: "Arial", fontSize: 14, color: C.muted,
    margin: 0, fit: "shrink",
  });
  slide.addText("What should we review first, and why?", {
    x: 0.62, y: 4.45, w: 3.82, h: 0.9, fontFace: "Cambria", fontSize: 25, bold: true,
    color: C.cyan, margin: 0, fit: "shrink",
  });
  addImageCard(slide, IMG.queueHero, 4.72, 0.85, 8.05, 5.72, "FireAfter action queue and live source status");
  slide.addText("DECISION SUPPORT, NOT AUTOMATED COMMAND", {
    x: 5.05, y: 6.72, w: 7.4, h: 0.2, fontFace: "Arial", fontSize: 9, bold: true,
    color: C.yellow, align: "right", charSpacing: 1.2, margin: 0,
  });
  addNotes(slide, 0);
}

// 2. Queue first
{
  const slide = newSlide();
  addTitle(slide, "Responder workflow", "The queue is the product", "The map supports the decision. It does not make the responder hunt for one.");
  addTime(slide, "0:25-0:50");
  addImageCard(slide, IMG.queueWide, 0.55, 1.95, 8.25, 4.82, "Ranked FireAfter action queue");
  addCallout(slide, 9.12, 2.0, 3.62, 1.25, "1. Triage", "Rank the locations that deserve attention.", C.orange);
  addCallout(slide, 9.12, 3.48, 3.62, 1.25, "2. Explain", "Put reasons, freshness, confidence, and limits on the card.", C.cyan);
  addCallout(slide, 9.12, 4.96, 3.62, 1.25, "3. Decide", "Keep accept, modify, or reject with the human operator.", C.green);
  addNotes(slide, 1);
}

// 3. Recommendation clarity
{
  const slide = newSlide();
  addTitle(slide, "Explainable action", "Every recommendation answers six questions", "No opaque risk label. No hidden uncertainty. No automated emergency order.");
  addTime(slide, "0:50-1:35");
  addImageCard(slide, IMG.queueDetail, 0.55, 1.92, 6.2, 4.92, "Expanded FireAfter recommendation card");
  const items = [
    [1, "What asset?", "A named road, bridge, crossing, facility, or local asset."],
    [2, "Why ranked?", "Readable reason codes tied to source evidence."],
    [3, "What changed?", "A delta since the previous refresh."],
    [4, "How fresh?", "Source age is visible, not buried."],
    [5, "How confident?", "Missing and proxy-only inputs reduce confidence."],
    [6, "What action?", "A review step for a human responder to consider."],
  ];
  items.forEach(([n, title, body], i) => addStep(slide, n, 7.15 + (i % 2) * 2.9, 2.0 + Math.floor(i / 2) * 1.48, title, body, i === 5 ? C.green : C.cyan));
  slide.addShape(pptx.ShapeType.roundRect, { x: 7.15, y: 6.45, w: 5.72, h: 0.42, rectRadius: 0.06, fill: { color: "2A2112" }, line: { color: C.yellow, width: 1 } });
  slide.addText("BOUNDARY: review recommendation, not evacuation or closure authority", { x: 7.3, y: 6.57, w: 5.42, h: 0.14, fontFace: "Arial", fontSize: 8.5, bold: true, color: C.yellow, align: "center", margin: 0 });
  addNotes(slide, 2);
}

// 4. Evidence model
{
  const slide = newSlide();
  addTitle(slide, "Transparent scoring", "Evidence in. Explainable score out.", "Four relative hazard weights are normalized; quality signals stay separate.", 0.82);
  addTime(slide, "1:35-2:20");
  const weights = [
    ["35", "Rainfall weight", C.cyan],
    ["20", "Burn-severity weight", C.orange],
    ["15", "Terrain weight", C.yellow],
    ["20", "Exposure weight", C.blue],
    ["0", "Freshness hazard weight", C.green],
  ];
  weights.forEach(([v, l, a], i) => addMetric(slide, 0.55 + i * 2.48, 2.0, 2.22, v, l, a));
  slide.addText("SOURCE ADAPTERS", { x: 0.6, y: 3.42, w: 2.2, h: 0.2, fontFace: "Arial", fontSize: 9, bold: true, color: C.orange, charSpacing: 1.4, margin: 0 });
  const sources = ["NWS", "WFIGS", "NASA FIRMS", "MTBS", "USGS", "Census roads", "Bridge inventory", "Facilities"];
  sources.forEach((source, i) => {
    const x = 0.6 + (i % 4) * 1.55;
    const y = 3.82 + Math.floor(i / 4) * 0.62;
    slide.addShape(pptx.ShapeType.roundRect, { x, y, w: 1.34, h: 0.42, rectRadius: 0.06, fill: { color: C.panel }, line: { color: C.border, width: 1 } });
    slide.addText(source, { x, y: y + 0.12, w: 1.34, h: 0.14, align: "center", fontFace: "Arial", fontSize: 8.5, bold: true, color: C.white, margin: 0, fit: "shrink" });
  });
  slide.addShape(pptx.ShapeType.chevron, { x: 6.85, y: 4.08, w: 0.8, h: 0.78, fill: { color: C.orange }, line: { color: C.orange } });
  addCallout(slide, 7.95, 3.55, 4.82, 1.55, "Evidence quality", "Incomplete evidence yields Unknown risk and conservative review ordering. Confidence does not discount hazard.", C.yellow);
  addCallout(slide, 7.95, 5.35, 4.82, 1.16, "Measured versus missing", "MTBS boundaries do not provide measured burn severity. Missing measurements remain missing.", C.green);
  addNotes(slide, 3);
}

// 5. Map and asset discovery
{
  const slide = newSlide();
  addTitle(slide, "Geospatial context", "The map answers where after the queue answers what", "Public geometry supplies screening context; uploading an asset does not field-verify it.");
  addTime(slide, "2:20-3:00");
  addImageCard(slide, IMG.map, 0.55, 1.92, 8.15, 4.92, "FireAfter map with recommendation markers and source layers");
  addCallout(slide, 9.04, 2.0, 3.72, 1.18, "Real basin linkage", "197 published polygons. One bridge linked by exact containment, not a nearest-basin guess.", C.cyan);
  addCallout(slide, 9.04, 3.42, 3.72, 1.38, "Visible coverage gaps", "This county has no loaded hydrography or inferred crossings. The app shows the gap, not invented geometry.", C.orange);
  addCallout(slide, 9.04, 5.04, 3.72, 1.18, "Local knowledge", "CSV or GeoJSON can add local inventory. Uploads stay unverified; successful live import is not yet rehearsed.", C.green);
  slide.addText("INFERRED IS NEVER PRESENTED AS FIELD-VERIFIED", { x: 9.08, y: 6.52, w: 3.62, h: 0.18, align: "center", fontFace: "Arial", fontSize: 8.5, bold: true, color: C.yellow, margin: 0, fit: "shrink" });
  addNotes(slide, 4);
}

// 6. Human decision and audit
{
  const slide = newSlide();
  addTitle(slide, "Accountable operations", "The human decides. The record persists.", "Authenticated actions preserve the exact recommendation snapshot the responder reviewed.");
  addTime(slide, "3:00-3:45");
  addCallout(slide, 6.55, 1.9, 6.25, 1.03, "Verified rehearsal record", "ACCEPTED - evidence review only | October 2, 2026", C.cyan);
  addCallout(slide, 6.55, 3.12, 6.25, 1.82, "Recorded note (verbatim)", REHEARSAL.auditNote, C.yellow);
  addCallout(slide, 6.55, 5.12, 6.25, 1.45, "Persistence checked", "The original Unknown-risk recommendation snapshot survived a full reload and a later source refresh. Excerpt shown; actor details omitted for privacy.", C.green);
  const decisions = [["ACCEPT", C.green], ["MODIFY", C.yellow], ["REJECT", C.red]];
  decisions.forEach(([label, accent], i) => {
    slide.addShape(pptx.ShapeType.roundRect, { x: 0.62 + i * 1.75, y: 2.05, w: 1.5, h: 0.58, rectRadius: 0.08, fill: { color: C.panel }, line: { color: accent, width: 1.4 } });
    slide.addText(label, { x: 0.62 + i * 1.75, y: 2.25, w: 1.5, h: 0.17, align: "center", fontFace: "Arial", fontSize: 10.5, bold: true, color: accent, margin: 0 });
  });
  slide.addShape(pptx.ShapeType.line, { x: 0.8, y: 3.18, w: 4.9, h: 0, line: { color: C.border, width: 2, beginArrowType: "none", endArrowType: "triangle" } });
  addStep(slide, 1, 0.68, 3.52, "Authenticated actor", "Who acted and their incident role.", C.cyan);
  addStep(slide, 2, 0.68, 4.42, "Decision and note", "What changed, when, and why.", C.orange);
  addStep(slide, 3, 0.68, 5.32, "Immutable snapshot", "Score, reasons, freshness, confidence, limits, and evidence.", C.green);
  slide.addText("Append-only audit history", { x: 0.68, y: 6.42, w: 4.9, h: 0.26, fontFace: "Cambria", fontSize: 17, bold: true, color: C.white, margin: 0 });
  addNotes(slide, 5);
}

// 7. Operational proof
{
  const slide = newSlide();
  addTitle(slide, "Operational proof", "The product reports its own limits", "Live source health is separate from deployment health and product-promise integrity.");
  addTime(slide, "3:45-4:25");
  addImageCard(slide, IMG.settings, 0.55, 1.92, 7.2, 4.94, "FireAfter operational health and product promise checks");
  addMetric(slide, 8.12, 2.02, 2.12, REHEARSAL.promise, "Product Promise Check", C.green);
  addMetric(slide, 10.52, 2.02, 2.22, REHEARSAL.assets, "Saved real-source assets", C.cyan);
  addMetric(slide, 8.12, 3.34, 2.12, REHEARSAL.basins, "Published USGS basins", C.cyan);
  addMetric(slide, 10.52, 3.34, 2.22, REHEARSAL.linkedRecommendations, "Linked recommendation", C.green);
  addCallout(slide, 8.12, 4.72, 4.62, 1.25, "Live rehearsal result", "Creation, refresh, evidence linkage, export and audit readback passed. All 682 risks remain Unknown; missing burn and terrain evidence stays visible.", C.yellow);
  slide.addText(`Snapshot: ${REHEARSAL.date}. Health: ${REHEARSAL.health}.`, { x: 8.17, y: 6.15, w: 4.5, h: 0.23, fontFace: "Arial", fontSize: 8.5, color: C.muted, margin: 0, fit: "shrink" });
  slide.addText("Published sources  |  Honest gaps  |  Human review", { x: 8.17, y: 6.42, w: 4.52, h: 0.24, fontFace: "Arial", fontSize: 9, bold: true, color: C.white, margin: 0, fit: "shrink" });
  addNotes(slide, 6);
}

// 8. Close
{
  const slide = newSlide();
  addTitle(slide, "Portable by design", "One evidence model. New regions, same workflow.", "Source adapters can change without changing how responders review, decide, and audit.");
  addTime(slide, "4:25-4:50");
  const x0 = 0.72;
  const cols = [
    ["1", "Connect", "Public and permissioned sources feed explicit adapters.", C.cyan],
    ["2", "Prioritize", "A transparent model ranks the next review target.", C.orange],
    ["3", "Explain", "Evidence, confidence, freshness, and limits travel together.", C.yellow],
    ["4", "Decide", "The human accepts, modifies, or rejects the recommendation.", C.green],
    ["5", "Audit", "The exact decision snapshot remains available later.", C.blue],
  ];
  cols.forEach(([n, title, body, accent], i) => {
    const x = x0 + i * 2.5;
    slide.addShape(pptx.ShapeType.roundRect, { x, y: 2.05, w: 2.15, h: 3.2, rectRadius: 0.08, fill: { color: C.panel }, line: { color: C.border, width: 1 } });
    slide.addShape(pptx.ShapeType.ellipse, { x: x + 0.65, y: 2.35, w: 0.85, h: 0.85, fill: { color: accent }, line: { color: accent } });
    slide.addText(n, { x: x + 0.65, y: 2.61, w: 0.85, h: 0.2, align: "center", fontFace: "Cambria", fontSize: 18, bold: true, color: C.bg, margin: 0 });
    slide.addText(title, { x: x + 0.2, y: 3.55, w: 1.75, h: 0.3, align: "center", fontFace: "Cambria", fontSize: 17, bold: true, color: C.white, margin: 0 });
    slide.addText(body, { x: x + 0.22, y: 4.08, w: 1.71, h: 0.72, align: "center", fontFace: "Arial", fontSize: 10, color: C.muted, margin: 0, fit: "shrink" });
    if (i < cols.length - 1) slide.addShape(pptx.ShapeType.chevron, { x: x + 2.21, y: 3.35, w: 0.25, h: 0.48, fill: { color: C.border }, line: { color: C.border } });
  });
  slide.addText("Show what the system knows, what it does not, and what the human decided.", { x: 1.25, y: 5.8, w: 10.85, h: 0.58, align: "center", fontFace: "Cambria", fontSize: 22, bold: true, color: C.cyan, margin: 0, fit: "shrink" });
  slide.addText("Direct permissioned responder validation remains pending.", { x: 3.95, y: 6.57, w: 5.45, h: 0.18, align: "center", fontFace: "Arial", fontSize: 8.5, color: C.muted, margin: 0 });
  addNotes(slide, 7);
}

// 9. Closing hold
{
  const slide = newSlide();
  addTime(slide, "4:50-5:00");
  slide.addShape(pptx.ShapeType.roundRect, { x: 5.82, y: 0.91, w: 1.7, h: 1.7, rectRadius: 0.12, fill: { color: "FFFFFF" }, line: { color: C.border, width: 1.2 }, shadow: { type: "outer", color: "000000", opacity: 0.25, blur: 2, angle: 45, distance: 1 } });
  slide.addImage({ path: IMG.logo, x: 5.96, y: 1.05, w: 1.42, h: 1.42, altText: "FireAfter logo" });
  slide.addText("FIREAFTER", { x: 2.0, y: 2.83, w: 9.33, h: 0.75, align: "center", fontFace: "Cambria", fontSize: 40, bold: true, color: C.orange, margin: 0 });
  slide.addText("Post-Wildfire Storm Risk. Action First.", { x: 2.0, y: 3.72, w: 9.33, h: 0.42, align: "center", fontFace: "Arial", fontSize: 18, bold: true, color: C.white, margin: 0 });
  slide.addShape(pptx.ShapeType.line, { x: 4.48, y: 4.52, w: 4.38, h: 0, line: { color: C.cyan, width: 2 } });
  slide.addText("PUBLIC APP AND JUDGE EXPLORER", { x: 3.55, y: 4.76, w: 6.25, h: 0.18, align: "center", fontFace: "Arial", fontSize: 8.5, bold: true, color: C.muted, charSpacing: 1.1, margin: 0 });
  slide.addText("fireafter-app.vercel.app", { x: 3.55, y: 4.98, w: 6.25, h: 0.35, align: "center", fontFace: "Arial", fontSize: 16, bold: true, color: C.cyan, margin: 0, hyperlink: { url: "https://fireafter-app.vercel.app" } });
  slide.addText("Explore features: fireafter-app.vercel.app/features", { x: 3.1, y: 5.7, w: 7.15, h: 0.28, align: "center", fontFace: "Arial", fontSize: 12, color: C.muted, charSpacing: 0.6, margin: 0 });
  addNotes(slide, 8, false);
}

}

async function main() {
  const script = fs.readFileSync(DEMO_SCRIPT, "utf8");
  notes = validateDemoScript(script);
  rehearsalLabel = rehearsalFooter(script);
  await prepareAssets();
  buildSlides();
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.mkdirSync(path.dirname(LEGACY_OUTPUT), { recursive: true });
  await pptx.writeFile({ fileName: OUTPUT, compression: true });
  fs.copyFileSync(OUTPUT, LEGACY_OUTPUT);
  console.log(`Wrote ${OUTPUT}`);
  console.log(`Updated ${LEGACY_OUTPUT}`);
}

module.exports = { validateDemoScript, rehearsalFooter, REHEARSAL, TIMINGS };

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
