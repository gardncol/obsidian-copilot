import {
  CustomModel,
  getChainType,
  getCurrentProject,
  getModelKey,
  SetChainOptions,
} from "@/aiParams";
import { ChainType } from "@/chainType";
import { BUILTIN_CHAT_MODELS, USER_SENDER } from "@/constants";
import {
  AutonomousAgentChainRunner,
  ChainRunner,
  CopilotPlusChainRunner,
  LLMChainRunner,
  ProjectChainRunner,
  VaultQAChainRunner,
} from "@/LLMProviders/chainRunner/index";
import { logError, logInfo } from "@/logger";
import { getSettings, subscribeToSettingsChange } from "@/settings/model";
import { getSystemPrompt } from "@/system-prompts/systemPromptBuilder";
import { ChatMessage } from "@/types/message";
import { findCustomModel } from "@/utils";
import { ModelRegistry } from "@/modelManagement";
import { isOpenAIOSeries } from "@/modelManagement/providers/adapters/adapterUtils";
import { MissingModelKeyError } from "@/error";
import {
  ChatPromptTemplate,
  HumanMessagePromptTemplate,
  MessagesPlaceholder,
} from "@langchain/core/prompts";
import { Document } from "@langchain/core/documents";
import { App, Notice } from "obsidian";
import ChatModelManager from "./ChatModelManager";
import MemoryManager from "./memoryManager";
import PromptManager from "./promptManager";
import { UserMemoryManager } from "@/memory/UserMemoryManager";

export default class ChainManager {
  private retrievedDocuments: Document[] = [];

  public getRetrievedDocuments(): Document[] {
    return this.retrievedDocuments;
  }

  public app: App;
  public chatModelManager: ChatModelManager;
  public memoryManager: MemoryManager;
  public promptManager: PromptManager;
  public userMemoryManager: UserMemoryManager;
  private pendingModelError: Error | null = null;

  constructor(app: App) {
    // Instantiate singletons
    this.app = app;
    this.memoryManager = MemoryManager.getInstance();
    // ChatModelManager is per-instance — every chain owns its own so two
    // chains can hold different active models without contending on shared
    // state. The static getInstance() shim returns a fresh instance, so
    // pre-existing tests that mock it keep working.
    this.chatModelManager = new ChatModelManager();
    this.promptManager = PromptManager.getInstance();
    this.userMemoryManager = new UserMemoryManager(app);

    // Initialize async operations
    void this.initialize().catch((err) => logError("ChainManager initialize failed", err));

    subscribeToSettingsChange(() => {
      void this.createChainWithNewModel().catch((err) =>
        logError("createChainWithNewModel failed", err)
      );
    });
  }

  private async initialize() {
    await this.createChainWithNewModel();
  }

  private validateChainType(chainType: ChainType): void {
    if (chainType === undefined || chainType === null) throw new Error("No chain type set");
  }

  private validateChatModel() {
    if (this.pendingModelError) {
      throw this.pendingModelError;
    }

    if (!this.chatModelManager.validateChatModel(this.chatModelManager.getChatModel())) {
      const errorMsg =
        "Chat model is not initialized properly, check your API key in Copilot setting and make sure you have API access.";
      throw new MissingModelKeyError(errorMsg);
    }
  }

  public storeRetrieverDocuments(documents: Document[]) {
    this.retrievedDocuments = documents;
  }

  /**
   * Update the active model and create a new chain with the specified model
   * name.
   */
  async createChainWithNewModel(
    options: SetChainOptions = {},
    neededReInitChatMode: boolean = true
  ): Promise<void> {
    let newModelKey: string | undefined;
    const chainType = getChainType();
    const currentProject = getCurrentProject();

    if (chainType === ChainType.PROJECT_CHAIN && !currentProject) {
      return;
    }

    try {
      newModelKey =
        chainType === ChainType.PROJECT_CHAIN ? currentProject?.projectModelKey : getModelKey();

      if (!newModelKey) {
        throw new MissingModelKeyError("No model key found. Please select a model in settings.");
      }

      if (neededReInitChatMode) {
        // Primary resolution: consult the BYOK registry. Registry entries are
        // the post-M9 source of truth for "which models are available". The
        // `CustomModel` lookup below is a transitional bridge — adapters
        // still read per-model runtime data off `CustomModel` (baseUrl,
        // azureDeployment, …) until Task #2 collapses that slice into
        // `RegistryEntry.extra`.
        const sepIndex = newModelKey.lastIndexOf("|");
        const parsedModelId =
          sepIndex > 0 && sepIndex < newModelKey.length - 1 ? newModelKey.slice(0, sepIndex) : null;
        const parsedProviderId =
          sepIndex > 0 && sepIndex < newModelKey.length - 1
            ? newModelKey.slice(sepIndex + 1)
            : null;
        const registryEntry =
          parsedProviderId && parsedModelId
            ? ModelRegistry.getInstance().get(parsedProviderId, parsedModelId)
            : undefined;

        let customModel: CustomModel | undefined;
        try {
          customModel = findCustomModel(newModelKey, getSettings().activeModels);
        } catch {
          customModel = undefined;
        }

        // If neither the registry nor `activeModels` knows about the key,
        // reset to a built-in default. The registry is consulted first so
        // a model that lives only in the new shape (no `CustomModel` row,
        // post-Task #2) won't trigger the fallback.
        if (!customModel) {
          if (registryEntry) {
            // Synthesize a minimal `CustomModel` view so downstream code that
            // still expects this shape continues working. Runtime data
            // (`apiKey`, `baseUrl`, …) is read from `settings.providers[id]`
            // by the adapters; this shim only needs `name` + `provider`.
            customModel = {
              name: registryEntry.modelId,
              provider: registryEntry.providerId,
              enabled: true,
            };
          } else {
            console.error(
              "Resetting default model. No model configuration found for: ",
              newModelKey
            );
            customModel = BUILTIN_CHAT_MODELS[0];
            newModelKey = customModel.name + "|" + customModel.provider;
          }
        }

        // Add validation for project mode
        if (chainType === ChainType.PROJECT_CHAIN && !customModel.projectEnabled) {
          // If the model is not project-enabled, find the first project-enabled model
          const projectEnabledModel = getSettings().activeModels.find(
            (m) => m.enabled && m.projectEnabled
          );
          if (projectEnabledModel) {
            customModel = projectEnabledModel;
            newModelKey = projectEnabledModel.name + "|" + projectEnabledModel.provider;
            new Notice(
              `Model ${customModel.name} is not available in project mode. Switching to ${projectEnabledModel.name}.`
            );
          } else {
            throw new Error(
              "No project-enabled models available. Please enable a model for project mode in settings."
            );
          }
        }

        const mergedModel = {
          ...customModel,
          ...currentProject?.modelConfigs,
        };
        await this.chatModelManager.setChatModel(mergedModel);
        this.pendingModelError = null;
      }

      // Chain-type housekeeping. Do NOT write `chainType` back to the atom —
      // the atom is owned by the UI dropdowns and `applyPlusSettings`. The
      // captured local `chainType` may already be stale by the time we reach
      // here (we just awaited `setChatModel(...)`), and writing it back used
      // to create a self-sustaining `setChainType` → ProjectManager
      // subscriber → `createChainWithNewModel` loop that froze Obsidian on
      // apply-Plus-key.
      if (this.chatModelManager.validateChatModel(this.chatModelManager.getChatModel())) {
        this.validateChainType(chainType);
        if (options.refreshIndex) {
          await this.refreshVaultIndex();
        }
      } else {
        console.error(
          "createChainWithNewModel: skipping chain-type housekeeping — no chat model set."
        );
      }
      logInfo(`Setting model to ${newModelKey}`);
    } catch (error) {
      this.pendingModelError = error instanceof Error ? error : new Error(String(error));
      logError(`createChainWithNewModel failed: ${error}`);
      logInfo(`modelKey: ${newModelKey || getModelKey()}`);
    }
  }

  private getChainRunner(): ChainRunner {
    const chainType = getChainType();
    const settings = getSettings();

    switch (chainType) {
      case ChainType.LLM_CHAIN:
        return new LLMChainRunner(this);
      case ChainType.VAULT_QA_CHAIN:
        return new VaultQAChainRunner(this);
      case ChainType.COPILOT_PLUS_CHAIN:
        // Use AutonomousAgentChainRunner if the setting is enabled
        if (settings.enableAutonomousAgent) {
          return new AutonomousAgentChainRunner(this);
        }
        return new CopilotPlusChainRunner(this);
      case ChainType.PROJECT_CHAIN:
        return new ProjectChainRunner(this);
      default:
        throw new Error(`Unsupported chain type: ${String(chainType)}`);
    }
  }

  /**
   * Re-index the vault into the Orama vector store. No-op when legacy
   * semantic search is disabled — v3 lexical search builds its index on
   * demand and doesn't need a precomputed store.
   */
  private async refreshVaultIndex() {
    if (!getSettings().enableSemanticSearchV3) return;
    const VectorStoreManager = (await import("@/search/vectorStoreManager")).default;
    await VectorStoreManager.getInstance().indexVaultToVectorStore(false);
  }

  async runChain(
    userMessage: ChatMessage,
    abortController: AbortController,
    updateCurrentAiMessage: (message: string) => void,
    addMessage: (message: ChatMessage) => void,
    options: {
      debug?: boolean;
      ignoreSystemMessage?: boolean;
      updateLoading?: (loading: boolean) => void;
    } = {}
  ) {
    const { ignoreSystemMessage = false } = options;

    const l5Text = userMessage.contextEnvelope?.layers.find((l) => l.id === "L5_USER")?.text;
    logInfo(
      "Step 0: Initial user message:\n",
      l5Text || userMessage.originalMessage || userMessage.message
    );

    this.validateChatModel();

    const chatModel = this.chatModelManager.getChatModel();
    const chatModelName = extractChatModelName(chatModel);
    const isOSeries = chatModelName ? isOpenAIOSeries(chatModelName) : false;

    // Handle ignoreSystemMessage
    if (ignoreSystemMessage || isOSeries) {
      let effectivePrompt = ChatPromptTemplate.fromMessages([
        new MessagesPlaceholder("history"),
        HumanMessagePromptTemplate.fromTemplate("{input}"),
      ]);

      // TODO: hack for o-series models, to be removed when langchainjs supports system prompt
      // https://github.com/langchain-ai/langchain/issues/28895
      if (isOSeries) {
        effectivePrompt = ChatPromptTemplate.fromMessages([
          [USER_SENDER, getSystemPrompt() || ""],
          effectivePrompt,
        ]);
      }

      void this.createChainWithNewModel({ prompt: effectivePrompt }, false).catch((err) =>
        logError("createChainWithNewModel failed", err)
      );
      /*this.setChain(getChainType(), {
        prompt: effectivePrompt,
      });*/
    }

    const chainRunner = this.getChainRunner();
    return await chainRunner.run(
      userMessage,
      abortController,
      updateCurrentAiMessage,
      addMessage,
      options
    );
  }
}

/**
 * Extracts the model id string from a LangChain `BaseChatModel`-shaped
 * instance. Different clients store the id under `modelName` or `model`;
 * neither is part of the published `BaseChatModel` type so we read them
 * defensively. Returns `undefined` when the model is unavailable or
 * neither field is populated.
 */
function extractChatModelName(model: unknown): string | undefined {
  if (!model || typeof model !== "object") return undefined;
  const m = model as Record<string, unknown>;
  const name = (m.modelName as string) || (m.model as string);
  return typeof name === "string" && name.length > 0 ? name : undefined;
}
