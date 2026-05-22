import { Notice } from "obsidian";
import React, { useState } from "react";

import { CustomModel } from "@/aiParams";
import { useApp } from "@/context";
import { BUILTIN_EMBEDDING_MODELS } from "@/constants";
import EmbeddingManager from "@/LLMProviders/embeddingManager";
import { CopilotSettings, updateSetting, useSettingsValue } from "@/settings/model";
import { ModelAddDialog } from "@/settings/v2/components/ModelAddDialog";
import { ModelEditModal } from "@/settings/v2/components/ModelEditDialog";
import { ModelTable } from "@/settings/v2/components/ModelTable";
import { omit } from "@/utils";

/**
 * Embedding model registry section. Extracted from `ModelSettings.tsx` as
 * part of the Model Management redesign (M3): the embedding-model UI moved
 * out of the deprecated "Model" tab and into the renamed "Embedding" tab
 * (previously "QA"). Behavior is identical to the prior embedding half of
 * `ModelSettings.tsx` — `activeEmbeddingModels` is the source of truth, and
 * add / edit / copy / delete / reorder / refresh all delegate to the same
 * shared dialogs and `ModelTable` used by chat models.
 */
export const EmbeddingModelsSection: React.FC = () => {
  const app = useApp();
  const settings = useSettingsValue();
  const [showAddEmbeddingDialog, setShowAddEmbeddingDialog] = useState(false);

  /**
   * Duplicate an embedding model — strips read-only / catalog-derived fields
   * and appends a `(copy)` suffix so the user can clone-and-tweak.
   */
  const onCopyEmbeddingModel = (model: CustomModel) => {
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

    const settingField: keyof CopilotSettings = "activeEmbeddingModels";
    updateSetting(settingField, [...settings[settingField], newModel]);
  };

  /**
   * Persist a reordered embedding model list (drag handle in `ModelTable`).
   */
  const handleEmbeddingModelReorder = (newModels: CustomModel[]) => {
    updateSetting("activeEmbeddingModels", newModels);
  };

  /**
   * Remove an embedding model by its `name|provider` key.
   */
  const onDeleteEmbeddingModel = (modelKey: string) => {
    const [modelName, provider] = modelKey.split("|");
    const updatedModels = settings.activeEmbeddingModels.filter(
      (model) => !(model.name === modelName && model.provider === provider)
    );
    updateSetting("activeEmbeddingModels", updatedModels);
  };

  /**
   * In-table edits (checkbox toggles, etc.) from `ModelTable`.
   */
  const handleEmbeddingModelTableUpdate = (updatedModel: CustomModel) => {
    const updatedModels = settings.activeEmbeddingModels.map((m) =>
      m.name === updatedModel.name && m.provider === updatedModel.provider ? updatedModel : m
    );
    updateSetting("activeEmbeddingModels", updatedModels);
  };

  /**
   * Edits originating from `ModelEditModal` (the per-row config dialog).
   * `originalModel` is needed because the dialog may rename the model.
   */
  const handleEmbeddingModelUpdate = (originalModel: CustomModel, updatedModel: CustomModel) => {
    const updatedModels = settings.activeEmbeddingModels.map((m) =>
      m.name === originalModel.name && m.provider === originalModel.provider ? updatedModel : m
    );
    updateSetting("activeEmbeddingModels", updatedModels);
  };

  /**
   * Restore the built-in embedding catalog while preserving any user-added
   * custom embedding models.
   */
  const handleRefreshEmbeddingModels = () => {
    const customModels = settings.activeEmbeddingModels.filter((model) => !model.isBuiltIn);
    const updatedModels = [...BUILTIN_EMBEDDING_MODELS, ...customModels];
    updateSetting("activeEmbeddingModels", updatedModels);
    new Notice("Embedding models refreshed successfully");
  };

  /**
   * Open the per-row edit dialog with `isEmbeddingModel = true` so the
   * dialog renders the embedding-specific subset of fields.
   */
  const handleEditEmbeddingModel = (model: CustomModel) => {
    const modal = new ModelEditModal(
      app,
      model,
      /* isEmbeddingModel */ true,
      handleEmbeddingModelUpdate
    );
    modal.open();
  };

  return (
    <section>
      <ModelTable
        models={settings.activeEmbeddingModels}
        onEdit={handleEditEmbeddingModel}
        onDelete={onDeleteEmbeddingModel}
        onCopy={onCopyEmbeddingModel}
        onAdd={() => setShowAddEmbeddingDialog(true)}
        onUpdateModel={handleEmbeddingModelTableUpdate}
        onReorderModels={handleEmbeddingModelReorder}
        onRefresh={handleRefreshEmbeddingModels}
        title="Embedding Models"
      />

      {/* Embedding model add dialog */}
      <ModelAddDialog
        open={showAddEmbeddingDialog}
        onOpenChange={setShowAddEmbeddingDialog}
        onAdd={(model) => {
          const updatedModels = [...settings.activeEmbeddingModels, model];
          updateSetting("activeEmbeddingModels", updatedModels);
        }}
        isEmbeddingModel={true}
        ping={(model) => EmbeddingManager.getInstance().ping(model)}
      />
    </section>
  );
};
