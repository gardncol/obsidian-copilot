/**
 * `AddCustomModelDialog` — add a one-off model under an existing provider.
 *
 * Layout:
 *
 *   [An] Add custom model · under Anthropic                       ✕
 *   Display name      [Claude Sonnet 4.5 (preview)         ]
 *   Model ID          [claude-sonnet-4-5-20260601-preview ]   [Test]
 *                                                  [Cancel] [Add]
 *
 * `[Test]` pings the provider's API with the entered model id; success → ✓,
 * failure → ⚠ + inline error. `[Add]` calls `onAdd(...)` with the assembled
 * registry entry and the parent dialog re-renders to show the new row as
 * already-checked.
 */
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { useTabOptional } from "@/contexts/TabContext";
import { logError } from "@/logger";
import type { ProviderConfig, RegistryEntry } from "@/modelManagement/types";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import React, { useState } from "react";

export interface AddCustomModelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The parent provider context — drives the title and pings. */
  provider: ProviderConfig;
  /**
   * Test the (provider, modelId) combination. Rejects on failure. The
   * caller controls how to ping (e.g. via `ChatModelManager.ping`).
   */
  onTest: (modelId: string) => Promise<void>;
  /**
   * Called when the user clicks `[Add]` after filling the form. The
   * `addedAt` field is added by `ModelRegistry.add` so callers may omit it
   * when assembling the entry.
   */
  onAdd: (entry: Omit<RegistryEntry, "addedAt">) => void | Promise<void>;
}

/**
 * `AddCustomModelDialog` — see file header comment.
 */
export const AddCustomModelDialog: React.FC<AddCustomModelDialogProps> = ({
  open,
  onOpenChange,
  provider,
  onTest,
  onAdd,
}) => {
  const modalContainer = useTabOptional()?.modalContainer ?? null;
  const [displayName, setDisplayName] = useState("");
  const [modelId, setModelId] = useState("");
  const [testState, setTestState] = useState<
    | { kind: "idle" }
    | { kind: "testing" }
    | { kind: "success" }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  const reset = (): void => {
    setDisplayName("");
    setModelId("");
    setTestState({ kind: "idle" });
  };

  const handleOpenChange = (next: boolean): void => {
    if (!next) reset();
    onOpenChange(next);
  };

  const trimmedModelId = modelId.trim();
  const trimmedDisplayName = displayName.trim();
  const canAdd = trimmedModelId.length > 0 && trimmedDisplayName.length > 0;

  const handleTest = async (): Promise<void> => {
    if (!trimmedModelId) return;
    setTestState({ kind: "testing" });
    try {
      await onTest(trimmedModelId);
      setTestState({ kind: "success" });
    } catch (err) {
      logError("[AddCustomModelDialog] Test failed:", err);
      const message = err instanceof Error ? err.message : String(err);
      setTestState({ kind: "error", message });
    }
  };

  const handleAdd = async (): Promise<void> => {
    if (!canAdd) return;
    const entry: Omit<RegistryEntry, "addedAt"> = {
      providerId: provider.id,
      modelId: trimmedModelId,
      displayName: trimmedDisplayName,
    };
    await onAdd(entry);
    reset();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="tw-max-h-[80vh] tw-overflow-y-auto sm:tw-max-w-[480px]"
        container={modalContainer}
        data-testid="add-custom-model-dialog"
      >
        <DialogHeader>
          <DialogTitle>Add custom model · under {provider.displayName}</DialogTitle>
          <DialogDescription>
            Use this for preview models, fine-tunes, private deployments, or anything not in the
            catalog. Provider connection (key, base URL) is reused.
          </DialogDescription>
        </DialogHeader>

        <div className="tw-flex tw-flex-col tw-gap-3">
          <FormField label="Display name">
            <Input
              type="text"
              placeholder="Claude Sonnet 4.5 (preview)"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              data-testid="add-custom-model-display-name"
            />
          </FormField>

          <FormField label="Model ID">
            <div className="tw-flex tw-gap-2">
              <Input
                type="text"
                placeholder="claude-sonnet-4-5-20260601-preview"
                value={modelId}
                onChange={(e) => {
                  setModelId(e.target.value);
                  // Edits invalidate the previous test outcome.
                  setTestState({ kind: "idle" });
                }}
                className="tw-flex-1"
                data-testid="add-custom-model-id"
              />
              <Button
                variant="secondary"
                size="sm"
                onClick={handleTest}
                disabled={!trimmedModelId || testState.kind === "testing"}
                data-testid="add-custom-model-test"
              >
                {testState.kind === "testing" ? (
                  <>
                    <Loader2 className="tw-size-3.5 tw-animate-spin" />
                    Test
                  </>
                ) : (
                  "Test"
                )}
              </Button>
            </div>
          </FormField>

          {testState.kind === "success" && (
            <div
              className="tw-flex tw-items-center tw-gap-2 tw-text-sm tw-text-success"
              data-testid="add-custom-model-success"
            >
              <CheckCircle2 className="tw-size-4" />
              Test succeeded.
            </div>
          )}
          {testState.kind === "error" && (
            <div
              className="tw-flex tw-items-start tw-gap-2 tw-text-sm tw-text-error"
              data-testid="add-custom-model-error"
            >
              <XCircle className="tw-mt-0.5 tw-size-4 tw-shrink-0" />
              <span className="tw-break-words">{testState.message}</span>
            </div>
          )}
        </div>

        <div className="tw-flex tw-items-center tw-justify-end tw-gap-2">
          <Button variant="secondary" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="default"
            onClick={handleAdd}
            disabled={!canAdd}
            data-testid="add-custom-model-add"
          >
            Add
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

AddCustomModelDialog.displayName = "AddCustomModelDialog";
