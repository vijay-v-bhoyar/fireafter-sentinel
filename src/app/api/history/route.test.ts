import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ user: vi.fn(), read: vi.fn(), record: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireCurrentUser: mocks.user, AuthError: class extends Error { constructor(message: string, readonly status: number) { super(message); } } }));
vi.mock("@/lib/history-server", () => ({ readHistoryPage: mocks.read, readHistoryRecord: mocks.record }));
import { GET } from "./route";
import { AuthError } from "@/lib/auth";
const user = { id: "actor", organizationId: "org", role: "analyst" };
function request(query = "?incidentId=county&lane=actions", headers: Record<string, string> = { "x-fireafter-actor": "actor", "x-fireafter-organization": "org" }) {
  return new Request(`https://app.test/api/history${query}`, { headers });
}
beforeEach(() => { vi.resetAllMocks(); mocks.user.mockResolvedValue(user); mocks.read.mockResolvedValue({ entries: [] }); });
it("checks actual identity before and after the read and disables caching", async () => {
  const response = await GET(request()); expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(response.headers.get("vary")).toBe("Cookie");
  expect(mocks.user).toHaveBeenCalledTimes(2); expect(mocks.read).toHaveBeenCalledExactlyOnceWith({ incidentId: "county", lane: "actions", limit: "25" }, user);
});
it.each([401, 403])("preserves %s auth denial without querying history", async status => {
  mocks.user.mockRejectedValue(new AuthError("PRIVATE", status)); const response = await GET(request());
  expect(response.status).toBe(status); expect(mocks.read).not.toHaveBeenCalled(); expect(await response.text()).not.toContain("PRIVATE"); expect(response.headers.get("cache-control")).toBe("private, no-store");
});
it.each([{}, { "x-fireafter-actor": "wrong", "x-fireafter-organization": "org" }])("denies mismatched expected identity", async headers => {
  expect((await GET(request(undefined, headers as Record<string, string>))).status).toBe(403); expect(mocks.read).not.toHaveBeenCalled();
});
it("withholds the read after session identity changes", async () => {
  mocks.user.mockResolvedValueOnce(user).mockResolvedValueOnce({ ...user, id: "other" });
  expect((await GET(request())).status).toBe(403);
});
const queries = ["?incidentId=county&lane=actions", "?incidentId=county&lane=audit&recordId=10000000-0000-4000-8000-000000000001"];
it.each(queries)("denies a viewer before reading private history: %s", async query => {
  mocks.user.mockResolvedValue({ ...user, role: "viewer" });
  const response = await GET(request(query));
  expect(response.status).toBe(403); expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.record).not.toHaveBeenCalled();
});
it.each(queries.flatMap(query => ["viewer", "incident_commander", null].map(role => ({ query, role }))))("withholds private output after role changes to $role: $query", async ({ query, role }) => {
  mocks.user.mockResolvedValueOnce(user).mockResolvedValueOnce({ ...user, role });
  mocks.read.mockResolvedValue({ entries: [{ private: "PRIVATE_EVIDENCE" }] }); mocks.record.mockResolvedValue({ record: { private: "PRIVATE_EVIDENCE" } });
  const response = await GET(request(query));
  expect(response.status).toBe(403); expect(await response.text()).not.toContain("PRIVATE_EVIDENCE");
  expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(response.headers.get("vary")).toBe("Cookie");
});
it.each(["", "?incidentId=county&lane=bad", "?incidentId=county&lane=actions&limit=51", "?incidentId=county&lane=actions&lane=audit", "?incidentId=county&lane=actions&actorId=forged", "?incidentId=county&lane=actions&commandId=bad"])("denies invalid query %s", async query => {
  expect((await GET(request(query))).status).toBe(400); expect(mocks.user).not.toHaveBeenCalled();
});
it("does not disclose provider diagnostics", async () => {
  mocks.read.mockRejectedValue(new Error("PRIVATE_SQL")); const response = await GET(request());
  expect(response.status).toBe(503); expect(await response.text()).not.toContain("PRIVATE"); expect(response.headers.get("cache-control")).toBe("private, no-store");
});
it("authorizes record evidence reads separately with no cursor mixing", async () => {
  mocks.record.mockResolvedValue({ record: {} });
  const recordId = "10000000-0000-4000-8000-000000000001";
  expect((await GET(request(`?incidentId=county&lane=actions&recordId=${recordId}`))).status).toBe(200);
  expect(mocks.record).toHaveBeenCalledExactlyOnceWith({ incidentId: "county", lane: "actions", recordId }, user);
  expect(mocks.read).not.toHaveBeenCalled();
  expect((await GET(request(`?incidentId=county&lane=actions&recordId=${recordId}&cursor=abc`))).status).toBe(400);
});
