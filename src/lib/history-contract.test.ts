import { expect, it } from "vitest";
import { compareHistoryPosition, HistoryTimeSchema, historyTime } from "./history-contract";

it.each(["2026-10-08T12:00:00.123456Z", "2026-10-08T07:00:00.123456-05:00", "2026-10-08T17:30:00.123456+05:30",
  "2026-10-09T02:00:00.123456+14:00", "2026-10-08T00:00:00.123456-12:00"])("preserves the same microsecond instant and original offset: %s", value => {
  expect(HistoryTimeSchema.parse(value)).toBe(value);
  expect(historyTime(value)).toBe(historyTime("2026-10-08T12:00:00.123456Z"));
});
it("orders sub-millisecond values and UUID ties across different offsets", () => {
  const first = { createdAt: "2026-10-08T07:00:00.000001-05:00", id: "a" };
  const second = { createdAt: "2026-10-08T17:30:00.000002+05:30", id: "a" };
  expect(historyTime(second.createdAt) - historyTime(first.createdAt)).toBe(BigInt(1));
  expect(compareHistoryPosition(first, second)).toBe(-1);
  expect(compareHistoryPosition(first, { createdAt: "2026-10-08T12:00:00.000001Z", id: "b" })).toBe(-1);
  expect(historyTime("1969-12-31T18:59:59.999999-05:00")).toBe(BigInt(-1));
});
it.each(["2026-10-08T12:00:00", "2026-10-08T12:00:00.1234567Z", "2026-10-08T12:00:00-0500", "2026-10-08T12:00:00+24:00",
  "2026-10-08T12:00:00+05:60", "2026-02-30T12:00:00Z", "2026-10-08T12:00:00Z,id.gt.fake"])("rejects invalid or unsafe timestamp: %s", value => {
  expect(HistoryTimeSchema.safeParse(value).success).toBe(false);
  expect(() => historyTime(value)).toThrow();
});
