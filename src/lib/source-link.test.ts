import { describe, expect, it } from "vitest";
import { FIRMS_PUBLIC_SOURCE_URL, redactFirmsProvenance, sourceLinkHref } from "./source-link";

describe("sourceLinkHref", () => {
  it("never renders a credential-bearing FIRMS request as a source link", () => {
    for (const value of [
      "https://firms.modaps.eosdis.nasa.gov/api/area/csv/synthetic-key/VIIRS_SNPP_NRT/1,2,3,4/3",
      "https://FIRMS.MODAPS.EOSDIS.NASA.GOV/api/country/csv/synthetic-key/USA?MAP_KEY=synthetic-key",
      "https://firms.modaps.eosdis.nasa.gov/mapserver/wms/fires/synthetic-key/?request=GetMap",
    ]) {
      expect(sourceLinkHref(value)).toBe(FIRMS_PUBLIC_SOURCE_URL);
    }
  });

  it("redacts nested legacy provenance and error text without changing the input", () => {
    const url = "https://firms.modaps.eosdis.nasa.gov/api/area/csv/synthetic-key/VIIRS/1,2,3,4/3";
    const input = { sourceUrl: url, audit: [{ note: `Request failed: ${url}`, count: 2, empty: null }], unset: undefined };
    const result = redactFirmsProvenance(input);
    expect(JSON.stringify(result)).not.toContain("synthetic-key");
    expect(result.audit[0].note).toBe(`Request failed: ${FIRMS_PUBLIC_SOURCE_URL}`);
    expect(result.audit[0].count).toBe(2);
    expect(result.audit[0].empty).toBeNull();
    expect(result.unset).toBeUndefined();
    expect(input.sourceUrl).toBe(url);
    expect(redactFirmsProvenance(result)).toEqual(result);
    expect(redactFirmsProvenance("https://example.gov/official?where=1%3D1")).toBe("https://example.gov/official?where=1%3D1");
  });
  it("accepts trimmed HTTP and HTTPS source URLs", () => {
    expect(sourceLinkHref(" https://example.gov/feed ")).toBe("https://example.gov/feed");
    expect(sourceLinkHref("http://localhost:3010/source")).toBe("http://localhost:3010/source");
  });

  it("shares unchanged coordinate arrays while redacting mixed-array strings", () => {
    const geometry = [[[-121.123456789, 38.123456789], [-120.234567891, 39.234567891]]];
    const secret = "https://firms.modaps.eosdis.nasa.gov/api/area/csv/synthetic-secret/VIIRS/1,2,3,4/3";
    const input = { geometry, mixed: [geometry, secret, [secret, 42]] };
    const result = redactFirmsProvenance(input);
    expect(result.geometry).toBe(geometry);
    expect(result.mixed).not.toBe(input.mixed);
    expect(result.mixed[0]).toBe(geometry);
    expect(result.mixed[1]).toBe(FIRMS_PUBLIC_SOURCE_URL);
    expect(result.mixed[2]).toEqual([FIRMS_PUBLIC_SOURCE_URL, 42]);
    expect(JSON.stringify(result)).not.toContain("synthetic-secret");
    expect(input.mixed[1]).toBe(secret);
  });

  it("preserves sparse array slots and redacts object keys without mutating input", () => {
    const secret = "https://firms.modaps.eosdis.nasa.gov/api/key/synthetic-secret";
    const input = [, { [secret]: secret }, 0];
    const result = redactFirmsProvenance(input);
    expect(0 in result).toBe(false);
    expect(result[1]).toEqual({ [FIRMS_PUBLIC_SOURCE_URL]: FIRMS_PUBLIC_SOURCE_URL });
    expect(input[1]).toEqual({ [secret]: secret });
    expect(result[2]).toBe(0);
  });

  it("rejects non-web, relative, malformed, and credential-bearing URLs", () => {
    for (const value of [
      "javascript:alert(1)",
      "data:text/html,unsafe",
      "/relative/source",
      "not a URL",
      "https://user:password@example.gov/feed",
      "",
      null,
      undefined,
    ]) {
      expect(sourceLinkHref(value)).toBeNull();
    }
  });
});
