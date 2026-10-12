import { createHash } from "node:crypto";
import { createResponseBudget } from "./bounded-response";
import { fetchOperationResponse, hasRefreshOperation } from "./refresh-operation";
import { ARCGIS_INVENTORY_VERSION } from "./arcgis-inventory-contract";
import { countyQueryGeometry } from "./county-scope";

export { ARCGIS_INVENTORY_VERSION } from "./arcgis-inventory-contract";
const BATCH_SIZE = 200;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_ACQUISITION_AGE_MS = 30 * 60 * 1000;

export type ArcgisCheckpointStore = {
  read(key: string): Promise<unknown>;
  write(key: string, value: unknown): Promise<void>;
};
export class ArcgisInventoryPending extends Error {
  constructor(readonly saved: number, readonly total: number) {
    super("Inventory batches saved; complete-set verification is still required.");
    this.name = "ArcgisInventoryPending";
  }
}
export class ArcgisCheckpointError extends Error {
  constructor() { super("Inventory checkpoint outcome is unconfirmed; resume the same operation."); this.name = "ArcgisCheckpointError"; }
}
type InventoryIds = { field: string; values: number[] };
type InventoryCheckpoint = {
  version: 1; scope: string; startedAt: string; bytes: number; requests: number;
  ids?: InventoryIds; cursor: number; completedAt?: string;
};

type Failure = "invalid_config" | "invalid_response" | "limit_exceeded" |
  "incomplete" | "changed_inventory" | "timeout" | "provider_error" | "invalid_geometry";
const messages: Record<Failure, string> = {
  invalid_config: "Check FIREAFTER_ARCGIS_MAX_FEATURES, FIREAFTER_ARCGIS_MAX_BYTES and FIREAFTER_ARCGIS_TIMEOUT_MS against the documented limits.",
  invalid_response: "The provider inventory contract is invalid. Verify its object-ID field and response schema before retrying.",
  limit_exceeded: "The inventory exceeds the configured feature/byte budget. Use a smaller approved study area or a capacity-reviewed background ingestion job; no partial inventory was accepted.",
  incomplete: "The provider returned a truncated or incomplete inventory. Retry or check provider transfer limits; no partial inventory was accepted.",
  changed_inventory: "The provider's matching object IDs changed during acquisition. Retry the inventory before relying on its coverage.",
  timeout: "The inventory exceeded its full-body acquisition deadline. Retry or use a capacity-reviewed background ingestion job.",
  provider_error: "The provider could not supply the inventory. Check provider availability and retry; no replacement data was used.",
  invalid_geometry: "An inventory record has invalid geometry. Verify the provider geometry contract; no partial inventory was accepted.",
};

export class ArcgisInventoryError extends Error {
  constructor(public readonly code: Failure) {
    super(`ArcGIS query failed: ${messages[code]}`);
    this.name = "ArcgisInventoryError";
  }
}

export type ArcgisInventory = {
  version: typeof ARCGIS_INVENTORY_VERSION;
  complete: true;
  scope: "bbox-matching-object-id-set" | "polygon-intersecting-object-id-set";
  geometryHash?: string;
  sourceUrl: string;
  bbox: [number, number, number, number];
  objectIdFieldName: string;
  expectedCount: number;
  receivedCount: number;
  requests: number;
  bytes: number;
  startedAt: string;
  completedAt: string;
};

type Feature = { attributes: Record<string, unknown>; geometry?: unknown };
type Limits = { maxFeatures: number; maxBytes: number; timeoutMs: number };

function limit(value: unknown, fallback: number, maximum: number) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new ArcgisInventoryError("invalid_config");
  }
  return parsed;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ArcgisInventoryError("invalid_response");
  return value as Record<string, unknown>;
}

// Enumerate IDs twice: prove completeness of the set, not an atomic attribute snapshot.
export async function fetchArcgisInventory(
  layerUrl: string,
  bbox: [number, number, number, number],
  options: { outFields: string; fetchImpl?: typeof fetch; limits?: Partial<Limits>; checkpoint?: ArcgisCheckpointStore; boundary?: unknown },
): Promise<{ features: Feature[]; inventory: ArcgisInventory }> {
  const limits: Limits = {
    maxFeatures: limit(options.limits?.maxFeatures ?? process.env.FIREAFTER_ARCGIS_MAX_FEATURES, 20_000, 100_000),
    maxBytes: limit(options.limits?.maxBytes ?? process.env.FIREAFTER_ARCGIS_MAX_BYTES, 32 * 1024 * 1024, 64 * 1024 * 1024),
    timeoutMs: limit(options.limits?.timeoutMs ?? process.env.FIREAFTER_ARCGIS_TIMEOUT_MS, 45_000, 120_000),
  };
  const base = new URL(layerUrl);
  if (base.protocol !== "https:" || base.username || base.password ||
    !bbox.every(Number.isFinite) || bbox[0] < -180 || bbox[2] > 180 ||
    bbox[1] < -90 || bbox[3] > 90 || bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) {
    throw new ArcgisInventoryError("invalid_config");
  }
  base.search = new URLSearchParams({ f: "json", where: "1=1", geometry: bbox.join(","),
    geometryType: "esriGeometryEnvelope", inSR: "4326", outSR: "4326",
    spatialRel: "esriSpatialRelIntersects" }).toString();
  let geometryHash: string | undefined;
  if (options.boundary !== undefined) {
    let geometry: string;
    try { geometry = JSON.stringify(countyQueryGeometry(options.boundary, bbox)); }
    catch { throw new ArcgisInventoryError("invalid_geometry"); }
    base.searchParams.set("geometry", geometry);
    base.searchParams.set("geometryType", "esriGeometryPolygon");
    if (Buffer.byteLength(base.searchParams.toString()) > 4 * 1024 * 1024) throw new ArcgisInventoryError("limit_exceeded");
    geometryHash = createHash("sha256").update(geometry).digest("hex");
  }
  const scope = createHash("sha256").update(JSON.stringify([base.href, options.outFields])).digest("hex");
  const prefix = `arcgis:${scope.slice(0, 32)}`;
  const checkpoint = options.checkpoint;
  const read = async (key: string) => {
    try { return await checkpoint!.read(`${prefix}:${key}`); }
    catch { throw new ArcgisCheckpointError(); }
  };
  const write = async (key: string, value: unknown) => {
    try { await checkpoint!.write(`${prefix}:${key}`, structuredClone(value)); }
    catch { throw new ArcgisCheckpointError(); }
  };
  const stored = checkpoint ? await read("state") : null;
  const state: InventoryCheckpoint = stored === null || stored === undefined
    ? { version: 1, scope, startedAt: new Date().toISOString(), bytes: 0, requests: 0, cursor: 0 }
    : validateCheckpoint(stored, scope, limits);
  const startedAt = state.startedAt;
  const signal = AbortSignal.timeout(limits.timeoutMs);
  const fetchImpl = options.fetchImpl ?? fetch;
  let bytes = state.bytes;
  let requests = state.requests;
  const save = async () => { state.bytes = bytes; state.requests = requests; await write("state", state); };

  async function query(params: Record<string, string>) {
    signal.throwIfAborted();
    if (requests >= 4096) throw new ArcgisInventoryError("limit_exceeded");
    const url = new URL(base);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const init: RequestInit = { signal, cache: "no-store" };
    if (geometryHash) {
      if (params.objectIds !== undefined) {
        // IDs already bind this batch to the spatial query. Do not retransmit
        // a large county polygon on every batch; final enumeration rechecks it.
        for (const key of ["geometry", "geometryType", "inSR", "spatialRel"]) url.searchParams.delete(key);
      } else {
        init.method = "POST";
        init.headers = { "content-type": "application/x-www-form-urlencoded" };
        init.body = url.searchParams.toString();
        url.search = "";
      }
    }
    requests++;
    // Reserve before dispatch. An interrupted or unacknowledged request cannot
    // reset the aggregate transfer budget when another worker resumes it.
    const reservation = checkpoint ? Math.min(MAX_RESPONSE_BYTES, limits.maxBytes - bytes) : 0;
    if (checkpoint) {
      if (reservation <= 0) throw new ArcgisInventoryError("limit_exceeded");
      bytes += reservation;
      await save();
    }
    const response = hasRefreshOperation()
      ? await fetchOperationResponse(url, init, createResponseBudget(checkpoint ? reservation : MAX_RESPONSE_BYTES, limits.timeoutMs), fetchImpl)
      : await fetchImpl(url, init);
    if (!response.ok || !response.body) {
      void response.body?.cancel().catch(() => undefined);
      throw new ArcgisInventoryError("provider_error");
    }
    const reader = response.body.getReader();
    const cancel = () => { void reader.cancel().catch(() => undefined); };
    signal.addEventListener("abort", cancel, { once: true });
    let responseBytes = 0;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let text = "";
    try {
      signal.throwIfAborted();
      while (true) {
        const chunk = await reader.read();
        signal.throwIfAborted();
        if (chunk.done) break;
        responseBytes += chunk.value.byteLength;
        if (!checkpoint) bytes += chunk.value.byteLength;
        if (responseBytes > MAX_RESPONSE_BYTES || (checkpoint ? responseBytes > reservation : bytes > limits.maxBytes)) {
          throw new ArcgisInventoryError("limit_exceeded");
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      signal.removeEventListener("abort", cancel);
      void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    let payload: Record<string, unknown>;
    try { payload = record(JSON.parse(text)); }
    catch { throw new ArcgisInventoryError("invalid_response"); }
    signal.throwIfAborted();
    if (payload.error) throw new ArcgisInventoryError("provider_error");
    if (payload.exceededTransferLimit === true) throw new ArcgisInventoryError("incomplete");
    if (checkpoint) { bytes -= reservation - responseBytes; await save(); }
    return payload;
  }

  async function ids() {
    const payload = await query({ returnIdsOnly: "true", returnGeometry: "false" });
    if (typeof payload.objectIdFieldName !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(payload.objectIdFieldName)) {
      throw new ArcgisInventoryError("invalid_response");
    }
    // Some MapServer layers represent zero matches as null, not an empty array.
    // Confirm that interpretation independently rather than treating missing IDs as zero.
    if (payload.objectIds === null) {
      const count = await query({ returnCountOnly: "true", returnGeometry: "false" });
      if (!Number.isSafeInteger(count.count) || typeof count.count !== "number" || count.count < 0) {
        throw new ArcgisInventoryError("invalid_response");
      }
      if (count.count !== 0) throw new ArcgisInventoryError("incomplete");
      return { field: payload.objectIdFieldName, values: [] as number[] };
    }
    if (!Array.isArray(payload.objectIds) || !payload.objectIds.every((id) => Number.isSafeInteger(id))) {
      throw new ArcgisInventoryError("invalid_response");
    }
    const values = payload.objectIds as number[];
    if (values.length > limits.maxFeatures) throw new ArcgisInventoryError("limit_exceeded");
    if (new Set(values).size !== values.length) throw new ArcgisInventoryError("invalid_response");
    return { field: payload.objectIdFieldName, values: values.sort((a, b) => a - b) };
  }

  try {
    const initial = state.ids ?? await ids();
    if (checkpoint && !state.ids) {
      state.ids = initial;
      await save();
      throw new ArcgisInventoryPending(0, initial.values.length);
    }
    const features: Feature[] = [];
    // TNM omits OBJECTID when it is requested twice with different casing.
    const fields = new Map([...options.outFields.split(","), initial.field]
      .map((field) => [field.trim().toLowerCase(), field.trim()]));
    const outFields = [...fields.values()].join(",");
    const first = checkpoint ? state.cursor : 0;
    const end = checkpoint ? Math.min(initial.values.length, first + BATCH_SIZE * 4) : initial.values.length;
    for (let offset = first; offset < end; offset += BATCH_SIZE) {
      const batch = initial.values.slice(offset, offset + BATCH_SIZE);
      const payload = await query({ objectIds: batch.join(","), outFields,
        returnGeometry: "true", returnIdsOnly: "false" });
      if (!Array.isArray(payload.features)) throw new ArcgisInventoryError("invalid_response");
      const requested = new Set(batch);
      const received = new Map<number, Feature>();
      for (const raw of payload.features) {
        const feature = record(raw);
        const attributes = record(feature.attributes);
        const id = attributes[initial.field];
        if (typeof id !== "number" || !requested.has(id) || received.has(id)) throw new ArcgisInventoryError("incomplete");
        received.set(id, { attributes, geometry: feature.geometry });
      }
      if (received.size !== requested.size) throw new ArcgisInventoryError("incomplete");
      const ordered = batch.map((id) => received.get(id)!);
      if (checkpoint) {
        await write(`batch:${offset}`, ordered);
        state.cursor = Math.min(initial.values.length, offset + BATCH_SIZE);
        await save();
      } else features.push(...ordered);
    }
    if (checkpoint && state.cursor !== first) throw new ArcgisInventoryPending(state.cursor, initial.values.length);
    if (!state.completedAt) {
      const final = await ids();
      if (final.field !== initial.field || final.values.length !== initial.values.length ||
        final.values.some((id, index) => id !== initial.values[index])) throw new ArcgisInventoryError("changed_inventory");
      state.completedAt = new Date().toISOString();
      if (checkpoint) { await save(); throw new ArcgisInventoryPending(state.cursor, initial.values.length); }
    }
    if (checkpoint) {
      let assembledBytes = 0;
      for (let offset = 0; offset < initial.values.length; offset += BATCH_SIZE) {
        signal.throwIfAborted();
        const page = await read(`batch:${offset}`);
        const expected = initial.values.slice(offset, offset + BATCH_SIZE);
        if (!Array.isArray(page) || page.length !== expected.length) throw new ArcgisInventoryError("incomplete");
        assembledBytes += Buffer.byteLength(JSON.stringify(page));
        if (assembledBytes > limits.maxBytes || assembledBytes > bytes) throw new ArcgisInventoryError("limit_exceeded");
        for (const [index, raw] of page.entries()) {
          const value = record(raw);
          const attributes = record(value.attributes);
          if (attributes[initial.field] !== expected[index]) throw new ArcgisInventoryError("incomplete");
          features.push({ attributes, geometry: value.geometry });
        }
      }
      signal.throwIfAborted();
    }
    return { features, inventory: { version: ARCGIS_INVENTORY_VERSION, complete: true,
      scope: geometryHash ? "polygon-intersecting-object-id-set" : "bbox-matching-object-id-set",
      ...(geometryHash ? { geometryHash } : {}), sourceUrl: base.origin + base.pathname,
      bbox: [...bbox], objectIdFieldName: initial.field,
      expectedCount: initial.values.length, receivedCount: features.length,
      requests, bytes, startedAt, completedAt: state.completedAt } };
  } catch (error) {
    if (error instanceof ArcgisInventoryPending || error instanceof ArcgisCheckpointError) throw error;
    if (signal.aborted) throw new ArcgisInventoryError("timeout");
    if (error instanceof ArcgisInventoryError) throw error;
    throw new ArcgisInventoryError("provider_error");
  }
}
function validateCheckpoint(value: unknown, scope: string, limits: Limits): InventoryCheckpoint {
  const state = record(value) as unknown as InventoryCheckpoint;
  const started = Date.parse(state.startedAt);
  if (state.version !== 1 || state.scope !== scope || typeof state.startedAt !== "string" || !Number.isFinite(started) || started > Date.now() ||
    Date.now() - started > MAX_ACQUISITION_AGE_MS || !Number.isSafeInteger(state.bytes) || state.bytes < 0 ||
    state.bytes > limits.maxBytes || !Number.isSafeInteger(state.requests) || state.requests < 0 || state.requests > 4096 ||
    !Number.isSafeInteger(state.cursor) || state.cursor < 0) throw new ArcgisInventoryError("invalid_response");
  const ids = state.ids === undefined ? undefined : record(state.ids) as InventoryIds;
  if (ids && (typeof ids.field !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(ids.field) ||
    !Array.isArray(ids.values) || ids.values.length > limits.maxFeatures ||
    ids.values.some((id, index) => !Number.isSafeInteger(id) || (index > 0 && id <= ids.values[index - 1])))) {
    throw new ArcgisInventoryError("invalid_response");
  }
  if (state.cursor > (ids?.values.length ?? 0) || (state.cursor % BATCH_SIZE !== 0 && state.cursor !== ids?.values.length) ||
    (state.completedAt !== undefined && (typeof state.completedAt !== "string" || !ids || state.cursor !== ids.values.length ||
      !Number.isFinite(Date.parse(state.completedAt)) || Date.parse(state.completedAt) < started || Date.parse(state.completedAt) > Date.now()))) {
    throw new ArcgisInventoryError("invalid_response");
  }
  return structuredClone(state);
}
