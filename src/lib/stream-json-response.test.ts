import { expect, it } from "vitest";
import { streamJsonResponse } from "./stream-json-response";

it("streams a response larger than the buffered function limit without data loss", async () => {
  const value = { coordinates: [-120.123456789, 48.123456789], payload: "x".repeat(5 * 1024 * 1024) };
  const response = streamJsonResponse(value);
  expect(response.headers.get("content-length")).toBeNull();
  expect(response.headers.get("cache-control")).toContain("no-store");
  const reader = response.body!.getReader();
  let text = "";
  const decoder = new TextDecoder();
  let chunks = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    expect(result.value.length).toBeLessThanOrEqual(64 * 1024);
    text += decoder.decode(result.value, { stream: true });
    chunks++;
  }
  text += decoder.decode();
  expect(chunks).toBeGreaterThan(1);
  expect(JSON.parse(text)).toEqual(value);
});

it("rejects pre-canceled map delivery instead of completing partial JSON", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(streamJsonResponse({ data: "test" }, controller.signal).json()).rejects.toThrow(/canceled/);
});
