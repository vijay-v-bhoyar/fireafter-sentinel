import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateStoryboard } from "../../scripts/submission-storyboard.mjs";
const script = readFileSync("docs/SUBMISSION_PLAN.md", "utf8");
describe("Sentinel hackathon presentation contract", () => {
  it("uses one contiguous under-three-minute storyboard from the final submission owner", () => {
    const segments = validateStoryboard(script);
    expect(segments).toHaveLength(6);
    expect(segments[0].startSeconds).toBe(0);
    expect(segments.at(-1)?.endSeconds).toBe(170);
    expect(segments[1].narration).toContain("real provider execution separately from labeled replay");
    expect(segments[3].narration).toContain("confirmed server receipt");
    expect(segments[4].narration).toContain("original evidence");
    expect(segments[5].narration).toContain("actual sponsor usage and raw measured denominators");
  });
  it("rejects missing, duplicated, reordered and gapped segments", () => {
    expect(() => validateStoryboard(script.replace("| 0:00 | 0:20 |", "| 0:01 | 0:20 |"))).toThrow();
    expect(() => validateStoryboard(script.replace("| 0:20 | 0:50 |", "| 0:00 | 0:20 |"))).toThrow();
    expect(() => validateStoryboard(script.replace("| 0:50 | 1:30 |", "| 0:55 | 1:30 |"))).toThrow();
    expect(() => validateStoryboard(script + "\n<!-- sentinel-video-storyboard -->")).toThrow();
    expect(() => validateStoryboard(script.replace("<!-- /sentinel-video-storyboard -->", ""))).toThrow();
  });
  it("rejects three minutes exactly and an old five-minute presentation", () => {
    expect(() => validateStoryboard(script.replace("| 2:30 | 2:50 |", "| 2:30 | 3:00 |"))).toThrow();
    expect(() => validateStoryboard(script.replace("| 2:30 | 2:50 |", "| 2:30 | 5:00 |"))).toThrow();
  });
  it("rejects empty screen directions and preserves deliberate narration edits", () => {
    expect(() => validateStoryboard(script.replace("Chosen incident and mode", " "))).toThrow();
    expect(validateStoryboard(script.replace("Explain the coordinator problem", "Explain the changed coordinator problem"))[0].narration)
      .toContain("changed coordinator problem");
  });
  it("does not borrow old rehearsal results or imply runtime acceptance", () => {
    expect(script).toContain("actual captured footage and results remain pending");
    expect(script).toContain("Do not borrow FireAfter rehearsal counts");
    expect(script).toContain("baseline source imported locally");
    expect(script).toContain("no implemented Sentinel workflow");
  });
});
