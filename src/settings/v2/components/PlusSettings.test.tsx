import { render, screen } from "@testing-library/react";
import React from "react";
import { PlusSettings } from "./PlusSettings";

describe("PlusSettings", () => {
  beforeAll(() => {
    (window as unknown as { activeDocument: Document }).activeDocument = window.document;
  });

  describe("PlusSettings()", () => {
    it("renders the fork's agent-mode-unlocked notice instead of the license UI", () => {
      render(<PlusSettings />);

      expect(screen.getByText("Copilot Plus")).toBeTruthy();
      expect(screen.getByText(/agent mode unlocked/i)).toBeTruthy();
      expect(screen.getByText(/work with your own API key/i)).toBeTruthy();
    });

    it("does not render a license key input or pairing CTA", () => {
      render(<PlusSettings />);

      expect(screen.queryByRole("textbox")).toBeNull();
      expect(screen.queryByRole("button")).toBeNull();
      expect(screen.queryByText(/license key/i)).toBeNull();
    });
  });
});
