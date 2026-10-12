import { z } from "zod";
import { IdSchema, InstantSchema, SENTINEL_LIMITS, utf8Bytes } from "./contracts";

const id = IdSchema.transform(value => value.toLowerCase());
const token = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/);
const text = (length: number) => z.string().min(1).max(length).refine(value => value === value.trim() && !value.includes("\0") &&
  new TextDecoder("utf-8", { ignoreBOM: true }).decode(new TextEncoder().encode(value)) === value);
const minute = InstantSchema.refine(value => Date.parse(value) % 60_000 === 0, "Use a whole UTC minute.").transform(value => new Date(value).toISOString());
const nullableMinute = minute.nullable();
const crew = z.strictObject({ id, label: text(100), capabilities: z.array(token).max(20).nullable(), availableFrom: nullableMinute, availableUntil: nullableMinute })
  .superRefine((value, ctx) => {
    if (value.capabilities && new Set(value.capabilities).size !== value.capabilities.length) ctx.addIssue({ code: "custom", message: "Duplicate capability." });
    if (value.availableFrom && value.availableUntil && Date.parse(value.availableFrom) >= Date.parse(value.availableUntil)) ctx.addIssue({ code: "custom", message: "Crew availability must have positive length." });
  });
const task = z.strictObject({ id, assetId: id, label: text(100), taskType: token, requiredCapability: token.nullable(),
  durationMinutes: z.number().int().min(1).max(SENTINEL_LIMITS.shiftMinutes).nullable(),
  travelMinutes: z.number().int().min(0).max(SENTINEL_LIMITS.shiftMinutes).nullable(),
  windowFrom: nullableMinute, windowUntil: nullableMinute, priority: z.number().int().min(1).max(SENTINEL_LIMITS.tasks) })
  .refine(value => !value.windowFrom || !value.windowUntil || Date.parse(value.windowFrom) < Date.parse(value.windowUntil), "Task window must have positive length.");
export const ConstraintConfigurationSchema = z.strictObject({ schemaVersion: z.literal(1),
  shift: z.strictObject({ startsAt: minute, endsAt: minute }), crews: z.array(crew).max(SENTINEL_LIMITS.crews),
  tasks: z.array(task).min(1).max(SENTINEL_LIMITS.tasks), inputBasis: z.enum(["user_authored", "demo"]),
}).superRefine((value, ctx) => {
  const length = (Date.parse(value.shift.endsAt) - Date.parse(value.shift.startsAt)) / 60_000;
  if (length <= 0 || length > SENTINEL_LIMITS.shiftMinutes || new Set(value.crews.map(v => v.id)).size !== value.crews.length ||
      new Set(value.tasks.map(v => v.id)).size !== value.tasks.length || utf8Bytes(JSON.stringify(value)) > SENTINEL_LIMITS.mutationBytes)
    ctx.addIssue({ code: "custom", message: "Constraint configuration exceeds shift, identity or transport bounds." });
}).transform(value => ({ ...value,
  crews: value.crews.map(v => ({ ...v, capabilities: v.capabilities === null ? null : [...v.capabilities].sort() })).sort((a, b) => a.id.localeCompare(b.id)),
  tasks: [...value.tasks].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id)),
}));
export type ConstraintConfiguration = z.infer<typeof ConstraintConfigurationSchema>;
export const TaskAssignmentSchema = z.strictObject({ taskId: id, crewId: id, startsAt: minute });
export type TaskAssignment = z.infer<typeof TaskAssignmentSchema>;
type Issue = { code: string; taskId?: string; crewId?: string };
type CompleteTask = ConstraintConfiguration["tasks"][number] & { requiredCapability: string; durationMinutes: number; travelMinutes: number; windowFrom: string; windowUntil: string };
type CompleteCrew = ConstraintConfiguration["crews"][number] & { capabilities: string[]; availableFrom: string; availableUntil: string };
const taskComplete = (value: ConstraintConfiguration["tasks"][number]): value is CompleteTask => value.requiredCapability !== null && value.durationMinutes !== null && value.travelMinutes !== null && value.windowFrom !== null && value.windowUntil !== null;
const crewComplete = (value: ConstraintConfiguration["crews"][number]): value is CompleteCrew => value.capabilities !== null && value.availableFrom !== null && value.availableUntil !== null;
const at = (base: number, minutes: number) => new Date(base + minutes * 60_000).toISOString();

/** Validate an explicit complete assignment independently of the search procedure. */
export function validateTaskAssignments(input: unknown, assignmentsInput: unknown) {
  const config = ConstraintConfigurationSchema.parse(input), assignments = z.array(TaskAssignmentSchema).max(SENTINEL_LIMITS.tasks).parse(assignmentsInput);
  const issues: Issue[] = [], assigned = new Set<string>();
  for (const assignment of assignments) {
    if (assigned.has(assignment.taskId)) issues.push({ code: "DUPLICATE_TASK", taskId: assignment.taskId });
    assigned.add(assignment.taskId);
    if (!config.tasks.some(v => v.id === assignment.taskId)) issues.push({ code: "UNKNOWN_TASK", taskId: assignment.taskId });
    if (!config.crews.some(v => v.id === assignment.crewId)) issues.push({ code: "UNKNOWN_CREW", crewId: assignment.crewId });
  }
  for (const t of config.tasks) if (!assigned.has(t.id)) issues.push({ code: "TASK_UNASSIGNED", taskId: t.id });
  const shiftStart = Date.parse(config.shift.startsAt), shiftEnd = Date.parse(config.shift.endsAt);
  for (const c of config.crews) {
    const selected = assignments.filter(v => v.crewId === c.id).sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt) || a.taskId.localeCompare(b.taskId));
    let previousEnd = shiftStart;
    for (const assignment of selected) {
      const t = config.tasks.find(v => v.id === assignment.taskId);
      if (!t) continue;
      if (!taskComplete(t)) { issues.push({ code: "TASK_INPUTS_MISSING", taskId: t.id }); continue; }
      if (!crewComplete(c)) { issues.push({ code: "CREW_INPUTS_MISSING", crewId: c.id }); continue; }
      const start = Date.parse(assignment.startsAt), travelStart = start - t.travelMinutes * 60_000, end = start + t.durationMinutes * 60_000;
      if (!c.capabilities.includes(t.requiredCapability)) issues.push({ code: "CAPABILITY_MISMATCH", taskId: t.id, crewId: c.id });
      if (travelStart < Math.max(shiftStart, Date.parse(c.availableFrom)) || end > Math.min(shiftEnd, Date.parse(c.availableUntil))) issues.push({ code: "OUTSIDE_CREW_SHIFT", taskId: t.id, crewId: c.id });
      if (start < Date.parse(t.windowFrom) || end > Date.parse(t.windowUntil)) issues.push({ code: "OUTSIDE_TASK_WINDOW", taskId: t.id });
      if (travelStart < previousEnd) issues.push({ code: "CREW_OVERLAP", taskId: t.id, crewId: c.id });
      previousEnd = Math.max(previousEnd, end);
    }
  }
  return { valid: issues.length === 0, issues, selectedTaskIds: config.tasks.map(v => v.id) };
}

type State = { a: number; b: number; code: number };
/** Pareto frontier: increasing a, strictly decreasing b. Earlier crew ends dominate later ends. */
function insertState(states: State[], candidate: State) {
  let lo = 0, hi = states.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (states[mid].a < candidate.a) lo = mid + 1; else hi = mid; }
  if ((lo > 0 && states[lo - 1].b <= candidate.b) || (lo < states.length && states[lo].a === candidate.a && states[lo].b <= candidate.b)) return;
  let end = lo;
  while (end < states.length && states[end].b >= candidate.b) end++;
  states.splice(lo, end - lo, candidate);
}

/** Exact bounded two-crew feasibility; no hazard inference, partial task dropping or field dispatch. */
export function proposeTaskAssignments(input: unknown) {
  const config = ConstraintConfigurationSchema.parse(input), base = Date.parse(config.shift.startsAt), horizon = (Date.parse(config.shift.endsAt) - base) / 60_000;
  const issues: Issue[] = [], selectedTaskIds = config.tasks.map(v => v.id), crews = config.crews.filter(crewComplete);
  const incompleteCrews = config.crews.filter(v => !crewComplete(v));
  for (const c of incompleteCrews) issues.push({ code: "CREW_INPUTS_MISSING", crewId: c.id });
  for (const t of config.tasks) if (!taskComplete(t)) issues.push({ code: "TASK_INPUTS_MISSING", taskId: t.id });
  if (config.tasks.some(v => !taskComplete(v)) || !config.crews.length) return { status: "incomplete" as const, issues: config.crews.length ? issues : [...issues, { code: "NO_CREWS" }], selectedTaskIds, assignments: [] };
  const tasks = config.tasks as CompleteTask[];
  const crewStarts = crews.map(v => Math.max(0, (Date.parse(v.availableFrom) - base) / 60_000));
  const crewEnds = crews.map(v => Math.min(horizon, (Date.parse(v.availableUntil) - base) / 60_000));
  const frontiers: State[][] = Array.from({ length: 1 << tasks.length }, () => []);
  frontiers[0].push({ a: crewStarts[0] ?? 0, b: crewStarts[1] ?? 0, code: 0 });
  for (let mask = 0; mask < frontiers.length - 1; mask++) {
    for (const state of frontiers[mask]) for (let i = 0; i < tasks.length; i++) {
      if (mask & (1 << i)) continue;
      const t = tasks[i];
      for (let c = 0; c < crews.length; c++) {
        if (!crews[c].capabilities.includes(t.requiredCapability)) continue;
        const cursor = c === 0 ? state.a : state.b;
        const start = Math.max(cursor + t.travelMinutes, (Date.parse(t.windowFrom) - base) / 60_000);
        const end = start + t.durationMinutes;
        if (end > crewEnds[c] || end > (Date.parse(t.windowUntil) - base) / 60_000) continue;
        insertState(frontiers[mask | (1 << i)], { a: c === 0 ? end : state.a, b: c === 1 ? end : state.b, code: state.code * 32 + i * 2 + c });
      }
    }
  }
  const complete = frontiers.at(-1)!;
  if (!complete.length) return { status: incompleteCrews.length ? "incomplete" as const : "infeasible" as const,
    issues: [...issues, { code: incompleteCrews.length ? "UNKNOWN_CREW_CAPACITY" : "NO_COMPLETE_ALLOCATION" }], selectedTaskIds, assignments: [] };
  complete.sort((a, b) => Math.max(a.a, a.b) - Math.max(b.a, b.b) || a.a + a.b - b.a - b.b || a.code - b.code);
  let code = complete[0].code;
  const steps: number[] = [];
  for (let i = 0; i < tasks.length; i++) { steps.push(code % 32); code = Math.floor(code / 32); }
  const cursors = [...crewStarts], assignments: TaskAssignment[] = [];
  for (const step of steps.reverse()) {
    const t = tasks[Math.floor(step / 2)], c = step % 2, start = Math.max(cursors[c] + t.travelMinutes, (Date.parse(t.windowFrom) - base) / 60_000);
    assignments.push({ taskId: t.id, crewId: crews[c].id, startsAt: at(base, start) }); cursors[c] = start + t.durationMinutes;
  }
  assignments.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt) || a.crewId.localeCompare(b.crewId) || a.taskId.localeCompare(b.taskId));
  if (!validateTaskAssignments(config, assignments).valid) throw new Error("Planner produced an invalid allocation.");
  return { status: "feasible" as const, issues, selectedTaskIds, assignments };
}
