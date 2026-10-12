import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ user: vi.fn(), read: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireCurrentUser: mocks.user, AuthError: class extends Error { constructor(message: string, readonly status: number) { super(message); } } }));
vi.mock("@/lib/fireafter-supabase", () => ({ getSupabaseQueuePage: mocks.read }));
import { GET } from "./route";
import { AuthError } from "@/lib/auth";
import { QueuePageError } from "@/lib/queue-page-contract";
import { inventoryUser as user } from "../../../../test/asset-page-fixture";
import { queuePage } from "../../../../test/queue-page-fixture";
function request(query = "?incidentId=county", actor = user.id) {
  return new Request(`https://app.test/api/queue/page${query}`, { headers: { "x-fireafter-actor": actor, "x-fireafter-organization": user.organizationId } });
}
beforeEach(() => { vi.clearAllMocks(); mocks.user.mockResolvedValue(user); mocks.read.mockResolvedValue({ page: queuePage(), privateContext: "PRIVATE" }); });
it("returns only the page, revalidates authority and forbids shared caching", async () => {
  const response = await GET(request()); expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(response.headers.get("vary")).toBe("Cookie");
  expect(mocks.user).toHaveBeenCalledTimes(2); expect(await response.text()).not.toContain("PRIVATE");
});
it.each([401, 403])("rejects unauthenticated/unauthorized %s", async status => {
  mocks.user.mockRejectedValue(new AuthError("PRIVATE", status)); const response = await GET(request());
  expect(response.status).toBe(status); expect(mocks.read).not.toHaveBeenCalled(); expect(await response.text()).not.toContain("PRIVATE");
});
it.each(["id", "organizationId", "role"])("withholds the page if %s changes", async key => {
  mocks.user.mockResolvedValueOnce(user).mockResolvedValueOnce({ ...user, [key]: "other" });
  expect((await GET(request())).status).toBe(403);
});
it.each(["", "?incidentId=c&limit=51", "?incidentId=c&start=10", "?incidentId=c&start=-1", "?incidentId=c&start=01", "?incidentId=c&revision=bad", "?incidentId=c&incidentId=d", "?incidentId=c&actorId=forged"])("rejects malformed %s", async query => {
  expect((await GET(request(query))).status).toBe(400); expect(mocks.read).not.toHaveBeenCalled();
});
it("rejects stale client identity before reads", async () => { expect((await GET(request(undefined, "wrong"))).status).toBe(403); expect(mocks.read).not.toHaveBeenCalled(); });
it("returns conflict for changed evidence without raw diagnostics", async () => {
  mocks.read.mockRejectedValue(new QueuePageError(409, "PRIVATE")); const response = await GET(request()); expect(response.status).toBe(409); expect(await response.text()).not.toContain("PRIVATE");
});
it("redacts unexpected failures", async () => { mocks.read.mockRejectedValue(new Error("PRIVATE")); const response = await GET(request()); expect(response.status).toBe(503); expect(await response.text()).not.toContain("PRIVATE"); });
