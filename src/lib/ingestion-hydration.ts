import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { COMPACT_REFRESH_TRANSPORT, COMPACT_REFRESH_EXPANDED_LIMIT } from "./compact-refresh-page";
import { finishSupabaseRefreshRead, type RefreshReadBudget, type RefreshReadCursor, type RefreshReadHeader, type RefreshReadKind, type RefreshReadPart } from "./fireafter-supabase";

export const HYDRATION_HEADER = "hydrate:header";
export const HYDRATION_STATE = "hydrate:state";
const MIB = 1024 * 1024;
const MAX_COMPACT_BYTES = 64 * MIB;
const MAX_TRANSFER_BYTES = 512 * MIB;
const MAX_GROUP_BYTES = 8 * MIB;
const kinds = ["source", "asset", "recommendation"] as const;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const uuidSchema = z.uuid();
const descriptorSchema = z.object({ hash: hashSchema, bytes: z.number().int().min(1).max(MAX_GROUP_BYTES * 2) }).strict();
const cursorSchema = z.object({ after: z.uuid().optional(), count: z.number().int().min(0).max(100_000),
  total: z.number().int().min(0).max(100_000).optional() }).strict();
const stateSchema = z.object({
  version: z.literal(1), scope: hashSchema, headerHash: hashSchema,
  phase: z.enum(["read", "merge", "index", "ready"]), kind: z.number().int().min(0).max(3),
  mergeFor: z.enum(["index", "ready"]), assetsIndex: descriptorSchema.optional(),
  cursors: z.object({ source: cursorSchema, asset: cursorSchema, recommendation: cursorSchema }).strict(),
  budget: z.object({ vertices: z.number().int().nonnegative(), comparisons: z.number().int().nonnegative(),
    remaining: z.number().int().min(0).max(64 * MIB) }).strict(),
  rawBytes: z.number().int().min(0).max(MAX_TRANSFER_BYTES),
  expandedBytes: z.number().int().min(0).max(COMPACT_REFRESH_EXPANDED_LIMIT).optional(),
  compactBytes: z.number().int().min(0).max(MAX_COMPACT_BYTES),
  pages: z.array(descriptorSchema).max(4096), merged: z.array(descriptorSchema).max(4096),
  next: z.number().int().min(0).max(4096),
}).strict();
type State = z.infer<typeof stateSchema>;
type Descriptor = z.infer<typeof descriptorSchema>;
type Group = { version: 1; headerHash: string; parts: RefreshReadPart[] };
export type HydrationStore = { read(key: string): Promise<unknown | null>; write(key: string, value: unknown): Promise<void> };
type Input = {
  scope: string;
  open(): Promise<RefreshReadHeader | null>;
  verify(header: RefreshReadHeader): Promise<void>;
  page(header: RefreshReadHeader, kind: RefreshReadKind, cursor: RefreshReadCursor, budget: RefreshReadBudget, validAssets?: ReadonlySet<string>):
    Promise<{ part: RefreshReadPart; next: RefreshReadCursor; bytes: number; expandedBytes?: number }>;
};
export class HydrationCheckpointError extends Error {
  constructor(readonly reason: "invalid" | "capacity") { super(`hydration_checkpoint_${reason}`); this.name = "HydrationCheckpointError"; }
}
function invalid(): never { throw new HydrationCheckpointError("invalid"); }
function capacity(): never { throw new HydrationCheckpointError("capacity"); }
function key(page: Descriptor) { return `hp:${page.hash}`; }
function describe(value: Group): Descriptor {
  const bytes = Buffer.byteLength(JSON.stringify(value));
  if (bytes > MAX_GROUP_BYTES * 2) capacity();
  return { hash: hash(value), bytes };
}
function validateGroup(raw: unknown, page: Descriptor, headerHash: string): Group {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid();
  const group = raw as Group;
  if (group.version !== 1 || group.headerHash !== headerHash || !Array.isArray(group.parts) || !group.parts.length ||
    group.parts.some(part => !part || !kinds.includes(part.kind) || !Array.isArray(part.currentIds) || !Array.isArray(part.identities) ||
      !Array.isArray(part.validAssetIds) || !Array.isArray(part.uploads) || !Array.isArray(part.terrain) || !Array.isArray(part.recommendations) || !Array.isArray(part.sources) || !Array.isArray(part.inventorySources))) invalid();
  const actual = describe(group);
  if (actual.hash !== page.hash || actual.bytes !== page.bytes) invalid();
  return group;
}
async function saveGroup(store: HydrationStore, group: Group) {
  const descriptor = describe(group);
  const saved = await store.read(key(descriptor));
  if (saved !== null) validateGroup(saved, descriptor, group.headerHash);
  else await store.write(key(descriptor), group);
  return descriptor;
}
function validateState(raw: unknown, scope: string, headerHash: string): State {
  const parsed = stateSchema.safeParse(raw);
  if (!parsed.success) invalid();
  const state = parsed.data;
  if (state.scope !== scope || state.headerHash !== headerHash || state.next > state.pages.length ||
    new Set(state.pages.map(page => page.hash)).size !== state.pages.length ||
    state.pages.reduce((sum, page) => sum + page.bytes, 0) > MAX_COMPACT_BYTES) invalid();
  for (let index = 0; index < kinds.length; index++) {
    const cursor = state.cursors[kinds[index]];
    if ((cursor.count > 0) !== Boolean(cursor.after) || (cursor.total !== undefined && cursor.count > cursor.total) ||
      (index < state.kind && cursor.count !== cursor.total) || (index > state.kind && (cursor.count !== 0 || cursor.total !== undefined))) invalid();
  }
  if ((state.phase === "read" && (state.kind === 3 || state.next !== 0 || state.merged.length > 0 || (state.kind === 2 && !state.assetsIndex))) ||
    (state.phase === "merge" && state.kind !== (state.mergeFor === "index" ? 2 : 3)) ||
    (state.phase === "index" && (state.kind !== 2 || state.pages.length > 16 || state.next !== 0 || state.merged.length || state.assetsIndex)) ||
    (state.phase === "ready" && state.kind !== 3) ||
    (state.phase === "ready" && (state.pages.length > 16 || state.next !== 0 || state.merged.length))) invalid();
  return state;
}

export async function hydratePreviousIncident(store: HydrationStore, input: Input) {
  if (!hashSchema.safeParse(input.scope).success) invalid();
  const savedHeader = await store.read(HYDRATION_HEADER) as { version: number; scope: string; header: RefreshReadHeader } | null;
  let header: RefreshReadHeader;
  if (savedHeader !== null) {
    if (savedHeader.version !== 1 || savedHeader.scope !== input.scope || !savedHeader.header) invalid();
    header = savedHeader.header;
  } else {
    const existing = await input.open();
    if (!existing) return { status: "missing" as const };
    header = existing;
    await store.write(HYDRATION_HEADER, { version: 1, scope: input.scope, header });
  }
  await input.verify(header);
  const headerHash = hash(header);
  const compact = header.rowTransport === COMPACT_REFRESH_TRANSPORT;
  const raw = await store.read(HYDRATION_STATE);
  let state: State = raw === null ? {
    version: 1, scope: input.scope, headerHash, phase: "read", kind: 0, mergeFor: "index",
    cursors: { source: { count: 0 }, asset: { count: 0 }, recommendation: { count: 0 } },
    budget: { vertices: 0, comparisons: 0, remaining: 64 * MIB }, rawBytes: 0, compactBytes: 0, pages: [], merged: [], next: 0,
    ...(compact ? { expandedBytes: 0 } : {}),
  } : validateState(raw, input.scope, headerHash);
  if (compact !== (state.expandedBytes !== undefined)) invalid();
  if (raw === null) await store.write(HYDRATION_STATE, state);
  if (state.phase === "read") {
    let validAssets: Set<string> | undefined;
    if (state.kind === 2) {
      if (!state.assetsIndex) invalid();
      const index = await store.read(`hi:${state.assetsIndex.hash}`) as { version: number; headerHash: string; ids: string[] } | null;
      if (!index || index.version !== 1 || index.headerHash !== headerHash || !Array.isArray(index.ids) || index.ids.length > 100_000 ||
        index.ids.some(id => !uuidSchema.safeParse(id).success) || hash(index) !== state.assetsIndex.hash ||
        Buffer.byteLength(JSON.stringify(index)) !== state.assetsIndex.bytes) invalid();
      validAssets = new Set(index.ids);
      if (validAssets.size !== index.ids.length) invalid();
    }
    let stepBytes = 0;
    for (let page = 0; page < 4 && state.phase === "read" && stepBytes < 8 * MIB; page++) {
      const kind = kinds[state.kind];
      const budget = { ...state.budget };
      const result = await input.page(header, kind, state.cursors[kind], budget, validAssets);
      if (compact && result.expandedBytes === undefined) invalid();
      const expanded = result.expandedBytes ?? result.bytes;
      if (!Number.isSafeInteger(result.bytes) || result.bytes < 0 || result.part.kind !== kind ||
        !Number.isSafeInteger(expanded) || expanded < 0 ||
        result.next.count !== state.cursors[kind].count + result.part.count || result.next.total === undefined ||
        result.next.count > result.next.total || (result.part.count > 0 && result.next.after !== result.part.last)) invalid();
      const group: Group = { version: 1, headerHash, parts: [result.part] };
      const descriptor = describe(group);
      if (state.rawBytes + result.bytes > MAX_TRANSFER_BYTES || state.compactBytes + descriptor.bytes > MAX_COMPACT_BYTES || state.pages.length >= 4096) capacity();
      if (compact && state.expandedBytes! + expanded > COMPACT_REFRESH_EXPANDED_LIMIT) capacity();
      await saveGroup(store, group);
      state = { ...state, budget, rawBytes: state.rawBytes + result.bytes, compactBytes: state.compactBytes + descriptor.bytes,
        ...(compact ? { expandedBytes: state.expandedBytes! + expanded } : {}),
        cursors: { ...state.cursors, [kind]: result.next }, pages: [...state.pages, descriptor],
        kind: state.kind + Number(result.next.count === result.next.total) };
      if (state.kind === 2 && !state.assetsIndex) {
        state.phase = state.pages.length <= 16 ? "index" : "merge"; state.mergeFor = "index";
      } else if (state.kind === 3) {
        state.phase = state.pages.length <= 16 ? "ready" : "merge"; state.mergeFor = "ready";
      }
      await store.write(HYDRATION_STATE, state);
      stepBytes += expanded;
    }
  } else if (state.phase === "merge") {
    // Compact checkpoint groups, not evidence. Bounded fan-in keeps final reads
    // below the operation request limit without reacquiring previous pages.
    const parts: RefreshReadPart[] = [];
    let bytes = 0;
    let next = state.next;
    while (next < state.pages.length && next - state.next < 8) {
      const page = state.pages[next];
      if (parts.length && bytes + page.bytes > MAX_GROUP_BYTES) break;
      const group = validateGroup(await store.read(key(page)), page, headerHash);
      parts.push(...group.parts); bytes += page.bytes; next++;
    }
    const descriptor = await saveGroup(store, { version: 1, headerHash, parts });
    state = { ...state, next, merged: [...state.merged, descriptor] };
    if (next === state.pages.length) {
      if (state.merged.length >= state.pages.length && state.merged.length > 16) capacity();
      state = { ...state, pages: state.merged, merged: [], next: 0, phase: state.merged.length <= 16 ? state.mergeFor : "merge" };
    }
    await store.write(HYDRATION_STATE, state);
  } else if (state.phase === "index") {
    const ids: string[] = [];
    for (const page of state.pages) {
      const group = validateGroup(await store.read(key(page)), page, headerHash);
      for (const part of group.parts) if (part.kind === "asset") ids.push(...part.validAssetIds.map(id => id.toLowerCase()));
    }
    if (ids.length > 100_000 || new Set(ids).size !== ids.length || ids.some(id => !uuidSchema.safeParse(id).success)) invalid();
    const index = { version: 1, headerHash, ids }, bytes = Buffer.byteLength(JSON.stringify(index));
    if (bytes > 4 * MIB) capacity();
    const descriptor = { hash: hash(index), bytes };
    const saved = await store.read(`hi:${descriptor.hash}`);
    if (saved !== null && hash(saved) !== descriptor.hash) invalid();
    if (saved === null) await store.write(`hi:${descriptor.hash}`, index);
    state = { ...state, phase: "read", assetsIndex: descriptor };
    await store.write(HYDRATION_STATE, state);
  } else {
    const parts: RefreshReadPart[] = [];
    for (const page of state.pages) parts.push(...validateGroup(await store.read(key(page)), page, headerHash).parts);
    const result = finishSupabaseRefreshRead(header, parts, {
      source: state.cursors.source.total!, asset: state.cursors.asset.total!, recommendation: state.cursors.recommendation.total!,
    });
    if (Buffer.byteLength(JSON.stringify(result)) > 60 * MIB) capacity();
    await input.verify(header);
    return { status: "ready" as const, value: result };
  }
  await input.verify(header);
  return { status: "pending" as const, kind: kinds[Math.min(state.kind, 2)],
    saved: state.cursors[kinds[Math.min(state.kind, 2)]].count, total: state.cursors[kinds[Math.min(state.kind, 2)]].total ?? 0 };
}
