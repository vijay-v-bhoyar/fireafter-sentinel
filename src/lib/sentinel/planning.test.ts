import { describe, expect, it } from "vitest";
import { ConstraintConfigurationSchema, proposeTaskAssignments, validateTaskAssignments, type ConstraintConfiguration } from "./planning";
const id = (n: number) => `97000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = (minutes: number) => new Date(Date.UTC(2026, 9, 11, 8, minutes)).toISOString();
const crew = (n = 1) => ({ id: id(n), label: `Demo crew ${n}`, capabilities: ["road"], availableFrom: at(0), availableUntil: at(480) });
const task = (n = 1) => ({ id: id(n + 20), assetId: id(n + 100), label: `Demo task ${n}`, taskType: "inspection", requiredCapability: "road", durationMinutes: 60,
  travelMinutes: 15, windowFrom: at(0), windowUntil: at(480), priority: n });
function configuration(): ConstraintConfiguration { return { schemaVersion: 1, shift: { startsAt: at(0), endsAt: at(480) }, crews: [crew(1), crew(2)], tasks: [task(1), task(2), task(3)], inputBasis: "demo" }; }
/** Independent exhaustive tiny-case oracle; does not use the solver's frontier or validator. */
function brute(config: ConstraintConfiguration): boolean {
  const visit = (remaining: number[], ends: number[]): boolean => {
    if (!remaining.length) return true;
    for (const i of remaining) for (let c = 0; c < config.crews.length; c++) {
      const t = config.tasks[i], crew = config.crews[c];
      if (t.durationMinutes === null || t.travelMinutes === null || !t.requiredCapability || !t.windowFrom || !t.windowUntil || !crew.capabilities || !crew.availableFrom || !crew.availableUntil || !crew.capabilities.includes(t.requiredCapability)) continue;
      const start = Math.max(ends[c] + t.travelMinutes * 60_000, Date.parse(t.windowFrom));
      const end = start + t.durationMinutes * 60_000;
      if (end > Math.min(Date.parse(t.windowUntil), Date.parse(crew.availableUntil), Date.parse(config.shift.endsAt))) continue;
      const next = [...ends]; next[c] = end;
      if (visit(remaining.filter(v => v !== i), next)) return true;
    }
    return false;
  };
  return visit(config.tasks.map((_, i) => i), config.crews.map(c => Math.max(Date.parse(config.shift.startsAt), Date.parse(c.availableFrom!))));
}
describe("Complete deterministic authored-input planning", () => {
  it("allocates every selected task and independently validates travel and service intervals", () => {
    const config = configuration(), result = proposeTaskAssignments(config); expect(result.status).toBe("feasible"); expect(result.assignments).toHaveLength(3);
    expect(validateTaskAssignments(config, result.assignments).valid).toBe(true); expect(result.selectedTaskIds).toHaveLength(3);
  });
  it("finds a schedule when greedy priority order misses an early tight window", () => {
    const config = configuration(); config.crews = [crew()]; config.tasks = [{ ...task(1), priority: 1, windowFrom: at(120), windowUntil: at(180), travelMinutes: 0 },
      { ...task(2), priority: 2, windowFrom: at(0), windowUntil: at(60), travelMinutes: 0 }];
    const result = proposeTaskAssignments(config); expect(result.status).toBe("feasible"); expect(result.assignments.map(v => v.taskId)).toEqual([id(22), id(21)]);
  });
  it("matches an independent exhaustive oracle across 100 varied three-task fixtures", () => {
    for (let seed = 0; seed < 100; seed++) {
      const config = configuration(); config.shift.endsAt = at(180); config.crews = [{ ...crew(1), availableUntil: at(180) }, { ...crew(2), capabilities: seed % 3 ? ["road"] : ["basin"], availableUntil: at(150) }];
      config.tasks = [0, 1, 2].map(i => ({ ...task(i + 1), durationMinutes: 20 + ((seed * 17 + i * 11) % 50), travelMinutes: (seed + i * 7) % 20,
        windowFrom: at((seed * 13 + i * 37) % 100), windowUntil: at(110 + ((seed * 7 + i * 19) % 70)) }));
      const result = proposeTaskAssignments(config); expect(result.status === "feasible", `fixture ${seed}`).toBe(brute(config));
      if (result.status === "feasible") expect(validateTaskAssignments(config, result.assignments).valid).toBe(true);
    }
  });
  it("is deterministic under equivalent task/crew/capability ordering", () => {
    const config = configuration(), expected = proposeTaskAssignments(config); const reordered = { ...config, tasks: [...config.tasks].reverse(), crews: [...config.crews].reverse() };
    expect(proposeTaskAssignments(reordered)).toEqual(expected);
  });
  it.each(["durationMinutes", "travelMinutes", "requiredCapability", "windowFrom", "windowUntil"])("retains missing %s rather than guessing or dropping the task", key => {
    const config = configuration(); config.tasks[0] = { ...config.tasks[0], [key]: null }; const result = proposeTaskAssignments(config);
    expect(result.status).toBe("incomplete"); expect(result.assignments).toEqual([]); expect(result.selectedTaskIds).toHaveLength(3);
  });
  it("distinguishes unknown extra crew capacity from proven infeasibility", () => {
    const config = configuration(); config.crews = [{ ...crew(), capabilities: [] }, { ...crew(2), capabilities: null }]; expect(proposeTaskAssignments(config).status).toBe("incomplete");
    config.crews[1].capabilities = []; expect(proposeTaskAssignments(config).status).toBe("infeasible");
  });
  it("can use fully known resources while labeling an unused incomplete crew", () => {
    const config = configuration(); config.crews[1].availableFrom = null; const result = proposeTaskAssignments(config);
    expect(result.status).toBe("feasible"); expect(result.issues).toContainEqual({ code: "CREW_INPUTS_MISSING", crewId: id(2) });
  });
  it("reports zero crews as missing input", () => { const config = configuration(); config.crews = []; expect(proposeTaskAssignments(config).status).toBe("incomplete"); });
  it("rejects a complete set that cannot fit rather than silently selecting fewer tasks", () => {
    const config = configuration(); config.crews = [crew()]; config.tasks = Array.from({ length: 10 }, (_, i) => ({ ...task(i + 1), durationMinutes: 60, travelMinutes: 0 }));
    const result = proposeTaskAssignments(config); expect(result.status).toBe("infeasible"); expect(result.selectedTaskIds).toHaveLength(10); expect(result.assignments).toEqual([]);
  });
  it("supports all ten tasks and the exact eight-hour boundary", () => {
    const config = configuration(); config.tasks = Array.from({ length: 10 }, (_, i) => ({ ...task(i + 1), durationMinutes: 80, travelMinutes: 16 }));
    const result = proposeTaskAssignments(config); expect(result.status).toBe("feasible"); expect(result.assignments).toHaveLength(10); expect(validateTaskAssignments(config, result.assignments).valid).toBe(true);
  });
  it.each(["missing", "duplicate", "unknownCrew", "capability", "overlap", "outsideWindow", "travelOutsideShift"])("manual modification rejects %s", key => {
    const config = configuration(), result = proposeTaskAssignments(config), assignments = result.assignments.map(v => ({ ...v }));
    if (key === "missing") assignments.pop();
    else if (key === "duplicate") assignments.push(assignments[0]);
    else if (key === "unknownCrew") assignments[0].crewId = id(999);
    else if (key === "capability") config.crews = config.crews.map(v => ({ ...v, capabilities: [] }));
    else if (key === "overlap") { assignments[0].crewId = id(1); assignments[1].crewId = id(1); assignments[1].startsAt = assignments[0].startsAt; }
    else if (key === "outsideWindow") assignments[0].startsAt = at(450);
    else assignments[0].startsAt = at(0);
    expect(validateTaskAssignments(config, assignments).valid).toBe(false);
  });
  it.each(["tooManyTasks", "tooManyCrews", "longShift", "duplicateTask", "invalidInterval", "fractionalMinute", "falseBasis"])("rejects invalid scope/capacity %s", key => {
    const config = configuration();
    if (key === "tooManyTasks") config.tasks = Array.from({ length: 11 }, (_, i) => task(i + 1));
    else if (key === "tooManyCrews") config.crews.push(crew(3));
    else if (key === "longShift") config.shift.endsAt = at(481);
    else if (key === "duplicateTask") config.tasks.push(config.tasks[0]);
    else if (key === "invalidInterval") config.tasks[0].windowUntil = config.tasks[0].windowFrom;
    else if (key === "fractionalMinute") config.shift.startsAt = "2026-10-11T08:00:00.001Z";
    else (config as unknown as Record<string, unknown>).inputBasis = "agency_verified";
    expect(ConstraintConfigurationSchema.safeParse(config).success).toBe(false);
  });
});
