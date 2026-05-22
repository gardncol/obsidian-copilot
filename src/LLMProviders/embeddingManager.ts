import { CustomModel } from "@/aiParams";
import { BREVILABS_MODELS_BASE_URL, EmbeddingModelProviders, ProviderInfo } from "@/constants";
import { getDecryptedKey } from "@/encryptionService";
import { CustomError } from "@/error";
import { logInfo } from "@/logger";
import { getProviderApiKeySync, ProviderRegistry } from "@/modelManagement";
import { getModelKeyFromModel, getSettings, subscribeToSettingsChange } from "@/settings/model";
import { err2String, safeFetch } from "@/utils";
import { Embeddings } from "@langchain/core/embeddings";
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { OllamaEmbeddings } from "@langchain/ollama";
import { AzureOpenAIEmbeddings, OpenAIEmbeddings } from "@langchain/openai";
import { Notice } from "obsidian";
import { BrevilabsClient } from "./brevilabsClient";
import { CustomJinaEmbeddings } from "./CustomJinaEmbeddings";
import { CustomOpenAIEmbeddings } from "./CustomOpenAIEmbeddings";

/**
 * Maps `EmbeddingModelProviders` enum values to canonical `ProviderRegistry`
 * provider ids. Local providers and Copilot-Plus pseudo-providers fall back
 * to their respective dedicated credentials in `resolveDefaultApiKey`.
 */
const EMBEDDING_PROVIDER_TO_REGISTRY_ID: Partial<Record<EmbeddingModelProviders, string>> = {
  [EmbeddingModelProviders.OPENAI]: "openai",
  [EmbeddingModelProviders.COHEREAI]: "cohere",
  [EmbeddingModelProviders.GOOGLE]: "google",
  [EmbeddingModelProviders.AZURE_OPENAI]: "azure",
  [EmbeddingModelProviders.SILICONFLOW]: "siliconflow",
  [EmbeddingModelProviders.OPENROUTERAI]: "openrouter",
};

/** Resolve a default API key for an embedding provider via `ProviderRegistry`. */
function resolveDefaultEmbeddingApiKey(provider: EmbeddingModelProviders): string {
  switch (provider) {
    case EmbeddingModelProviders.COPILOT_PLUS:
    case EmbeddingModelProviders.COPILOT_PLUS_JINA:
      return getSettings().plusLicenseKey ?? "";
    case EmbeddingModelProviders.OLLAMA:
    case EmbeddingModelProviders.LM_STUDIO:
    case EmbeddingModelProviders.OPENAI_FORMAT:
      return "default-key";
    default: {
      const registryId = EMBEDDING_PROVIDER_TO_REGISTRY_ID[provider];
      if (!registryId) return "";
      return getProviderApiKeySync(registryId) ?? "";
    }
  }
}

/** Read a string extras field from the OpenAI / Azure provider registry entry. */
function getAzureExtra(
  field: "azureInstanceName" | "azureDeploymentName" | "azureApiVersion"
): string | undefined {
  const provider = ProviderRegistry.getInstance().get("azure");
  const value = provider?.extra?.[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

type EmbeddingConstructorType = new (config: Record<string, unknown>) => Embeddings;

const EMBEDDING_PROVIDER_CONSTRUCTORS = {
  [EmbeddingModelProviders.COPILOT_PLUS]: CustomOpenAIEmbeddings,
  [EmbeddingModelProviders.COPILOT_PLUS_JINA]: CustomJinaEmbeddings,
  [EmbeddingModelProviders.OPENAI]: OpenAIEmbeddings,
  [EmbeddingModelProviders.COHEREAI]: OpenAIEmbeddings,
  [EmbeddingModelProviders.GOOGLE]: GoogleGenerativeAIEmbeddings,
  [EmbeddingModelProviders.AZURE_OPENAI]: AzureOpenAIEmbeddings,
  [EmbeddingModelProviders.OLLAMA]: OllamaEmbeddings,
  [EmbeddingModelProviders.LM_STUDIO]: CustomOpenAIEmbeddings,
  [EmbeddingModelProviders.OPENAI_FORMAT]: OpenAIEmbeddings,
  [EmbeddingModelProviders.SILICONFLOW]: CustomOpenAIEmbeddings,
  [EmbeddingModelProviders.OPENROUTERAI]: CustomOpenAIEmbeddings,
} as const;

type EmbeddingProviderConstructorMap = typeof EMBEDDING_PROVIDER_CONSTRUCTORS;

export default class EmbeddingManager {
  private activeEmbeddingModels: CustomModel[];
  private static instance: EmbeddingManager;
  private static embeddingModel: Embeddings;
  private static modelMap: Record<
    string,
    {
      hasApiKey: boolean;
      EmbeddingConstructor: EmbeddingConstructorType;
      vendor: string;
    }
  >;

  private readonly providerApiKeyMap: Record<EmbeddingModelProviders, () => string> = {
    [EmbeddingModelProviders.COPILOT_PLUS]: () =>
      resolveDefaultEmbeddingApiKey(EmbeddingModelProviders.COPILOT_PLUS),
    [EmbeddingModelProviders.COPILOT_PLUS_JINA]: () =>
      resolveDefaultEmbeddingApiKey(EmbeddingModelProviders.COPILOT_PLUS_JINA),
    [EmbeddingModelProviders.OPENAI]: () =>
      resolveDefaultEmbeddingApiKey(EmbeddingModelProviders.OPENAI),
    [EmbeddingModelProviders.COHEREAI]: () =>
      resolveDefaultEmbeddingApiKey(EmbeddingModelProviders.COHEREAI),
    [EmbeddingModelProviders.GOOGLE]: () =>
      resolveDefaultEmbeddingApiKey(EmbeddingModelProviders.GOOGLE),
    [EmbeddingModelProviders.AZURE_OPENAI]: () =>
      resolveDefaultEmbeddingApiKey(EmbeddingModelProviders.AZURE_OPENAI),
    [EmbeddingModelProviders.OLLAMA]: () =>
      resolveDefaultEmbeddingApiKey(EmbeddingModelProviders.OLLAMA),
    [EmbeddingModelProviders.LM_STUDIO]: () =>
      resolveDefaultEmbeddingApiKey(EmbeddingModelProviders.LM_STUDIO),
    [EmbeddingModelProviders.OPENAI_FORMAT]: () =>
      resolveDefaultEmbeddingApiKey(EmbeddingModelProviders.OPENAI_FORMAT),
    [EmbeddingModelProviders.SILICONFLOW]: () =>
      resolveDefaultEmbeddingApiKey(EmbeddingModelProviders.SILICONFLOW),
    [EmbeddingModelProviders.OPENROUTERAI]: () =>
      resolveDefaultEmbeddingApiKey(EmbeddingModelProviders.OPENROUTERAI),
  };

  private constructor() {
    this.initialize();
    subscribeToSettingsChange(() => this.initialize());
  }

  private initialize() {
    const activeEmbeddingModels = getSettings().activeEmbeddingModels;
    this.activeEmbeddingModels = activeEmbeddingModels;
    this.buildModelMap(activeEmbeddingModels);
  }

  static getInstance(): EmbeddingManager {
    if (!EmbeddingManager.instance) {
      EmbeddingManager.instance = new EmbeddingManager();
    }
    return EmbeddingManager.instance;
  }

  getProviderConstructor(model: CustomModel): EmbeddingConstructorType {
    const constructor = EMBEDDING_PROVIDER_CONSTRUCTORS[model.provider as EmbeddingModelProviders];
    if (!constructor) {
      console.warn(`Unknown provider: ${model.provider} for model: ${model.name}`);
      throw new Error(`Unknown provider: ${model.provider} for model: ${model.name}`);
    }
    return constructor;
  }

  // Build a map of modelKey to model config
  private buildModelMap(activeEmbeddingModels: CustomModel[]) {
    EmbeddingManager.modelMap = {};
    const modelMap = EmbeddingManager.modelMap;

    activeEmbeddingModels.forEach((model) => {
      if (model.enabled) {
        if (
          !Object.values(EmbeddingModelProviders).contains(
            model.provider as EmbeddingModelProviders
          )
        ) {
          console.warn(`Unknown provider: ${model.provider} for embedding model: ${model.name}`);
          return;
        }
        const constructor = this.getProviderConstructor(model);
        const apiKey =
          model.apiKey || this.providerApiKeyMap[model.provider as EmbeddingModelProviders]();

        const modelKey = getModelKeyFromModel(model);
        modelMap[modelKey] = {
          hasApiKey: Boolean(apiKey),
          EmbeddingConstructor: constructor,
          vendor: model.provider,
        };
      }
    });
  }

  static getModelName(embeddingsInstance: Embeddings): string {
    const emb = embeddingsInstance as { model?: string; modelName?: string };
    if (emb.model) {
      return emb.model;
    } else if (emb.modelName) {
      return emb.modelName;
    } else {
      throw new Error(
        `Embeddings instance missing model or modelName properties: ${JSON.stringify(embeddingsInstance)}`
      );
    }
  }

  // Get the custom model that matches the name and provider from the model key
  private getCustomModel(modelKey: string): CustomModel {
    return this.activeEmbeddingModels.filter((model) => {
      const key = getModelKeyFromModel(model);
      return modelKey === key;
    })[0];
  }

  async getEmbeddingsAPI(): Promise<Embeddings> {
    const settings = getSettings();
    const embeddingModelKey = settings.embeddingModelKey;

    if (!Object.prototype.hasOwnProperty.call(EmbeddingManager.modelMap, embeddingModelKey)) {
      throw new CustomError(`No embedding model found for: ${embeddingModelKey}`);
    }

    const customModel = this.getCustomModel(embeddingModelKey);

    // Check if model is plus-exclusive but user is not a plus user
    if (customModel.plusExclusive && !getSettings().isPlusUser) {
      new Notice("Plus-only model, please consider upgrading to Plus to access it.");
      throw new CustomError("Plus-only model selected but user is not on Plus plan");
    }

    // Check if model is believer-exclusive but user is not on believer plan
    if (customModel.believerExclusive) {
      const brevilabsClient = BrevilabsClient.getInstance();
      const result = await brevilabsClient.validateLicenseKey();
      if (!result.plan || result.plan.toLowerCase() !== "believer") {
        new Notice("Believer-only model, please consider upgrading to Believer to access it.");
        throw new CustomError("Believer-only model selected but user is not on Believer plan");
      }
    }

    const selectedModel = EmbeddingManager.modelMap[embeddingModelKey];
    if (!selectedModel.hasApiKey) {
      throw new CustomError(
        `API key is not provided for the embedding model: ${embeddingModelKey}`
      );
    }

    const config = await this.getEmbeddingConfig(customModel);

    try {
      EmbeddingManager.embeddingModel = new selectedModel.EmbeddingConstructor(config);
      return EmbeddingManager.embeddingModel;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new CustomError(`Error creating embedding model: ${embeddingModelKey}. ${message}`);
    }
  }

  private async getEmbeddingConfig(customModel: CustomModel): Promise<Record<string, unknown>> {
    const settings = getSettings();
    const modelName = customModel.name;

    const baseConfig = {
      maxRetries: 3,
      maxConcurrency: 3,
    };

    // Define a type that includes additional configuration properties
    type ExtendedConfig<T> = T & {
      configuration?: {
        baseURL?: string;
        fetch?: (url: string, options: RequestInit) => Promise<Response>;
        dangerouslyAllowBrowser?: boolean;
      };
      timeout?: number;
      batchSize?: number;
      dimensions?: number;
    };

    // Update the type definition to include the extended configuration
    const providerConfig: {
      [K in keyof EmbeddingProviderConstructorMap]: ExtendedConfig<
        ConstructorParameters<EmbeddingProviderConstructorMap[K]>[0]
      >;
    } = {
      [EmbeddingModelProviders.COPILOT_PLUS]: {
        modelName,
        apiKey: await getDecryptedKey(settings.plusLicenseKey),
        timeout: 10000,
        batchSize: getSettings().embeddingBatchSize,
        configuration: {
          baseURL: BREVILABS_MODELS_BASE_URL,
          fetch: customModel.enableCors ? safeFetch : undefined,
        },
      },
      [EmbeddingModelProviders.COPILOT_PLUS_JINA]: {
        model: modelName,
        apiKey: await getDecryptedKey(settings.plusLicenseKey),
        timeout: 10000,
        batchSize: getSettings().embeddingBatchSize,
        dimensions: customModel.dimensions,
        baseUrl: BREVILABS_MODELS_BASE_URL + "/embeddings",
        configuration: {
          fetch: customModel.enableCors ? safeFetch : undefined,
        },
      },
      [EmbeddingModelProviders.OPENAI]: {
        modelName,
        apiKey: await getDecryptedKey(
          customModel.apiKey || resolveDefaultEmbeddingApiKey(EmbeddingModelProviders.OPENAI)
        ),
        timeout: 10000,
        batchSize: getSettings().embeddingBatchSize,
        configuration: {
          baseURL: customModel.baseUrl,
          fetch: customModel.enableCors ? safeFetch : undefined,
        },
      },
      [EmbeddingModelProviders.COHEREAI]: {
        modelName,
        apiKey: await getDecryptedKey(
          customModel.apiKey || resolveDefaultEmbeddingApiKey(EmbeddingModelProviders.COHEREAI)
        ),
        timeout: 10000,
        batchSize: getSettings().embeddingBatchSize,
        configuration: {
          baseURL: customModel.baseUrl || ProviderInfo[EmbeddingModelProviders.COHEREAI].host,
          fetch: customModel.enableCors ? safeFetch : undefined,
        },
      },
      [EmbeddingModelProviders.GOOGLE]: {
        modelName: modelName,
        apiKey: await getDecryptedKey(
          resolveDefaultEmbeddingApiKey(EmbeddingModelProviders.GOOGLE)
        ),
      },
      [EmbeddingModelProviders.AZURE_OPENAI]: {
        modelName,
        azureOpenAIApiKey: await getDecryptedKey(
          customModel.apiKey || resolveDefaultEmbeddingApiKey(EmbeddingModelProviders.AZURE_OPENAI)
        ),
        azureOpenAIApiInstanceName:
          customModel.azureOpenAIApiInstanceName || getAzureExtra("azureInstanceName") || "",
        // Embedding-specific deployment override on the legacy CustomModel
        // wins; otherwise fall back to the provider-level deployment in
        // `extra.azureDeploymentName`.
        azureOpenAIApiDeploymentName:
          customModel.azureOpenAIApiEmbeddingDeploymentName ||
          getAzureExtra("azureDeploymentName") ||
          "",
        azureOpenAIApiVersion:
          customModel.azureOpenAIApiVersion || getAzureExtra("azureApiVersion") || "",
      },
      [EmbeddingModelProviders.OLLAMA]: {
        baseUrl: customModel.baseUrl || "http://localhost:11434",
        model: modelName,
        truncate: true,
        headers: {
          Authorization: `Bearer ${await getDecryptedKey(customModel.apiKey || "default-key")}`,
        },
      },
      [EmbeddingModelProviders.LM_STUDIO]: {
        modelName,
        openAIApiKey: await getDecryptedKey(customModel.apiKey || "default-key"),
        configuration: {
          baseURL: customModel.baseUrl || "http://localhost:1234/v1",
          fetch: customModel.enableCors ? safeFetch : undefined,
        },
      },
      [EmbeddingModelProviders.OPENAI_FORMAT]: {
        modelName,
        openAIApiKey: await getDecryptedKey(customModel.apiKey || ""),
        batchSize: getSettings().embeddingBatchSize,
        configuration: {
          baseURL: customModel.baseUrl,
          fetch: customModel.enableCors ? safeFetch : undefined,
          dangerouslyAllowBrowser: true,
        },
      },
      [EmbeddingModelProviders.SILICONFLOW]: {
        modelName,
        apiKey: await getDecryptedKey(
          customModel.apiKey || resolveDefaultEmbeddingApiKey(EmbeddingModelProviders.SILICONFLOW)
        ),
        batchSize: getSettings().embeddingBatchSize,
        configuration: {
          baseURL: customModel.baseUrl || ProviderInfo[EmbeddingModelProviders.SILICONFLOW].host,
          fetch: customModel.enableCors ? safeFetch : undefined,
        },
      },
      [EmbeddingModelProviders.OPENROUTERAI]: {
        modelName,
        apiKey: await getDecryptedKey(
          customModel.apiKey || resolveDefaultEmbeddingApiKey(EmbeddingModelProviders.OPENROUTERAI)
        ),
        batchSize: getSettings().embeddingBatchSize,
        configuration: {
          baseURL: customModel.baseUrl || "https://openrouter.ai/api/v1",
          fetch: customModel.enableCors ? safeFetch : undefined,
        },
      },
    };

    const selectedProviderConfig =
      providerConfig[customModel.provider as EmbeddingModelProviders] || {};

    return { ...baseConfig, ...selectedProviderConfig };
  }

  async ping(model: CustomModel): Promise<boolean> {
    const tryPing = async (enableCors: boolean) => {
      const modelToTest = { ...model, enableCors };
      const config = await this.getEmbeddingConfig(modelToTest);
      const testModel = new (this.getProviderConstructor(modelToTest))(config);
      await testModel.embedQuery("test");
    };

    try {
      // First try without CORS
      await tryPing(false);
      return true;
    } catch (firstError) {
      logInfo("First ping attempt failed, trying with CORS...");
      try {
        // Second try with CORS
        await tryPing(true);
        new Notice(
          "Connection successful, but requires CORS to be enabled. Please enable CORS for this model once you add it above."
        );
        return true;
      } catch (error) {
        const msg =
          "\nwithout CORS Error: " +
          err2String(firstError) +
          "\nwith CORS Error: " +
          err2String(error);
        throw new Error(msg);
      }
    }
  }
}
