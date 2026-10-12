import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ user: vi.fn(), read: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireCurrentUser: mocks.user, AuthError: class extends Error { constructor(message: string, readonly status: number) { super(message); } } }));
vi.mock("@/lib/fireafter-supabase", () => ({ getSupabaseAssetInventoryPage: mocks.read }));
import { GET } from "./route";
import { AuthError } from "@/lib/auth";
const user = { id: "actor", organizationId: "org", role: "analyst" };
function request(query = "?incidentId=county", headers: Record<string, string> = { "x-fireafter-actor": "actor", "x-fireafter-organization": "org" }) {
  return new Request(`https://app.test/api/assets/page${query}`, { headers });
}
beforeEach(() => { vi.clearAllMocks(); mocks.user.mockResolvedValue(user); mocks.read.mockResolvedValue({ items: [] }); });
it("revalidates identity after reading and forbids shared caching", async () => {
  const response = await GET(request()); expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(response.headers.get("vary")).toBe("Cookie");
  expect(mocks.user).toHaveBeenCalledTimes(2); expect(mocks.read).toHaveBeenCalledExactlyOnceWith({ incidentId: "county", start: "0", limit: "25" }, user);
});
it.each([401, 403])("denies %s without asset reads or provider details", async status => {
  mocks.user.mockRejectedValue(new AuthError("PRIVATE", status)); const response = await GET(request());
  expect(response.status).toBe(status); expect(mocks.read).not.toHaveBeenCalled(); expect(await response.text()).not.toContain("PRIVATE");
});
it.each([{}, { "x-fireafter-actor": "wrong", "x-fireafter-organization": "org" }])("denies missing or stale authority headers", async headers => {
  expect((await GET(request(undefined, headers as Record<string, string>))).status).toBe(403); expect(mocks.read).not.toHaveBeenCalled();
});
it("withholds data after session identity changes", async () => {
  mocks.user.mockResolvedValueOnce(user).mockResolvedValueOnce({ ...user, id: "other" }); expect((await GET(request())).status).toBe(403);
});
it.each(["", "?incidentId=c&limit=51", "?incidentId=c&start=1", "?incidentId=c&start=-1", "?incidentId=c&start=01", "?incidentId=c&revision=bad", "?incidentId=c&incidentId=d", "?incidentId=c&actorId=forged"])("rejects malformed query %s", async query => {
  expect((await GET(request(query))).status).toBe(400); expect(mocks.user).not.toHaveBeenCalled();
});
it("hides SQL and transport diagnostics", async () => {
  mocks.read.mockRejectedValue(new Error("PRIVATE_SQL")); const response = await GET(request());
  expect(response.status).toBe(503); expect(await response.text()).not.toContain("PRIVATE");
});
