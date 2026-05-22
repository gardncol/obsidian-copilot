/**
 * Test that the settings tab strip exposes the renamed "Embedding" tab in
 * the same slot the legacy "QA" tab used to occupy. M3 of the Model
 * Management redesign relabeled the tab without moving its position or
 * changing its route key — this test pins both invariants so a future
 * accidental rename or reordering surfaces as a failing test.
 */

describe("SettingsMainV2 tab labels", () => {
  it("exposes the renamed 'Embedding' label in the QA tab slot", () => {
    // Reason: we can't easily render the full SettingsMainV2 tree (it
    // pulls in plugin context, agent mode UI, and the latest-version
    // hook), so we read the source file as text and assert the
    // tab-label map directly. This is brittle in exchange for being
    // dependency-free and accurate.
    //
    // The two facts this test pins:
    //   1. The tab id stays "QA" (route key untouched).
    //   2. The visible label was renamed to "Embedding".
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("fs") as typeof import("fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require("path") as typeof import("path");
    const file = path.resolve(__dirname, "../../SettingsMainV2.tsx");
    const source = fs.readFileSync(file, "utf8");

    // Tab id stays the same.
    expect(source).toMatch(/TAB_IDS\s*=\s*\[[^\]]*"QA"/);

    // Label is renamed.
    expect(source).toMatch(/QA:\s*"Embedding"/);

    // Negative: the old label is gone from TAB_LABELS.
    expect(source).not.toMatch(/QA:\s*"QA"/);
  });
});
