/**
 * `AddCustomModelDialog` tests — verifies the trimmed field set.
 */
import { AddCustomModelDialog } from "@/modelManagement/ui/dialogs/AddCustomModelDialog";
import type { ProviderConfig } from "@/modelManagement/types";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";

jest.mock("@/logger", () => ({
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logError: jest.fn(),
}));

beforeAll(() => {
  (window as unknown as { activeDocument: Document }).activeDocument = window.document;
});

function makeProvider(): ProviderConfig {
  return {
    id: "anthropic",
    kind: "builtin",
    displayName: "Anthropic",
    type: "anthropic",
    addedAt: 1,
  };
}

describe("AddCustomModelDialog", () => {
  it("renders only Display name / Model ID fields", () => {
    render(
      <AddCustomModelDialog
        open={true}
        onOpenChange={jest.fn()}
        provider={makeProvider()}
        onTest={jest.fn().mockResolvedValue(undefined)}
        onAdd={jest.fn()}
      />
    );

    expect(screen.getByTestId("add-custom-model-display-name")).toBeTruthy();
    expect(screen.getByTestId("add-custom-model-id")).toBeTruthy();

    // No context window field.
    expect(screen.queryByTestId("add-custom-model-context")).toBeNull();
    // No capability checkbox/group rendered.
    expect(screen.queryByText(/vision/i)).toBeNull();
    expect(screen.queryByText(/reasoning/i)).toBeNull();
    expect(screen.queryByText(/tool use/i)).toBeNull();
  });

  it("disables [Add] until display name + model id are filled", () => {
    render(
      <AddCustomModelDialog
        open={true}
        onOpenChange={jest.fn()}
        provider={makeProvider()}
        onTest={jest.fn().mockResolvedValue(undefined)}
        onAdd={jest.fn()}
      />
    );

    const addBtn = screen.getByTestId("add-custom-model-add");
    expect((addBtn as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByTestId("add-custom-model-display-name"), {
      target: { value: "Custom Preview" },
    });
    fireEvent.change(screen.getByTestId("add-custom-model-id"), {
      target: { value: "claude-sonnet-preview" },
    });

    expect((addBtn as HTMLButtonElement).disabled).toBe(false);
  });

  it("calls onAdd with the trimmed identifiers", async () => {
    const onAdd = jest.fn();
    const onOpenChange = jest.fn();
    render(
      <AddCustomModelDialog
        open={true}
        onOpenChange={onOpenChange}
        provider={makeProvider()}
        onTest={jest.fn().mockResolvedValue(undefined)}
        onAdd={onAdd}
      />
    );

    fireEvent.change(screen.getByTestId("add-custom-model-display-name"), {
      target: { value: "Custom Preview" },
    });
    fireEvent.change(screen.getByTestId("add-custom-model-id"), {
      target: { value: "claude-sonnet-preview" },
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("add-custom-model-add"));
    });

    expect(onAdd).toHaveBeenCalledWith({
      providerId: "anthropic",
      modelId: "claude-sonnet-preview",
      displayName: "Custom Preview",
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("surfaces test success and failure inline", async () => {
    const onTest = jest
      .fn<Promise<void>, [string]>()
      .mockRejectedValueOnce(new Error("404 model not found"))
      .mockResolvedValueOnce(undefined);

    render(
      <AddCustomModelDialog
        open={true}
        onOpenChange={jest.fn()}
        provider={makeProvider()}
        onTest={onTest}
        onAdd={jest.fn()}
      />
    );

    fireEvent.change(screen.getByTestId("add-custom-model-id"), {
      target: { value: "bad-id" },
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("add-custom-model-test"));
    });
    await waitFor(() => expect(screen.getByTestId("add-custom-model-error")).toBeTruthy());
    expect(screen.getByTestId("add-custom-model-error").textContent).toContain(
      "404 model not found"
    );

    fireEvent.change(screen.getByTestId("add-custom-model-id"), {
      target: { value: "good-id" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("add-custom-model-test"));
    });
    await waitFor(() => expect(screen.getByTestId("add-custom-model-success")).toBeTruthy());
  });
});
