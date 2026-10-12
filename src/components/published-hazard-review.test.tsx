// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PublishedHazardReview } from "./published-hazard-review";
import type { Asset, SourceSnapshot } from "@/lib/types";

afterEach(cleanup);
const asset = { id: "test", name: "Test bridge", publishedHazard: { assessmentId: "test-v1", fireName: "Test",
  basinId: "basin-1", combinedHazard: "High", probabilityClass: "60-80%", volumeClass: "1,000-10,000",
  assessmentDate: "2026-09-01", rainfallScenario: "24 mm/h", sourceUrl: "https://www.usgs.gov/", fireIdentity: "candidate" } } as Asset;
it("labels official classes separately and opens the selected asset review", () => {
  const onReview = vi.fn();
  render(<PublishedHazardReview assets={[asset]} sources={[{ sourceKey: "usgs-pwfdf", freshness: { state: "current" } } as SourceSnapshot]} onReview={onReview} />);
  expect(screen.getByText("USGS combined hazard: High")).toBeTruthy();
  expect(screen.getByText(/not verified cross-provider identity/)).toBeTruthy();
  expect(screen.getByText(/not FireAfter risk scores/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Review asset evidence" }));
  expect(onReview).toHaveBeenCalledWith(asset);
});
it("removes published rankings when checks expire", () => {
  render(<PublishedHazardReview assets={[asset]} sources={[{ sourceKey: "usgs-pwfdf", freshness: { state: "expired" } } as SourceSnapshot]} onReview={() => {}} />);
  expect(screen.queryByText("USGS combined hazard: High")).toBeNull();
  expect(screen.getByRole("status").textContent).toContain("does not establish low hazard");
});
