// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import FeaturesPage from "./page";

vi.mock("@/lib/auth", () => { throw new Error("Feature graph must not load auth"); });
vi.mock("@/lib/fireafter-data", () => { throw new Error("Feature graph must not load incident data"); });

afterEach(cleanup);

it("keeps the unscoped public guide available without auth or incident dependencies", async () => {
  render(await FeaturesPage({}));
  expect(screen.getByRole("heading", { name: "Product feature graph" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Return to the live app" }).getAttribute("href")).toBe("/");
});

it("awaits the requested county and renders scoped links on the initial response", async () => {
  render(await FeaturesPage({ searchParams: Promise.resolve({ incidentId: "incident-okanogan-county-wa" }) }));
  expect(screen.getByRole("link", { name: "Return to the live app" }).getAttribute("href"))
    .toBe("/?incidentId=incident-okanogan-county-wa");
  expect(screen.getByRole("link", { name: "County search" }).getAttribute("href"))
    .toBe("/?incidentId=incident-okanogan-county-wa");
});

it.each(["", " ", ["first", "second"], "x".repeat(257)])("rejects malformed county references instead of silently returning another county", async incidentId => {
  render(await FeaturesPage({ searchParams: Promise.resolve({ incidentId }) }));
  expect(screen.getByRole("alert").textContent).toContain("Invalid incident reference");
  expect(screen.queryByRole("heading", { name: "Product feature graph" })).toBeNull();
});
