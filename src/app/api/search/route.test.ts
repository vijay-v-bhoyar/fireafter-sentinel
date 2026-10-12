import { beforeEach, describe, expect, it, vi } from "vitest";

const searchLocationsLiveMock = vi.fn();

vi.mock("@/lib/live-sources", () => ({
  searchLocationsLive: searchLocationsLiveMock,
}));

describe("GET /api/search", () => {
  beforeEach(() => {
    searchLocationsLiveMock.mockReset();
    searchLocationsLiveMock.mockResolvedValue([]);
  });

  it("normalizes a bounded query before calling TIGERweb search", async () => {
    searchLocationsLiveMock.mockResolvedValueOnce([
      { id: "county:ventura-ca", label: "Ventura County, CA" },
    ]);

    const { GET } = await import("./route");
    const response = await GET(
      new Request("http://localhost/api/search?query=%20Ventura%20County%20"),
    );

    expect(response.status).toBe(200);
    expect(searchLocationsLiveMock).toHaveBeenCalledWith("Ventura County");
    await expect(response.json()).resolves.toEqual({
      results: [{ id: "county:ventura-ca", label: "Ventura County, CA" }],
    });
  });

  it.each(["", "a", "x".repeat(81)])(
    "rejects an invalid query without calling the upstream adapter",
    async (query) => {
      const { GET } = await import("./route");
      const response = await GET(
        new Request(
          `http://localhost/api/search?query=${encodeURIComponent(query)}`,
        ),
      );

      expect(response.status).toBe(400);
      expect(searchLocationsLiveMock).not.toHaveBeenCalled();
      await expect(response.json()).resolves.toMatchObject({ results: [] });
    },
  );

  it("returns a structured degraded response when the adapter throws", async () => {
    searchLocationsLiveMock.mockRejectedValueOnce(new Error("TIGERweb timeout"));

    const { GET } = await import("./route");
    const response = await GET(
      new Request("http://localhost/api/search?query=Ventura"),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "County search is temporarily unavailable. Retry when TIGERweb is reachable.",
      code: "county_search_unavailable",
      retryable: true,
      results: [],
    });
  });
});
