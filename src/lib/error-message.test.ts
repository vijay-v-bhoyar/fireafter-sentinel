import { describe, expect, it } from "vitest";
import { errorMessage } from "./error-message";

describe("errorMessage", () => {
  it("extracts Supabase/PostgREST error object details", () => {
    expect(
      errorMessage(
        {
          message: "Could not find column",
          details: "Column assets.origin does not exist",
          hint: "Refresh schema cache",
          code: "PGRST204",
        },
        "Incident creation failed",
      ),
    ).toBe(
      "Could not find column Details: Column assets.origin does not exist Hint: Refresh schema cache Code: PGRST204",
    );
  });

  it("falls back when the thrown value has no readable message", () => {
    expect(errorMessage({ unexpected: true }, "Incident creation failed")).toBe(
      "Incident creation failed",
    );
  });
});
