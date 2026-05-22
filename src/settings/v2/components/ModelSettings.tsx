import { Notice } from "obsidian";
import React, { useState } from "react";

import { CustomModel } from "@/aiParams";
import { SettingItem } from "@/components/ui/setting-item";
import { useApp } from "@/context";
import { BUILTIN_CHAT_MODELS } from "@/constants";
import ProjectManager from "@/LLMProviders/projectManager";
import { logError } from "@/logger";
import { setSettings, updateSetting, useSettingsValue } from "@/settings/model";
import { ModelAddDialog } from "@/settings/v2/components/ModelAddDialog";
import { ModelEditModal } from "@/settings/v2/components/ModelEditDialog";
import { ModelTable } from "@/settings/v2/components/ModelTable";
import { omit } from "@/utils";

/**
 * Chat-model registry settings. The embedding-model half previously lived
 * here too — as of M3 of the Model Management redesign it moved to the
 * renamed "Embedding" tab (see `EmbeddingModelsSection`). The remainder of
 * this file is slated for replacement in M4–M9 by the new BYOK panel under
 * `src/modelManagement/ui/tabs/ByokPanel.tsx`.
 */
export const ModelSettings: React.FC = () => {
  const app = useApp();
  const settings = useSettingsValue();
  const [showAddDialog, setShowAddDialog] = useState(false);

  /**
   * Duplicate a chat model — strips read-only / catalog-derived fields and
   * appends a `(copy)` suffix so the user can clone-and-tweak.
   */
  const onCopyModel = (model: CustomModel) => {
    const newModel: CustomModel = {
      ...omit(model, [
        "isBuiltIn",
        "core",
        "projectEnabled",
        "plusExclusive",
        "believerExclusive",
        "capabilities",
        "displayName",
        "dimensions",
      ]),
      name: `${model.name} (copy)`,
    };

    updateSetting("activeModels", [...settings.activeModels, newModel]);
  };

  /**
   * Persist a reordered chat model list (drag handle in `ModelTable`).
   */
  const handleModelReorder = (newModels: CustomModel[]) => {
    updateSetting("activeModels", newModels);
  };

  const onDeleteModel = (modelKey: string) => {
    const [modelName, provider] = modelKey.split("|");
    const updatedActiveModels = settings.activeModels.filter(
      (model) => !(model.name === modelName && model.provider === provider)
    );

    // If the deleted model was the configured default, fall back to the
    // first remaining enabled model — or clear the default if none survive.
    const currentRef = settings.defaultModelRef;
    let newDefaultModelRef = currentRef;
    if (currentRef && currentRef.modelId === modelName && currentRef.providerId === provider) {
      const newDefaultModel = updatedActiveModels.find((model) => model.enabled);
      newDefaultModelRef = newDefaultModel
        ? { providerId: newDefaultModel.provider, modelId: newDefaultModel.name }
        : null;
    }

    setSettings({
      activeModels: updatedActiveModels,
      defaultModelRef: newDefaultModelRef,
    });
  };

  /**
   * Edits originating from `ModelEditModal`. `originalModel` is needed
   * because the dialog may rename the model.
   */
  const handleModelUpdate = (originalModel: CustomModel, updatedModel: CustomModel) => {
    const modelIndex = settings.activeModels.findIndex(
      (m) => m.name === originalModel.name && m.provider === originalModel.provider
    );
    if (modelIndex !== -1) {
      const updatedModels = [...settings.activeModels];
      updatedModels[modelIndex] = updatedModel;
      updateSetting("activeModels", updatedModels);
    } else {
      new Notice("Could not find model to update");
      logError("Could not find model to update:", originalModel);
    }
  };

  // Handler for updates originating from the ModelTable itself (e.g., checkbox toggles)
  const handleTableUpdate = (updatedModel: CustomModel) => {
    const updatedModels = settings.activeModels.map((m) =>
      m.name === updatedModel.name && m.provider === updatedModel.provider ? updatedModel : m
    );
    updateSetting("activeModels", updatedModels);
  };

  const handleRefreshChatModels = () => {
    // Get all custom models (non-built-in models)
    const customModels = settings.activeModels.filter((model) => !model.isBuiltIn);

    // Create a new array with built-in models and custom models
    const updatedModels = [...BUILTIN_CHAT_MODELS, ...customModels];

    // Update the settings
    updateSetting("activeModels", updatedModels);
    new Notice("Chat models refreshed successfully");
  };

  const handleEditModel = (model: CustomModel) => {
    const modal = new ModelEditModal(app, model, /* isEmbeddingModel */ false, handleModelUpdate);
    modal.open();
  };

  return (
    <div className="tw-space-y-4">
      <section>
        <ModelTable
          models={settings.activeModels}
          onEdit={handleEditModel}
          onCopy={onCopyModel}
          onDelete={onDeleteModel}
          onAdd={() => setShowAddDialog(true)}
          onUpdateModel={handleTableUpdate}
          onReorderModels={handleModelReorder}
          onRefresh={handleRefreshChatModels}
          title="Chat Models"
        />

        {/* model add dialog */}
        <ModelAddDialog
          open={showAddDialog}
          onOpenChange={setShowAddDialog}
          onAdd={(model) => {
            const updatedModels = [...settings.activeModels, model];
            updateSetting("activeModels", updatedModels);
          }}
          ping={(model) =>
            ProjectManager.instance.getCurrentChainManager().chatModelManager.ping(model)
          }
        />

        <div className="tw-space-y-4">
          <SettingItem
            type="slider"
            title="Conversation turns in context"
            description="The number of previous conversation turns to include in the context. Default is 15 turns, i.e. 30 messages."
            value={settings.contextTurns}
            onChange={(value) => updateSetting("contextTurns", value)}
            min={1}
            max={50}
            step={1}
          />
          <SettingItem
            type="slider"
            title="Auto-compact threshold"
            description="Automatically summarize context when it exceeds this token count. Set to maximum to make it less aggressive."
            min={64000}
            max={1000000}
            step={64000}
            value={settings.autoCompactThreshold}
            onChange={(value) => updateSetting("autoCompactThreshold", value)}
          />
        </div>
      </section>
    </div>
  );
};
