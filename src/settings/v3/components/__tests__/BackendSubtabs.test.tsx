/**
 * `BackendSubtabs` rendering + interaction tests.
 */
import { AGENT_BACKEND_TAB_ORDER, BackendSubtabs } from "@/settings/v3/components/BackendSubtabs";
import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";

describe("BackendSubtabs", () => {
  it("renders all four sub-tabs with Quick chat LAST", () => {
    render(<BackendSubtabs selectedTab="opencode" onSelectTab={() => {}} />);
    const order = AGENT_BACKEND_TAB_ORDER.map((t) => t.id);
    expect(order).toEqual(["opencode", "claude", "codex", "quickChat"]);
    const labels = order.map((id) => screen.getByTestId(`backend-subtab-${id}`).textContent ?? "");
    expect(labels.join("|")).toContain("OpenCode");
    expect(labels.join("|")).toContain("Claude Code");
    expect(labels.join("|")).toContain("Codex");
    expect(labels[labels.length - 1]).toContain("Quick chat");
  });

  it("marks the selected tab via aria-selected", () => {
    render(<BackendSubtabs selectedTab="quickChat" onSelectTab={() => {}} />);
    expect(screen.getByTestId("backend-subtab-quickChat").getAttribute("aria-selected")).toBe(
      "true"
    );
    expect(screen.getByTestId("backend-subtab-opencode").getAttribute("aria-selected")).toBe(
      "false"
    );
  });

  it("fires onSelectTab with the right id when a tab is clicked", () => {
    const onSelectTab = jest.fn();
    render(<BackendSubtabs selectedTab="opencode" onSelectTab={onSelectTab} />);
    fireEvent.click(screen.getByTestId("backend-subtab-quickChat"));
    expect(onSelectTab).toHaveBeenCalledWith("quickChat");
  });
});
