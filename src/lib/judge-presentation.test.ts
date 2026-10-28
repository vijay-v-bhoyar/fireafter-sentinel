import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateStoryboard } from "../../scripts/submission-storyboard.mjs";
const script = readFileSync("docs/SUBMISSION_PLAN.md", "utf8");
describe("Sentinel hackathon presentation contract", () => {
  it("uses one contiguous under-three-minute storyboard from the final submission owner", () => {
    const segments = validateStoryboard(script);
    expect(segments).toHaveLength(7);
    expect(segments[0].startSeconds).toBe(0);
    expect(segments.at(-1)?.endSeconds).toBe(175);
    expect(segments[1].narration).toContain("labeled synthetic evidence");
    expect(segments[3].narration).toContain("confirmed server receipt");
    expect(segments[4].narration).toContain("original evidence");
    expect(segments[5].narration).toContain("standalone provider receipts");
    expect(segments[6].narration).toContain("inherited foundation");
  });
  it("rejects missing, duplicated, reordered and gapped segments", () => {
    expect(() => validateStoryboard(script.replace("| 0:00 | 0:20 |", "| 0:01 | 0:20 |"))).toThrow();
    expect(() => validateStoryboard(script.replace("| 0:20 | 0:50 |", "| 0:00 | 0:20 |"))).toThrow();
    expect(() => validateStoryboard(script.replace("| 0:50 | 1:20 |", "| 0:55 | 1:20 |"))).toThrow();
    expect(() => validateStoryboard(script + "\n<!-- sentinel-video-storyboard -->")).toThrow();
    expect(() => validateStoryboard(script.replace("<!-- /sentinel-video-storyboard -->", ""))).toThrow();
  });
  it("rejects three minutes exactly and an old five-minute presentation", () => {
    expect(() => validateStoryboard(script.replaceAll("2:55", "3:00"))).toThrow("under three minutes");
    expect(() => validateStoryboard(script.replaceAll("2:55", "5:00"))).toThrow("under three minutes");
  });
  it("rejects empty screen directions and preserves deliberate narration edits", () => {
    expect(() => validateStoryboard(script.replace("Chosen incident and mode", " "))).toThrow();
    expect(validateStoryboard(script.replace("Explain the coordinator problem", "Explain the changed coordinator problem"))[0].narration)
      .toContain("changed coordinator problem");
  });
  it("does not borrow old rehearsal results or imply runtime acceptance", () => {
    expect(script).toContain("actual captured footage and results remain pending");
    expect(script).toContain("Do not borrow FireAfter rehearsal counts");
    expect(script).toContain("Inherited FireAfter");
    expect(script).toContain("integrated persistent provider worker remains unqualified");
    expect(script).toContain("No completed recording exists yet");
    expect(script).not.toContain("Nemotron inference is still pending");
  });
  it("rejects a narration timeline that differs from the canonical storyboard", () => {
    expect(() => validateStoryboard(script.replace("### 0:50–1:20", "### 0:50–1:30")))
      .toThrow("headings must match");
    expect(() => validateStoryboard(script.replace("### 2:40–2:55", "#### 2:40–2:55")))
      .toThrow("headings must match");
  });
});
