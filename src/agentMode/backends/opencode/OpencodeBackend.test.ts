import { ChatModelProviders } from "@/constants";
import { resetSettings, setSettings, updateSetting } from "@/settings/model";
import type { Skill } from "@/agentMode/skills";
import { buildOpencodeConfig, OPENCODE_PROVIDER_MAP, OpencodeBackend } from "./OpencodeBackend";
import { COPILOT_PROMPT_BASE, selectCopilotPrompt } from "./prompts";

jest.mock("@/logger", () => ({
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logError: jest.fn(),
}));

// In-memory BYOK fixture the mocked `@/modelManagement` reads from. Tests
// mutate these directly to seed providers + registry entries.
type ProviderConfigStub = {
  id: string;
  kind: "builtin" | "custom";
  displayName: string;
  type: string;
  baseUrl?: string;
  apiKeyRef?: { kind: "inline"; value: string } | null;
  addedAt: number;
};
type RegistryEntryStub = {
  providerId: string;
  modelId: string;
  displayName: string;
  addedAt: number;
};
let mockProviders: ProviderConfigStub[] = [];
let mockRegistry: RegistryEntryStub[] = [];

jest.mock("@/modelManagement", () => ({
  ProviderRegistry: {
    getInstance: () => ({
      list: () => mockProviders.slice(),
    }),
  },
  ModelRegistry: {
    getInstance: () => ({
      list: (filter?: { providerId?: string }) =>
        filter?.providerId
          ? mockRegistry.filter((e) => e.providerId === filter.providerId)
          : mockRegistry.slice(),
    }),
  },
  getProviderApiKeySync: (id: string) => {
    const p = mockProviders.find((x) => x.id === id);
    if (!p?.apiKeyRef) return null;
    return p.apiKeyRef.kind === "inline" ? p.apiKeyRef.value : null;
  },
}));

// Mock the skills package so we can drive the deny-list synthesis path
// without booting the real jotai store / Obsidian App singleton.
let mockSkills: Skill[] = [];
let mockSkillManagerReady = false;

jest.mock("@/agentMode/skills", () => {
  const actual = jest.requireActual("@/agentMode/skills");
  return {
    ...actual,
    getManagedSkills: () => mockSkills,
    SkillManager: {
      hasInstance: () => mockSkillManagerReady,
      getInstance: () => {
        if (!mockSkillManagerReady) {
          throw new Error("SkillManager.getInstance called before initialize");
        }
        return { getAgentDirsProjectRel: () => ({}) } as unknown;
      },
    },
  };
});

function makeSkill(name: string, enabledAgents: Skill["enabledAgents"]): Skill {
  return {
    name,
    description: `${name} skill`,
    filePath: `/x/${name}/SKILL.md`,
    dirPath: `/x/${name}`,
    body: "",
    enabledAgents,
  };
}

function seedSkills(skills: Skill[]): void {
  mockSkills = skills;
  mockSkillManagerReady = skills.length > 0;
}

function seedByokProvider(p: ProviderConfigStub): void {
  mockProviders.push(p);
}

function seedByokModel(entry: RegistryEntryStub): void {
  mockRegistry.push(entry);
}

describe("buildOpencodeConfig", () => {
  beforeEach(() => {
    resetSettings();
    mockProviders = [];
    mockRegistry = [];
    seedSkills([]);
  });

  it("returns an empty provider map when BYOK is empty and no Plus license is set", async () => {
    const cfg = (await buildOpencodeConfig()) as { provider: Record<string, unknown> };
    expect(cfg.provider).toEqual({});
  });

  it("ignores any leftover legacy *ApiKey-shaped fields — BYOK is the only source of provider keys", async () => {
    // Reason: the legacy `anthropicApiKey` / `openAIApiKey` fields were
    // deleted by the M9 migration. If a downgraded device writes them back
    // through a synced data.json they must NOT influence the OpenCode config.
    setSettings({
      anthropicApiKey: "anth-legacy",
      openAIApiKey: "oai-legacy",
    } as unknown as Parameters<typeof setSettings>[0]);
    const cfg = (await buildOpencodeConfig()) as { provider: Record<string, unknown> };
    expect(cfg.provider).toEqual({});
  });

  it("ignores legacy activeModels — BYOK ModelRegistry is the only source of models", async () => {
    setSettings({
      activeModels: [
        {
          name: "claude-sonnet-legacy",
          provider: ChatModelProviders.ANTHROPIC,
          enabled: true,
        },
      ],
    });
    const cfg = (await buildOpencodeConfig()) as { provider: Record<string, unknown> };
    expect(cfg.provider).toEqual({});
  });

  it("registers a BYOK built-in provider with its API key and registry models", async () => {
    seedByokProvider({
      id: "anthropic",
      kind: "builtin",
      displayName: "Anthropic",
      type: "anthropic",
      apiKeyRef: { kind: "inline", value: "sk-ant-xxx" },
      addedAt: 1,
    });
    seedByokModel({
      providerId: "anthropic",
      modelId: "claude-sonnet-4-5",
      displayName: "Claude Sonnet 4.5",
      addedAt: 2,
    });
    const cfg = (await buildOpencodeConfig()) as {
      provider: Record<string, { options?: unknown; models?: Record<string, unknown> }>;
    };
    expect(cfg.provider.anthropic).toEqual({
      options: { apiKey: "sk-ant-xxx" },
      models: { "claude-sonnet-4-5": {} },
    });
  });

  it("registers a BYOK custom provider with baseURL + key and its registry models", async () => {
    seedByokProvider({
      id: "custom:abc",
      kind: "custom",
      displayName: "Local Ollama",
      type: "openai-compatible",
      baseUrl: "http://localhost:11434/v1",
      apiKeyRef: { kind: "inline", value: "ollama-key" },
      addedAt: 1,
    });
    seedByokModel({
      providerId: "custom:abc",
      modelId: "llama3:8b",
      displayName: "Llama 3 8B",
      addedAt: 2,
    });
    const cfg = (await buildOpencodeConfig()) as {
      provider: Record<
        string,
        {
          npm?: string;
          name?: string;
          options?: { apiKey?: string; baseURL?: string };
          models?: Record<string, unknown>;
        }
      >;
    };
    expect(cfg.provider["custom:abc"]).toEqual({
      npm: "@ai-sdk/openai-compatible",
      name: "Local Ollama",
      options: { baseURL: "http://localhost:11434/v1", apiKey: "ollama-key" },
      models: { "llama3:8b": {} },
    });
  });

  it("skips a BYOK built-in provider that has no API key", async () => {
    seedByokProvider({
      id: "groq",
      kind: "builtin",
      displayName: "Groq",
      type: "openai-compatible",
      apiKeyRef: null,
      addedAt: 1,
    });
    const cfg = (await buildOpencodeConfig()) as { provider: Record<string, unknown> };
    expect(cfg.provider).toEqual({});
  });

  it("sets top-level model from the seed selection baseModelId", async () => {
    const cfg = (await buildOpencodeConfig({
      baseModelId: "anthropic/claude-sonnet-4-6",
      effort: null,
    })) as { model?: string };
    expect(cfg.model).toBe("anthropic/claude-sonnet-4-6");
  });

  it("appends effort suffix when the seed selection includes effort", async () => {
    const cfg = (await buildOpencodeConfig({
      baseModelId: "anthropic/claude-sonnet-4-6",
      effort: "high",
    })) as { model?: string };
    expect(cfg.model).toBe("anthropic/claude-sonnet-4-6/high");
  });

  it("leaves config.model unset when no seed selection is provided", async () => {
    const cfg = (await buildOpencodeConfig()) as { model?: string };
    expect(cfg.model).toBeUndefined();
  });

  it("registers a custom copilot-plus provider with PLUS_MODELS when plusLicenseKey is set", async () => {
    updateSetting("plusLicenseKey", "plus-token-123");
    const cfg = (await buildOpencodeConfig()) as {
      provider: Record<
        string,
        {
          npm?: string;
          name?: string;
          options?: { baseURL?: string; apiKey?: string };
          models?: Record<string, unknown>;
        }
      >;
    };
    const cp = cfg.provider["copilot-plus"];
    expect(cp.npm).toBe("@ai-sdk/openai-compatible");
    expect(cp.name).toBe("Copilot Plus");
    expect(cp.options?.baseURL).toBe("https://models.brevilabs.com/v1");
    expect(cp.options?.apiKey).toBe("plus-token-123");
    expect(cp.models).toHaveProperty("copilot-plus-flash");
  });

  it("does not register copilot-plus provider when plusLicenseKey is empty", async () => {
    const cfg = (await buildOpencodeConfig()) as { provider: Record<string, unknown> };
    expect(cfg.provider["copilot-plus"]).toBeUndefined();
  });

  it("uses a Copilot-Plus-shaped seed baseModelId verbatim", async () => {
    updateSetting("plusLicenseKey", "plus-token-123");
    const cfg = (await buildOpencodeConfig({
      baseModelId: "copilot-plus/copilot-plus-flash",
      effort: null,
    })) as { model?: string };
    expect(cfg.model).toBe("copilot-plus/copilot-plus-flash");
  });

  it("always spawns with canonical default agent (copilot-build)", async () => {
    const cfg = (await buildOpencodeConfig()) as { default_agent?: string };
    expect(cfg.default_agent).toBe("copilot-build");
  });

  it("overrides system prompt on both build and copilot-build agents", async () => {
    const cfg = (await buildOpencodeConfig()) as {
      agent: Record<string, { prompt?: string; permission?: unknown; mode?: string }>;
    };
    expect(cfg.agent["copilot-build"].prompt?.startsWith(COPILOT_PROMPT_BASE)).toBe(true);
    expect(cfg.agent.build.prompt?.startsWith(COPILOT_PROMPT_BASE)).toBe(true);
    expect(cfg.agent["copilot-build"].prompt).toContain("{folder_name}");
    expect(cfg.agent["copilot-build"].prompt).toContain("{activeNote}");
    expect(cfg.agent.build.prompt).toContain("{folder_name}");
    expect(cfg.agent["copilot-build"].prompt).toContain(
      'metadata.copilot-enabled-agents: "opencode"'
    );
    expect(cfg.agent.build.prompt).toContain('metadata.copilot-enabled-agents: "opencode"');
    expect(cfg.agent["copilot-build"].permission).toEqual({ bash: "ask", edit: "ask" });
    expect(cfg.agent["copilot-build"].mode).toBe("primary");
  });

  it("templates a custom skills folder into the opencode directive", async () => {
    setSettings({
      agentMode: {
        enabled: true,
        byok: {},
        mcpServers: [],
        activeBackend: "opencode",
        debugFullFrames: false,
        skills: { folder: "team-skills" },
        backends: {},
      },
    });
    const cfg = (await buildOpencodeConfig()) as {
      agent: Record<string, { prompt?: string }>;
    };
    expect(cfg.agent["copilot-build"].prompt).toContain("<vault>/team-skills/<name>/SKILL.md");
    expect(cfg.agent.build.prompt).toContain("<vault>/team-skills/<name>/SKILL.md");
  });

  it("denies a skill enabled for Claude only (cross-discovered, not enabled for opencode)", async () => {
    seedSkills([makeSkill("foo", ["claude"])]);
    const cfg = (await buildOpencodeConfig()) as {
      permission?: { skill?: Record<string, string> };
    };
    expect(cfg.permission?.skill?.foo).toBe("deny");
  });

  it("does not deny a skill enabled for both Claude and OpenCode", async () => {
    seedSkills([makeSkill("foo", ["claude", "opencode"])]);
    const cfg = (await buildOpencodeConfig()) as {
      permission?: { skill?: Record<string, string> };
    };
    expect(cfg.permission?.skill?.foo).toBeUndefined();
  });

  it("does not emit a permission.skill block when no skills need denying", async () => {
    seedSkills([makeSkill("foo", ["opencode"])]);
    const cfg = (await buildOpencodeConfig()) as {
      permission?: { skill?: Record<string, string> };
    };
    expect(cfg.permission).toBeUndefined();
  });

  it("does not emit a permission.skill block when there are no skills at all", async () => {
    seedSkills([]);
    const cfg = (await buildOpencodeConfig()) as { permission?: unknown };
    expect(cfg.permission).toBeUndefined();
  });

  it("synthesises deny rules for a mix of skills (only cross-discovered + not-enabled wins)", async () => {
    seedSkills([
      makeSkill("a", ["claude"]),
      makeSkill("b", ["claude", "opencode"]),
      makeSkill("c", []),
      makeSkill("d", ["opencode"]),
      makeSkill("e", ["codex"]),
    ]);
    const cfg = (await buildOpencodeConfig()) as {
      permission?: { skill?: Record<string, string> };
    };
    expect(cfg.permission?.skill).toEqual({ a: "deny", e: "deny" });
  });

  it("skips deny synthesis when SkillManager has not initialised yet", async () => {
    mockSkills = [makeSkill("foo", ["claude"])];
    mockSkillManagerReady = false;
    const cfg = (await buildOpencodeConfig()) as { permission?: unknown };
    expect(cfg.permission).toBeUndefined();
  });

  it("omits cfg.model when no defaultModel is set", async () => {
    setSettings({
      agentMode: {
        enabled: true,
        byok: {},
        mcpServers: [],
        activeBackend: "opencode",
        debugFullFrames: false,
        skills: { folder: "copilot/skills" },
        backends: {
          opencode: { binaryPath: "/x" },
        },
      },
    });
    const cfg = (await buildOpencodeConfig()) as { model?: string };
    expect(cfg.model).toBeUndefined();
  });
});

describe("OpencodeBackend.buildSpawnDescriptor", () => {
  beforeEach(() => {
    resetSettings();
    mockProviders = [];
    mockRegistry = [];
  });

  it("throws if no binary is installed", async () => {
    const backend = new OpencodeBackend();
    await expect(backend.buildSpawnDescriptor({ vaultBasePath: "/vault" })).rejects.toThrow(
      /binary not installed/
    );
  });

  it("uses agentMode.backends.opencode.binaryPath as command and passes cwd in args", async () => {
    updateSetting("agentMode", {
      enabled: true,
      byok: {},
      mcpServers: [],
      activeBackend: "opencode",
      debugFullFrames: false,
      skills: { folder: "copilot/skills" },
      backends: {
        opencode: {
          binaryPath: "/path/to/opencode",
          binaryVersion: "1.3.17",
          binarySource: "managed",
        },
      },
    });
    seedByokProvider({
      id: "anthropic",
      kind: "builtin",
      displayName: "Anthropic",
      type: "anthropic",
      apiKeyRef: { kind: "inline", value: "sk-ant-xyz" },
      addedAt: 1,
    });
    const backend = new OpencodeBackend();
    const desc = await backend.buildSpawnDescriptor({ vaultBasePath: "/vault/abs" });
    expect(desc.command).toBe("/path/to/opencode");
    expect(desc.args).toEqual(["acp", "--cwd", "/vault/abs"]);
    expect(desc.env.OPENCODE_CONFIG_CONTENT).toBeDefined();
    const cfg = JSON.parse(desc.env.OPENCODE_CONFIG_CONTENT as string);
    expect(cfg.provider.anthropic.options).toEqual({ apiKey: "sk-ant-xyz" });
  });
});

describe("selectCopilotPrompt", () => {
  it("returns COPILOT_PROMPT_BASE for any model id (no per-provider variants yet)", () => {
    expect(selectCopilotPrompt(undefined)).toBe(COPILOT_PROMPT_BASE);
    expect(selectCopilotPrompt("copilot-plus-flash")).toBe(COPILOT_PROMPT_BASE);
    expect(selectCopilotPrompt("copilot-plus/copilot-plus-flash")).toBe(COPILOT_PROMPT_BASE);
    expect(selectCopilotPrompt("anthropic/claude-sonnet-4-6")).toBe(COPILOT_PROMPT_BASE);
    expect(selectCopilotPrompt("google/gemini-2.5-flash")).toBe(COPILOT_PROMPT_BASE);
  });
});

describe("COPILOT_PROMPT_BASE", () => {
  it("establishes Obsidian Copilot identity, not a CLI/coding agent", () => {
    expect(COPILOT_PROMPT_BASE).toMatch(/Obsidian Copilot/);
    expect(COPILOT_PROMPT_BASE).toMatch(/NOT a software-engineering agent or CLI coding tool/);
  });

  it("does not carry chat-mode-only baggage that misfires in tool-driven agents", () => {
    expect(COPILOT_PROMPT_BASE).not.toMatch(/@vault/);
    expect(COPILOT_PROMPT_BASE).not.toMatch(/getCurrentTime/);
    expect(COPILOT_PROMPT_BASE).not.toMatch(/getTimeRangeMs/);
    expect(COPILOT_PROMPT_BASE).not.toMatch(/YouTube/);
  });

  it("ports AGENT_LOOP_GUIDANCE behavior bullets", () => {
    expect(COPILOT_PROMPT_BASE).toMatch(/NEVER search for the same/);
  });
});

describe("OPENCODE_PROVIDER_MAP", () => {
  it("includes the eight BYOK-mapped providers plus Copilot Plus", () => {
    expect(Object.keys(OPENCODE_PROVIDER_MAP).sort()).toEqual(
      [
        ChatModelProviders.ANTHROPIC,
        ChatModelProviders.COPILOT_PLUS,
        ChatModelProviders.DEEPSEEK,
        ChatModelProviders.GOOGLE,
        ChatModelProviders.GROQ,
        ChatModelProviders.MISTRAL,
        ChatModelProviders.OPENAI,
        ChatModelProviders.OPENROUTERAI,
        ChatModelProviders.XAI,
      ].sort()
    );
  });
});
