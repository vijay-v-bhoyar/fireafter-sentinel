import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const featureCss = readFileSync(new URL("../components/feature-graph.module.css", import.meta.url), "utf8");
const workspace = css.split(".fireafter-workspace {")[1].split("}")[0];
const chrome = css.split(".fireafter-workspace .ops-chrome {")[1].split("}")[0];
function token(block: string, name: string) {
  const value = block.match(new RegExp(`${name}: (#[a-f0-9]{6});`))?.[1];
  if (!value) throw new Error(`Missing palette token ${name}`);
  return value;
}
function luminance(hex: string) {
  const rgb = hex.slice(1).match(/../g)!.map(channel => parseInt(channel, 16) / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
function contrast(a: string, b: string) {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}
it("scopes Tailwind discovery to app source rather than generated graphs and local artifacts", () => {
  expect(css).toContain('@import "tailwindcss" source("../");');
});
it("keeps feature-guide text readable on paper, active stages, and evidence badges", () => {
  const palette = featureCss.split(".workspace {")[1].split("}")[0];
  for (const name of ["--ink", "--muted", "--forest", "--ember"]) {
    expect(contrast(token(palette, name), token(palette, "--paper")), name).toBeGreaterThanOrEqual(4.5);
  }
  for (const [foreground, background] of [["#fffdf8", "#234737"], ["#27472b", "#e3eddf"],
    ["#734213", "#f7edd8"], ["#2c4a5c", "#e7edf1"], ["#543b24", "#f6eddc"]]) {
    expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5);
  }
});
it("keeps normal workspace and status text at WCAG AA contrast on paper surfaces", () => {
  for (const color of ["slate-100", "slate-200", "slate-300", "slate-400", "sky-200", "sky-300",
    "emerald-300", "amber-200", "orange-300", "red-400"]) {
    expect(contrast(token(workspace, `--color-${color}`), token(workspace, "--ops-panel")), color).toBeGreaterThanOrEqual(4.5);
  }
});
it("keeps navigation text readable on charcoal and badge text readable on saturated fills", () => {
  for (const color of ["slate-100", "slate-300", "slate-400", "emerald-300", "amber-300", "sky-300"]) {
    expect(contrast(token(chrome, `--color-${color}`), token(chrome, "--ops-inset")), color).toBeGreaterThanOrEqual(4.5);
  }
  for (const color of ["orange-500", "emerald-600", "sky-600"]) {
    expect(contrast("#ffffff", token(workspace, `--color-${color}`)), color).toBeGreaterThanOrEqual(4.5);
  }
});
