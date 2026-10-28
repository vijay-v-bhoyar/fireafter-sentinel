// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FeatureGraph } from "./feature-graph";
import { FEATURE_GRAPH_EDGES, FEATURE_GRAPH_NODES, FEATURE_STAGES } from "@/lib/feature-graph";

afterEach(cleanup);

function chooseStage(id: string) {
  const stage = FEATURE_STAGES.find((item) => item.id === id)!;
  const navigation = screen.getByRole("navigation", { name: "Feature walkthrough stages" });
  fireEvent.click(within(navigation).getByRole("button", { name: `Step ${stage.number}: ${stage.title}` }));
}

describe("FeatureGraph", () => {
  it("shows an uncluttered six-stage walkthrough with native buttons and no connector canvas", () => {
    const { container } = render(<FeatureGraph />);
    expect(screen.getByRole("heading", { name: "County discovery and saved incidents" })).toBeTruthy();
    const navigation = screen.getByRole("navigation", { name: "Feature walkthrough stages" });
    expect(within(navigation).getAllByRole("button")).toHaveLength(6);
    for (const button of within(navigation).getAllByRole("button")) {
      expect(button.tagName).toBe("BUTTON");
      expect(button.getAttribute("type")).toBe("button");
    }
    expect(container.querySelector("svg")).toBeNull();
    expect(screen.getByText(/Implementation guide, not live system status/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /Explore the implementation code graph/ }).getAttribute("href"))
      .toBe("/code-graph.html");
  });

  it("selects stages and cards, showing full titles, sources, limits, and technical references", () => {
    render(<FeatureGraph />);
    for (const stage of FEATURE_STAGES) {
      chooseStage(stage.id);
      const list = screen.getByRole("list", { name: `Features in ${stage.title}` });
      const nodes = FEATURE_GRAPH_NODES.filter((node) => node.stage === stage.id);
      expect(within(list).getAllByRole("button")).toHaveLength(nodes.length);
      for (const node of nodes) {
        const button = within(list).getByRole("button", { name: `${node.title}. ${node.summary}` });
        button.focus();
        expect(document.activeElement).toBe(button);
        fireEvent.click(button);
        expect(button.getAttribute("aria-pressed")).toBe("true");
        const detail = screen.getByRole("article", { name: node.title });
        expect(within(detail).getByRole("heading", { name: node.title })).toBeTruthy();
        expect(within(detail).getByText(node.limits)).toBeTruthy();
        expect(within(detail).getByText(node.availability)).toBeTruthy();
        const technical = detail.querySelector("details")!;
        expect(technical.open).toBe(false);
        fireEvent.click(within(detail).getByText("Implementation, APIs, and tests"));
        expect(technical.open).toBe(true);
        for (const source of node.sources) expect(within(detail).getByText(source)).toBeTruthy();
        for (const file of [...node.implementation, ...node.tests]) {
          expect(within(detail).getByRole("link", { name: file }).getAttribute("href"))
            .toBe(`https://github.com/vijay-v-bhoyar/FireAfter/blob/main/${file}`);
        }
      }
    }
  });

  it("walks every feature in order in both directions, crossing stage boundaries without dangling steps", () => {
    render(<FeatureGraph />);
    const previous = screen.getByRole("button", { name: "Previous feature" }) as HTMLButtonElement;
    const next = screen.getByRole("button", { name: "Next feature" }) as HTMLButtonElement;
    expect(previous.disabled).toBe(true);
    for (const [index, node] of FEATURE_GRAPH_NODES.entries()) {
      expect(screen.getByRole("article", { name: node.title })).toBeTruthy();
      expect(screen.getByText(`${index + 1} / ${FEATURE_GRAPH_NODES.length}`)).toBeTruthy();
      const stage = FEATURE_STAGES.find((item) => item.id === node.stage)!;
      expect(screen.getByRole("button", { name: `Step ${stage.number}: ${stage.title}` }).getAttribute("aria-pressed")).toBe("true");
      if (index < FEATURE_GRAPH_NODES.length - 1) fireEvent.click(next);
    }
    expect(next.disabled).toBe(true);
    for (let index = FEATURE_GRAPH_NODES.length - 2; index >= 0; index--) {
      fireEvent.click(previous);
      expect(screen.getByRole("article", { name: FEATURE_GRAPH_NODES[index].title })).toBeTruthy();
    }
    expect(previous.disabled).toBe(true);
  });

  it("keeps the selected county on return links and every feature's app links", () => {
    const incidentId = "incident-los-angeles-county-ca";
    render(<FeatureGraph incidentId={incidentId} />);
    for (const name of ["FireAfter", "Return to the live app"]) {
      expect(screen.getByRole("link", { name }).getAttribute("href")).toBe(`/?incidentId=${incidentId}`);
    }
    for (const [index, node] of FEATURE_GRAPH_NODES.entries()) {
      const detail = screen.getByRole("article", { name: node.title });
      for (const { label, href } of node.where) {
        expect(within(detail).getByRole("link", { name: label }).getAttribute("href")).toBe(`${href}?incidentId=${incidentId}`);
      }
      if (index < FEATURE_GRAPH_NODES.length - 1) fireEvent.click(screen.getByRole("button", { name: "Next feature" }));
    }
    expect(screen.getByRole("link", { name: "Read the judge feature guide" }).getAttribute("href")).not.toContain("incidentId");
  });

  it("navigates actual relationships without lines or disconnected selections", () => {
    render(<FeatureGraph />);
    for (const edge of FEATURE_GRAPH_EDGES) {
      const from = FEATURE_GRAPH_NODES.find((node) => node.id === edge.from)!;
      const to = FEATURE_GRAPH_NODES.find((node) => node.id === edge.to)!;
      chooseStage(from.stage);
      const stage = FEATURE_STAGES.find((item) => item.id === from.stage)!;
      const list = screen.getByRole("list", { name: `Features in ${stage.title}` });
      fireEvent.click(within(list).getByRole("button", { name: `${from.title}. ${from.summary}` }));
      const fromDetail = screen.getByRole("article", { name: from.title });
      fireEvent.click(within(fromDetail).getByRole("button", { name: `Open ${to.title}` }));
      const toDetail = screen.getByRole("article", { name: to.title });
      expect(toDetail).toBeTruthy();
      fireEvent.click(within(toDetail).getByRole("button", { name: `Open ${from.title}` }));
      expect(screen.getByRole("article", { name: from.title })).toBeTruthy();
    }
  });

  it("exposes every feature in the full index and opens its detail", () => {
    render(<FeatureGraph />);
    const summary = screen.getByText("Full feature index (25)");
    fireEvent.click(summary);
    const index = summary.closest("details")!;
    expect(index.open).toBe(true);
    for (const node of FEATURE_GRAPH_NODES) {
      fireEvent.click(within(index).getByRole("link", { name: node.title }));
      expect(screen.getByRole("article", { name: node.title })).toBeTruthy();
    }
  });

  it("encodes the incident as one query value rather than a redirect or second parameter", () => {
    const incidentId = "county&returnTo=https://example.invalid/#other";
    render(<FeatureGraph incidentId={incidentId} />);
    const href = screen.getByRole("link", { name: "Return to the live app" }).getAttribute("href")!;
    const url = new URL(href, "https://fireafter-app.vercel.app");
    expect(url.origin).toBe("https://fireafter-app.vercel.app");
    expect([...url.searchParams]).toEqual([["incidentId", incidentId]]);
    expect(url.hash).toBe("");
  });
});
