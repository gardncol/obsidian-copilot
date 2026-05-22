import {
  formatContextWindow,
  formatReleaseDate,
} from "@/modelManagement/ui/utils/formatModelMetadata";

describe("formatContextWindow", () => {
  it("formats million-scale token counts with one decimal, trimming trailing .0", () => {
    expect(formatContextWindow(1_500_000)).toBe("1.5M");
    expect(formatContextWindow(2_000_000)).toBe("2M");
    expect(formatContextWindow(1_000_000)).toBe("1M");
  });

  it("formats thousand-scale token counts as rounded `k`", () => {
    expect(formatContextWindow(200_000)).toBe("200k");
    expect(formatContextWindow(8_192)).toBe("8k");
    expect(formatContextWindow(1_000)).toBe("1k");
  });

  it("renders sub-thousand counts as plain numbers", () => {
    expect(formatContextWindow(512)).toBe("512");
    expect(formatContextWindow(1)).toBe("1");
  });

  it("returns null for missing or non-positive inputs", () => {
    expect(formatContextWindow(undefined)).toBeNull();
    expect(formatContextWindow(0)).toBeNull();
    expect(formatContextWindow(-5)).toBeNull();
  });
});

describe("formatReleaseDate", () => {
  it("formats valid ISO dates as `MMM YYYY`", () => {
    // Use mid-month dates so timezone shifts on the test runner can't pull
    // the result into the previous month (`2024-08-01` UTC → "Jul 2024" in
    // Pacific timezones, for example).
    expect(formatReleaseDate("2025-09-15")).toBe("Sep 2025");
    expect(formatReleaseDate("2024-08-15")).toBe("Aug 2024");
  });

  it("returns empty string for missing input", () => {
    expect(formatReleaseDate(undefined)).toBe("");
    expect(formatReleaseDate("")).toBe("");
  });

  it("falls back to the raw string when parsing fails", () => {
    expect(formatReleaseDate("not-a-date")).toBe("not-a-date");
  });
});
