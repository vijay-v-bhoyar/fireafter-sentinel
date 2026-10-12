import "server-only";
import { z } from "zod";
import { InventoryCapacityError } from "./inventory-error";
import { getSupabaseAdminClient } from "./supabase";
import type { Recommendation, ResponderActionType, RiskLevel } from "./types";

export type RecentResponderActionRow = {
  id: string;
  recommendation_id: string;
  action: ResponderActionType;
  note: string;
  actor_id?: string | null;
  actor_name: string;
  modified_priority?: RiskLevel | null;
  recommendation_snapshot: Recommendation & { domainActionId?: string };
  created_at: string;
};

const actionTimeSchema = z.iso.datetime({ offset: true })
  .regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/);
const rowSchema = z.object({
  id: z.uuid(), recommendation_id: z.uuid(), created_at: actionTimeSchema,
  action: z.enum(["accept", "modify", "reject", "annotate"]), note: z.string(),
  actor_id: z.uuid().nullable().optional(), actor_name: z.string(),
  modified_priority: z.string().nullable().optional(),
  recommendation_snapshot: z.record(z.string(), z.unknown()),
  recommendations: z.object({ incident_id: z.uuid() }),
}).passthrough();

type Position = { id: string; created_at: string };
function actionTime(value: string) {
  // PostgreSQL may serialize a non-UTC session offset. Keep its original cursor
  // text and compare instants without losing the fractional microseconds.
  const fraction = value.match(/\.(\d+)/)?.[1] ?? "";
  return BigInt(Math.floor(Date.parse(value) / 1000)) * BigInt(1_000_000) + BigInt(fraction.padEnd(6, "0"));
}
function after(left: Position, right: Position) {
  const delta = actionTime(left.created_at) - actionTime(right.created_at);
  // Preserve the existing recent-window tie break: newest timestamp, ID ascending.
  return delta < BigInt(0) || (delta === BigInt(0) && left.id > right.id);
}

export async function readRecentIncidentActions(incidentId: string, parentSignal?: AbortSignal): Promise<RecentResponderActionRow[]> {
  if (!z.uuid().safeParse(incidentId).success) throw new InventoryCapacityError("read_invalid");
  const client = getSupabaseAdminClient();
  if (!client) return [];
  const timeout = AbortSignal.timeout(10_000), deadline = performance.now() + 10_000;
  const signal = parentSignal ? AbortSignal.any([timeout, parentSignal]) : timeout;
  const checkDeadline = () => {
    if (signal.aborted || performance.now() > deadline) throw new InventoryCapacityError("read_budget");
  };
  const rows: RecentResponderActionRow[] = [], seen = new Set<string>();
  let expected: number | undefined, position: Position | undefined, bytes = 0;
  do {
    checkDeadline();
    const limit = 200 - rows.length;
    let query = client.from("responder_actions")
      .select("*,recommendations!inner(incident_id)", { count: "exact" })
      .eq("recommendations.incident_id", incidentId);
    if (position) query = query.or(`created_at.lt.${position.created_at},and(created_at.eq.${position.created_at},id.gt.${position.id})`);
    const { data, error, count } = await query.order("created_at", { ascending: false }).order("id", { ascending: true })
      .limit(limit).abortSignal(signal).retry(false);
    checkDeadline();
    if (error) throw error;
    if (!Array.isArray(data) || !Number.isSafeInteger(count) || count === null || count < 0 ||
        data.length > count || data.length > limit || (count > 0 && data.length === 0)) throw new InventoryCapacityError("read_invalid");
    expected ??= count;
    if (count !== expected - rows.length) throw new InventoryCapacityError("read_invalid");
    bytes += Buffer.byteLength(JSON.stringify(data));
    if (bytes > 8 * 1024 * 1024) throw new InventoryCapacityError("read_budget");
    for (const value of data) {
      const parsed = rowSchema.safeParse(value);
      if (!parsed.success) throw new InventoryCapacityError("read_invalid");
      const row = parsed.data;
      if (row.recommendations.incident_id !== incidentId || seen.has(row.id) || (position && !after(row, position))) {
        throw new InventoryCapacityError("read_invalid");
      }
      seen.add(row.id); position = row;
      const stored = { ...row };
      Reflect.deleteProperty(stored, "recommendations");
      rows.push(stored as unknown as RecentResponderActionRow);
    }
  } while (rows.length < Math.min(200, expected));
  checkDeadline();
  return rows;
}
