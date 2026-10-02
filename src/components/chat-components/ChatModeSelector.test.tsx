import { ChainType } from "@/chainType";
import { ChatModeSelector } from "@/components/chat-components/ChatModeSelector";
import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";

describe("ChatModeSelector", () => {
  beforeAll(() => {
    (window as unknown as { activeDocument: Document }).activeDocument = window.document;
    if (!("PointerEvent" in window)) {
      (window as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent = MouseEvent;
    }
    Element.prototype.hasPointerCapture = () => false;
    Element.prototype.releasePointerCapture = () => {};
    Element.prototype.scrollIntoView = () => {};
  });

  describe("ChatModeSelector()", () => {
    it("offers free chat and agent mode without any license gate", () => {
      const onModeChange = jest.fn();
      const onPlusUpsell = jest.fn();
      render(
        <ChatModeSelector
          selectedChain={ChainType.LLM_CHAIN}
          onModeChange={onModeChange}
          defaultOpen
        />
      );

      expect(screen.getAllByText("chat (free)")).toHaveLength(2);
      expect(screen.getByText("agent mode")).toBeTruthy();
      expect(screen.queryByText(/copilot plus/i)).toBeNull();

      fireEvent.click(screen.getByText("agent mode"));
      expect(onModeChange).toHaveBeenCalledWith(ChainType.COPILOT_PLUS_CHAIN);
      expect(onPlusUpsell).not.toHaveBeenCalled();
    });

    it("switches from agent mode back to free chat", () => {
      const onModeChange = jest.fn();
      render(
        <ChatModeSelector
          selectedChain={ChainType.COPILOT_PLUS_CHAIN}
          onModeChange={onModeChange}
          defaultOpen
        />
      );

      fireEvent.click(screen.getByText("chat (free)"));
      expect(onModeChange).toHaveBeenCalledWith(ChainType.LLM_CHAIN);
    });
  });
});
