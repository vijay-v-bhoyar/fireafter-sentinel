import { beforeEach, describe, expect, it, vi } from "vitest";
import { admitRun, readRun, cancelRun, acquireRunLease, renewRunLease, reserveProviderAttempt, settleProviderAttempt, checkpointRun } from "./runs";

const boundary = vi.hoisted(() => ({ user: vi.fn(), rpc: vi.fn(), admin: vi.fn() }));
vi.mock("../auth", () => ({ getCurrentUser: () => boundary.user() }));
vi.mock("../supabase", () => ({ getSupabaseAdminClient: () => boundary.admin() }));
const id = (n: number) => `50000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { organizationId: id(1), incidentId: id(2), mode: "synthetic" as const };
const command = { incidentId: scope.incidentId, sourceConfigRevision: id(3), mode: scope.mode, commandId: id(4) };
const run = { id: id(5), scope, sourceConfigRevision: id(3), createdBy: id(6), dispatchId: id(5),
  createdAt: "2026-10-11T20:00:00.000Z", deadlineAt: "2026-10-11T20:02:00.000Z", status: "queued", stage: "admitted", fence: 0, leaseUntil: null,
  usage: { tavilyRequests: 0, modelRequests: 0, inputTokens: 0, outputTokens: 0 } };
const receipt = { runId: run.id, commandId: command.commandId, kind: "admit", status: "queued", at: run.createdAt };
const locator = { incidentId: scope.incidentId, mode: scope.mode, runId: run.id };
const worker = { scope, runId: run.id, owner: id(7), fence: 1 };
const reservation = { ...worker, attemptId: id(8), stage: "extract", kind: "model", inputTokens: 100, outputTokens: 100 };
beforeEach(() => {
  vi.resetAllMocks(); boundary.user.mockResolvedValue({ id: id(6), organizationId: scope.organizationId, role: "analyst" });
  boundary.admin.mockReturnValue({ rpc: boundary.rpc }); boundary.rpc.mockResolvedValue({ data: { run, receipt, replayed: false }, error: null });
});
describe("Sentinel run service admission and worker boundaries", () => {
  it.each(["analyst", "incident_commander"])("derives %s actor and organization from fresh auth", async role => {
    boundary.user.mockResolvedValue({ id: id(6), organizationId: scope.organizationId, role });
    expect((await admitRun(command)).run.id).toBe(run.id);
    expect(boundary.rpc).toHaveBeenCalledExactlyOnceWith("sentinel_admit_run", {
      p_actor_id: id(6), p_organization_id: scope.organizationId, p_incident_id: scope.incidentId, p_mode: scope.mode, p_config_id: id(3), p_command_id: id(4),
    });
  });
  it("rejects caller-supplied authority and malformed commands before auth or storage", async () => {
    await expect(admitRun({ ...command, actorId: id(99) })).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(admitRun({ ...command, organizationId: id(99) })).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(admitRun({ ...command, deadlineAt: run.deadlineAt })).rejects.toMatchObject({ code: "INPUT_INVALID" });
    expect(boundary.user).not.toHaveBeenCalled(); expect(boundary.admin).not.toHaveBeenCalled();
  });
  it("denies absent auth and viewer mutation without privileged calls", async () => {
    boundary.user.mockResolvedValue(null);
    await expect(admitRun(command)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    boundary.user.mockResolvedValue({ id: id(6), organizationId: scope.organizationId, role: "viewer" });
    await expect(admitRun(command)).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    await expect(cancelRun({ ...locator, commandId: id(9) })).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    expect(boundary.rpc).not.toHaveBeenCalled();
  });
  it("allows authenticated viewer status reads and preserves explicit absence", async () => {
    boundary.user.mockResolvedValue({ id: id(6), organizationId: scope.organizationId, role: "viewer" });
    boundary.rpc.mockResolvedValue({ data: run, error: null }); expect(await readRun(locator)).toEqual(run);
    boundary.rpc.mockResolvedValue({ data: null, error: null }); expect(await readRun(locator)).toBeNull();
  });
  it.each([
    { scope: { ...scope, incidentId: id(99) } }, { createdBy: id(99) }, { sourceConfigRevision: id(99) },
    { deadlineAt: "2026-10-11T20:03:00.000Z" }, { dispatchId: id(99) }, { owner: id(99) },
  ])("holds malformed or misbound run readback %j", async patch => {
    boundary.rpc.mockResolvedValue({ data: { run: { ...run, ...patch }, receipt, replayed: false }, error: null });
    await expect(admitRun(command)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
  });
  it("holds a receipt with a mismatched command or operation", async () => {
    for (const patch of [{ commandId: id(99) }, { kind: "cancel" }, { runId: id(99) }]) {
      boundary.rpc.mockResolvedValue({ data: { run, receipt: { ...receipt, ...patch }, replayed: true }, error: null });
      await expect(admitRun(command)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    }
  });
  it("returns the exact cancellation receipt after fresh auth", async () => {
    boundary.rpc.mockResolvedValue({ data: { run: { ...run, status: "canceled" }, receipt: { ...receipt, kind: "cancel", commandId: id(9), status: "canceled" }, replayed: false }, error: null });
    expect((await cancelRun({ ...locator, commandId: id(9) })).receipt.kind).toBe("cancel");
  });
  it("binds private worker lease response and leaves membership revalidation to SQL", async () => {
    boundary.rpc.mockResolvedValue({ data: { run: { ...run, fence: 1, status: "retrieving", leaseUntil: "2026-10-11T20:00:30.000Z" }, owner: worker.owner }, error: null });
    expect((await acquireRunLease({ scope, runId: run.id, owner: worker.owner })).run.fence).toBe(1);
    expect(boundary.user).not.toHaveBeenCalled();
    boundary.rpc.mockResolvedValue({ data: { run: { ...run, fence: 1, leaseUntil: "2026-10-11T20:00:30.000Z" }, owner: id(99) }, error: null });
    await expect(acquireRunLease({ scope, runId: run.id, owner: worker.owner })).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
  });
  it("passes durable reservation identity/fence and never converts denied dispatch to success", async () => {
    boundary.rpc.mockResolvedValue({ data: { attemptId: id(8), dispatchAllowed: false, dispatchDeadline: "2026-10-11T20:00:30.000Z" }, error: null });
    expect((await reserveProviderAttempt(reservation)).dispatchAllowed).toBe(false);
    expect(boundary.rpc.mock.calls[0][1]).toMatchObject({ p_owner: worker.owner, p_fence: 1, p_attempt_id: id(8), p_input_tokens: 100, p_output_tokens: 100 });
    await expect(reserveProviderAttempt({ ...reservation, outputTokens: 1001 })).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(reserveProviderAttempt({ ...reservation, kind: "tavily" })).rejects.toMatchObject({ code: "INPUT_INVALID" });
  });
  it("binds a renewed lease to the same worker fence", async () => {
    const leased = { ...run, status: "retrieving", fence: worker.fence, leaseUntil: "2026-10-11T20:00:30.000Z" };
    boundary.rpc.mockResolvedValue({ data: { run: leased, owner: worker.owner }, error: null });
    expect((await renewRunLease(worker)).run.deadlineAt).toBe(run.deadlineAt);
    boundary.rpc.mockResolvedValue({ data: { run: { ...leased, fence: 2 }, owner: worker.owner }, error: null });
    await expect(renewRunLease(worker)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
  });
  it("records uncertain usage without invented actual counters", async () => {
    boundary.rpc.mockResolvedValue({ data: { attemptId: id(8), state: "uncertain" }, error: null });
    expect(await settleProviderAttempt({ ...worker, attemptId: id(8), state: "uncertain", inputTokens: null, outputTokens: null, responseBytes: null })).toEqual({ attemptId: id(8), state: "uncertain" });
    await expect(settleProviderAttempt({ ...worker, attemptId: id(8), state: "uncertain", inputTokens: 0, outputTokens: null, responseBytes: null })).rejects.toMatchObject({ code: "INPUT_INVALID" });
  });
  it("binds a checkpoint and refuses unsupported completed publication", async () => {
    boundary.rpc.mockResolvedValue({ data: { ...run, fence: 1, status: "interpreting", stage: "extracted" }, error: null });
    const input = { ...worker, checkpointId: id(9), state: "interpreting", stage: "extracted", resultHash: "a".repeat(64) };
    expect((await checkpointRun(input)).status).toBe("interpreting");
    await expect(checkpointRun({ ...input, state: "completed" })).rejects.toMatchObject({ code: "INPUT_INVALID" });
    boundary.rpc.mockResolvedValue({ data: { ...run, id: id(99), dispatchId: id(99) }, error: null });
    await expect(checkpointRun(input)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
  });
  it.each([["42501", "SCOPE_DENIED"], ["40001", "RUN_CONFLICT"], ["23505", "RUN_CONFLICT"], ["55P03", "RUN_BUSY"], ["54000", "BUDGET_STOPPED"], ["22023", "INPUT_INVALID"]])("maps %s to a safe %s error", async (code, expected) => {
    boundary.rpc.mockResolvedValue({ data: null, error: { code, message: "PRIVATE_DATABASE_CONNECTION" } });
    await expect(admitRun(command)).rejects.toMatchObject({ code: expected });
    await expect(admitRun(command)).rejects.not.toHaveProperty("message", "PRIVATE_DATABASE_CONNECTION");
  });
  it("redacts SDK/auth/target failures without defaulting to another store", async () => {
    boundary.admin.mockImplementation(() => { throw new Error("PRIVATE_TARGET_DETAIL"); });
    await expect(admitRun(command)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE", message: "Run storage is unavailable. Try again later." });
    expect(boundary.rpc).not.toHaveBeenCalled();
  });
});
