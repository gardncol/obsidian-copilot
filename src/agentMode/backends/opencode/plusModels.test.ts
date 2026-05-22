/**
 * `plusModels` tests.
 *
 * Verifies that `listPlusModels` gates on `isPlusEnabled()` and otherwise
 * returns the hard-coded Plus model catalog.
 */
let plusEnabled = false;
jest.mock("@/plusUtils", () => ({
  isPlusEnabled: () => plusEnabled,
}));

jest.mock("@/logger", () => ({
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logError: jest.fn(),
}));

import { ChatModels } from "@/constants";
import { listPlusModels } from "./plusModels";

beforeEach(() => {
  plusEnabled = false;
});

describe("listPlusModels", () => {
  it("returns an empty list when the user is not on Plus", async () => {
    plusEnabled = false;
    expect(await listPlusModels()).toEqual([]);
  });

  it("returns the hard-coded Plus catalog when the user is on Plus", async () => {
    plusEnabled = true;
    const result = await listPlusModels();
    expect(result).toEqual([
      { id: ChatModels.COPILOT_PLUS_FLASH, displayName: "Copilot Plus Flash" },
    ]);
  });

  it("returns a fresh copy each call (callers can't mutate the canonical list)", async () => {
    plusEnabled = true;
    const a = await listPlusModels();
    const b = await listPlusModels();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
    a.push({ id: "x", displayName: "X" });
    const c = await listPlusModels();
    expect(c).toEqual([{ id: ChatModels.COPILOT_PLUS_FLASH, displayName: "Copilot Plus Flash" }]);
  });
});
