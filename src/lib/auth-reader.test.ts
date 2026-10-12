import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ client: vi.fn(), user: vi.fn(), membership: vi.fn() }));
vi.mock("./supabase", () => ({ getSupabaseServerClient: mocks.client }));
vi.mock("./fireafter-supabase", () => ({ getDefaultOrganizationMembership: mocks.membership }));
import { createCurrentUserReader } from "./auth";
afterEach(() => { vi.resetAllMocks(); });
it("captures the cookie client once but revalidates Auth and organization on every read", async () => {
  mocks.client.mockResolvedValue({ auth: { getUser: mocks.user } });
  mocks.user.mockResolvedValue({ data: { user: { id: "actor", email: "local@example.test" } }, error: null });
  mocks.membership.mockResolvedValue({ organization_id: "org", role: "incident_commander" });
  const read = await createCurrentUserReader(); expect(mocks.user).not.toHaveBeenCalled();
  expect(await read()).toMatchObject({ id: "actor", role: "incident_commander" });
  mocks.membership.mockResolvedValue({ organization_id: "org", role: "viewer" });
  expect(await read()).toMatchObject({ role: "viewer" });
  mocks.user.mockResolvedValue({ data: { user: null }, error: new Error("Session revoked") });
  expect(await read()).toBeNull();
  expect(mocks.client).toHaveBeenCalledTimes(1); expect(mocks.user).toHaveBeenCalledTimes(3); expect(mocks.membership).toHaveBeenCalledTimes(2);
});
