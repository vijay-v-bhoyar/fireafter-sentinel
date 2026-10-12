import "server-only";
import { z } from "zod";
import type { FireAfterGeoJsonExport, FireAfterGeoJsonFeature } from "./geojson-export";

export const GEOJSON_EXPORT_LIMITS = {
  rows: 100_000, pageRows: 128, pageBytes: 4 * 1024 * 1024,
  metadataBytes: 1024 * 1024, identityBytes: 16 * 1024 * 1024,
  outputBytes: 512 * 1024 * 1024, chunkBytes: 64 * 1024, durationMs: 300_000,
} as const;

export class GeoJsonStreamError extends Error {
  constructor(readonly code: "invalid" | "capacity" | "canceled" | "deadline" | "unavailable") {
    super("The complete GeoJSON export could not be verified. Discard incomplete downloads and start again.");
  }
}

type WithheldReason = "non-operational" | "unverified-geometry" | "outside-county";
export type GeoJsonExportPage = {
  revision: string; state: "current" | "expired"; start: number; totalStored: number;
  items: Array<{ position: number; status: "available"; feature: FireAfterGeoJsonFeature } |
    { position: number; status: "withheld"; reason: WithheldReason }>;
};
export type GeoJsonExportSource = {
  metadata: Omit<FireAfterGeoJsonExport, "features">;
  revision: string; state: "current" | "expired"; totalStored: number; fileName: string;
  // The reader owns authority, generation, provenance, geometry and freshness
  // checks before each page. It must honor this cancellation signal during I/O.
  pages: (signal: AbortSignal) => AsyncIterable<GeoJsonExportPage>;
  verifyComplete: (signal: AbortSignal) => Promise<void>;
};

const timestamp = z.iso.datetime();
const reasons: WithheldReason[] = ["non-operational", "unverified-geometry", "outside-county"];
const invalid = (): never => { throw new GeoJsonStreamError("invalid"); };
const capacity = (): never => { throw new GeoJsonStreamError("capacity"); };

/** Delivery only; the connected reader must enforce authorization and evidence checks. */
export async function createCompleteGeoJsonResponse(source: GeoJsonExportSource, callerSignal?: AbortSignal): Promise<Response> {
  const limits = GEOJSON_EXPORT_LIMITS;
  if (!z.uuid().safeParse(source.revision).success || !["current", "expired"].includes(source.state) ||
    !Number.isSafeInteger(source.totalStored) || source.totalStored < 0 || source.totalStored > limits.rows ||
    !/^fireafter-[a-z0-9-]+-action-queue\.geojson$/.test(source.fileName) || source.fileName.length > 256 ||
    source.metadata.type !== "FeatureCollection" || !timestamp.safeParse(source.metadata.generatedAt).success ||
    typeof source.metadata.name !== "string" || !source.metadata.fireafter?.incidentId || source.metadata.fireafter.decisionSupport !== true ||
    typeof source.verifyComplete !== "function") invalid();
  const metadata = JSON.stringify({ type: source.metadata.type, name: source.metadata.name,
    generatedAt: source.metadata.generatedAt, fireafter: source.metadata.fireafter });
  if (Buffer.byteLength(metadata) > limits.metadataBytes) capacity();

  const controller = new AbortController();
  const deadline = performance.now() + limits.durationMs;
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(limits.durationMs), ...(callerSignal ? [callerSignal] : [])]);
  const check = () => {
    if (callerSignal?.aborted || controller.signal.aborted) throw new GeoJsonStreamError("canceled");
    if (signal.aborted || performance.now() >= deadline) throw new GeoJsonStreamError("deadline");
  };
  check();
  let iterator: AsyncIterator<GeoJsonExportPage>;
  try { iterator = source.pages(signal)[Symbol.asyncIterator](); }
  catch { controller.abort(); throw new GeoJsonStreamError("unavailable"); }
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true; controller.abort();
    // Do not let a broken iterator that ignores cancellation hang the client.
    try { void Promise.resolve(iterator.return?.()).catch(() => {}); } catch { /* Cleanup must not replace the safe error. */ }
  };
  const bounded = async <T>(operation: () => Promise<T>): Promise<T> => {
    check();
    let abort: (() => void) | undefined;
    try {
      const value = await Promise.race([operation(), new Promise<never>((_, reject) => {
        abort = () => { try { check(); } catch (error) { reject(error); } };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      })]);
      check(); return value;
    } finally { if (abort) signal.removeEventListener("abort", abort); }
  };

  let scanned = 0, exported = 0, identityBytes = 0, outputBytes = 0;
  const seen = new Set<string>();
  const withheld: Record<WithheldReason, number> = { "non-operational": 0, "unverified-geometry": 0, "outside-county": 0 };
  const encodePage = (page: GeoJsonExportPage) => {
    if (!page || page.revision !== source.revision || page.state !== source.state || page.totalStored !== source.totalStored ||
      page.start !== scanned || !Array.isArray(page.items) || page.items.length === 0 || page.items.length > limits.pageRows ||
      scanned + page.items.length > source.totalStored) invalid();
    const lines: string[] = []; let pageBytes = 0;
    for (const item of page.items) {
      if (!item || item.position !== scanned + 1) invalid();
      scanned++;
      if (item.status === "withheld") {
        if (!reasons.includes(item.reason)) invalid();
        withheld[item.reason]++; continue;
      }
      if (item.status !== "available") invalid();
      const feature = item.feature, coordinates = feature?.geometry?.coordinates, properties = feature?.properties;
      if (feature?.type !== "Feature" || feature.geometry.type !== "Point" || !Array.isArray(coordinates) || coordinates.length !== 2 ||
        !coordinates.every(Number.isFinite) || Math.abs(coordinates[0]) > 180 || Math.abs(coordinates[1]) > 90 ||
        !properties || typeof properties.id !== "string" || !properties.id || seen.has(properties.id) ||
        properties.incidentId !== source.metadata.fireafter.incidentId ||
        !Number.isFinite(properties.score100) || properties.score100 < 0 || properties.score100 > 100 ||
        !["Unknown", "Very High", "High", "Medium", "Low", "Very Low"].includes(properties.riskLevel) ||
        (source.state === "expired" && properties.riskLevel !== "Unknown")) invalid();
      identityBytes += Buffer.byteLength(properties.id);
      if (identityBytes > limits.identityBytes) capacity();
      seen.add(properties.id);
      const line = `${exported ? "," : ""}${JSON.stringify(feature)}\n`;
      pageBytes += Buffer.byteLength(line);
      if (pageBytes > limits.pageBytes) capacity();
      lines.push(line); exported++;
    }
    return lines.join("");
  };
  const safe = (error: unknown) => error instanceof GeoJsonStreamError ? error : new GeoJsonStreamError("unavailable");

  // Read/validate the first page before issuing download headers. Later failures
  // error the stream; a complete closing object is never written on failure.
  let firstDone: boolean, firstPage: string;
  try {
    const first = await bounded(() => iterator.next());
    if (first.done && source.totalStored !== 0) invalid();
    firstDone = Boolean(first.done);
    firstPage = first.done ? "" : encodePage(first.value);
  } catch (error) { stop(); throw safe(error); }

  async function* bytes() {
    const parts = async function* () {
      yield `${metadata.slice(0, -1)},"features":[\n`;
      yield firstPage;
      firstPage = "";
      if (!firstDone) {
        for (;;) {
          const next = await bounded(() => iterator.next());
          if (next.done) break;
          yield encodePage(next.value);
        }
      }
      if (scanned !== source.totalStored) invalid();
      await bounded(() => source.verifyComplete(signal));
      yield `],"fireafterExport":${JSON.stringify({ version: 1, revision: source.revision, state: source.state,
        totalStored: source.totalStored, scanned, exported, withheld, complete: true, completedAt: new Date().toISOString() })}}`;
    };
    for await (const part of parts()) {
      check();
      const encoded = new TextEncoder().encode(part);
      outputBytes += encoded.byteLength;
      if (outputBytes > limits.outputBytes) capacity();
      for (let offset = 0; offset < encoded.byteLength; offset += limits.chunkBytes) {
        check(); yield encoded.subarray(offset, offset + limits.chunkBytes);
      }
    }
  }
  const chunks = bytes();
  const body = new ReadableStream<Uint8Array>({
    async pull(destination) {
      try {
        const next = await chunks.next();
        if (next.done) { stop(); destination.close(); }
        else destination.enqueue(next.value);
      } catch (error) { stop(); destination.error(safe(error)); }
    },
    cancel() { stop(); void chunks.return(undefined).catch(() => {}); },
  }, { highWaterMark: 0 });
  return new Response(body, { headers: { "content-type": "application/geo+json; charset=utf-8",
    "content-disposition": `attachment; filename="${source.fileName}"`, "cache-control": "private, no-store", vary: "Cookie" } });
}
