import { BREVILABS_MODELS_BASE_URL, ChatModelProviders } from "@/constants";
import { getDecryptedKey } from "@/encryptionService";
import { logInfo } from "@/logger";
import { ModelRegistry, ProviderRegistry } from "@/modelManagement";
import { getSettings } from "@/settings/model";
import { AcpBackend, AcpSpawnContext, AcpSpawnDescriptor } from "@/agentMode/acp/types";
import type { CopilotMode, ModelSelection } from "@/agentMode/session/types";
import {
  buildPillSyntaxDirective,
  buildSkillCreationDirective,
  composeDenyList,
  DEFAULT_SKILLS_FOLDER,
  getManagedSkills,
  SkillManager,
} from "@/agentMode/skills";
import { buildByokOpencodeProviderConfig } from "./byokBridge";
import { OpencodeBackendDescriptor } from "./descriptor";
import { PLUS_MODELS } from "./plusModels";
import { selectCopilotPrompt } from "./prompts";

const BYOK_DIAG = true;

/**
 * Map from Copilot's `ChatModelProviders` enum value (as stored in
 * `CustomModel.provider`) to OpenCode's provider id (as it appears in
 * OpenCode's `availableModels` and config). Only providers in this map are
 * routable through OpenCode; everything else (Azure, Bedrock, Ollama,
 * LM Studio, GitHub Copilot, etc.) is filtered out of the picker.
 *
 * Copilot Plus is handled separately because it isn't a built-in OpenCode
 * provider — we register it as a custom `@ai-sdk/openai-compatible` entry
 * pointing at brevilabs and authed via the user's `plusLicenseKey`.
 */
export const OPENCODE_PROVIDER_MAP: Partial<Record<ChatModelProviders, string>> = {
  [ChatModelProviders.ANTHROPIC]: "anthropic",
  [ChatModelProviders.OPENAI]: "openai",
  [ChatModelProviders.GOOGLE]: "google",
  [ChatModelProviders.GROQ]: "groq",
  [ChatModelProviders.MISTRAL]: "mistral",
  [ChatModelProviders.DEEPSEEK]: "deepseek",
  [ChatModelProviders.OPENROUTERAI]: "openrouter",
  [ChatModelProviders.XAI]: "xai",
  [ChatModelProviders.COPILOT_PLUS]: "copilot-plus",
};

/** OpenCode provider id reserved for Copilot Plus's brevilabs proxy. */
const COPILOT_PLUS_PROVIDER_ID = "copilot-plus";

/**
 * Custom OpenCode agent id provisioned via `OPENCODE_CONFIG_CONTENT`. Maps
 * to Copilot's canonical `default` mode (writes/exec allowed, but the user
 * approves each request). The built-in `build` agent doesn't ask.
 */
export const OPENCODE_COPILOT_BUILD_AGENT_ID = "copilot-build";

/** OpenCode's built-in build agent id (full perms, no permission asks). */
export const OPENCODE_BUILTIN_BUILD_AGENT_ID = "build";

/**
 * Shared canonical→native agent-id mapping for OpenCode. Used both at spawn
 * time (`buildOpencodeConfig` sets `default_agent`) and at runtime (the
 * descriptor's `getModeMapping` for `session/set_config_option`). Keeping
 * one source of truth so the spawn-time default and the runtime picker
 * never disagree. Plan mode is intentionally absent — opencode's plan
 * agent has no ACP-visible finalization tool, so we don't expose it.
 */
export const OPENCODE_CANONICAL_MODE_AGENT_IDS: Partial<Record<CopilotMode, string>> = {
  default: OPENCODE_COPILOT_BUILD_AGENT_ID,
  auto: OPENCODE_BUILTIN_BUILD_AGENT_ID,
};

/**
 * Spawns `opencode acp --cwd <vault>` with `OPENCODE_CONFIG_CONTENT`
 * containing decrypted BYOK keys pulled from the existing Copilot settings.
 *
 * Reuses Copilot's top-level `*ApiKey` fields so users don't have to re-enter
 * them in an Agent Mode-specific settings panel.
 */
export class OpencodeBackend implements AcpBackend {
  readonly id = "opencode" as const;
  readonly displayName = "opencode";

  async buildSpawnDescriptor(ctx: AcpSpawnContext): Promise<AcpSpawnDescriptor> {
    const binaryPath = getSettings().agentMode?.backends?.opencode?.binaryPath;
    if (!binaryPath) {
      throw new Error(
        "opencode binary not installed. Open Agent Mode settings and install it before starting a session."
      );
    }

    const config = await buildOpencodeConfig(ctx.seedSelection ?? null);
    const envOverrides = getSettings().agentMode?.backends?.opencode?.envOverrides ?? {};

    return {
      command: binaryPath,
      args: ["acp", "--cwd", ctx.vaultBasePath],
      env: {
        ...process.env,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
        // User overrides last — they can replace OPENCODE_CONFIG_CONTENT
        // intentionally if they need to point opencode at a different config.
        ...envOverrides,
      },
    };
  }
}

/**
 * Build the `OPENCODE_CONFIG_CONTENT` payload from current Copilot settings.
 *
 *   - BYOK providers (`settings.providers`) and their registry models
 *     (`settings.registry`) are the sole source of `provider.<id>` entries
 *     — assembled by `buildByokOpencodeProviderConfig` from `byokBridge.ts`.
 *   - Copilot Plus is registered separately as the system-managed
 *     `copilot-plus` pseudo-provider: a custom `@ai-sdk/openai-compatible`
 *     entry pointing at brevilabs and authed via `plusLicenseKey`. It never
 *     lives in BYOK. The hard-coded `PLUS_MODELS` list is registered under
 *     its `models` map so opencode lists them in `availableModels`.
 *   - The top-level `model` field carries the user's sticky preference so
 *     a fresh session boots with the right default, even before
 *     `unstable_setSessionModel` is called.
 *
 * Exported for unit tests.
 */
export async function buildOpencodeConfig(
  seedSelection: ModelSelection | null = null
): Promise<Record<string, unknown>> {
  const s = getSettings();

  type ProviderConfig = {
    npm?: string;
    name?: string;
    options?: { apiKey?: string; baseURL?: string; headers?: Record<string, string> };
    models?: Record<string, Record<string, unknown>>;
  };
  const provider: Record<string, ProviderConfig> = {
    ...buildByokOpencodeProviderConfig(ProviderRegistry.getInstance(), ModelRegistry.getInstance()),
  };

  // Copilot Plus speaks OpenAI's wire format but isn't a built-in OpenCode
  // provider, and it never lives in BYOK (system-managed pseudo-provider per
  // §2.1 of the redesign spec). Register it here when `plusLicenseKey` is
  // configured, including the hard-coded `PLUS_MODELS` list so opencode
  // surfaces them in `availableModels` without depending on legacy
  // `activeModels`.
  if (typeof s.plusLicenseKey === "string" && s.plusLicenseKey) {
    const licenseKey = await getDecryptedKey(s.plusLicenseKey);
    if (licenseKey) {
      const plusEntry: ProviderConfig = {
        npm: "@ai-sdk/openai-compatible",
        name: "Copilot Plus",
        options: { baseURL: BREVILABS_MODELS_BASE_URL, apiKey: licenseKey },
      };
      if (PLUS_MODELS.length > 0) {
        plusEntry.models = {};
        for (const m of PLUS_MODELS) plusEntry.models[m.id] = {};
      }
      provider[COPILOT_PLUS_PROVIDER_ID] = plusEntry;
    }
  }

  if (Object.keys(provider).length === 0) {
    logInfo(
      "[AgentMode] no providers configured for opencode (BYOK empty, no Copilot Plus license). Add a provider in the BYOK tab to use Agent Mode end-to-end."
    );
  }

  if (BYOK_DIAG) {
    logInfo("[BYOK-DIAG] buildOpencodeConfig merged provider slice", {
      providerIds: Object.keys(provider),
      perProvider: Object.fromEntries(
        Object.entries(provider).map(([id, cfg]) => [
          id,
          {
            npm: cfg.npm,
            hasApiKey: !!cfg.options?.apiKey,
            baseURL: cfg.options?.baseURL,
            modelIds: Object.keys(cfg.models ?? {}),
          },
        ])
      ),
    });
  }

  const config: Record<string, unknown> = { provider };

  // Inject a managed `copilot-build` agent so the mode picker can offer the
  // canonical "default" semantic — let the agent edit, but ask first. The
  // built-in `build` agent never asks (used as our `auto` mode); it doesn't
  // cover ask-before-write, hence the custom agent.
  //
  // Both agents also carry a Copilot-authored `prompt` that overrides
  // opencode's provider-default prompt picker (`session/system.ts`). Without
  // this override, Copilot Plus model names (e.g. `copilot-plus-flash`) miss
  // every substring branch and fall through to the generic `default.txt`
  // CLI-coding-agent prompt — wrong domain for an Obsidian vault assistant.
  // opencode's `cfg.agent.<id>` merge is field-wise, so adding `prompt` to
  // the built-in `build` agent leaves its native permissions intact.
  const basePrompt = selectCopilotPrompt(seedSelection?.baseModelId);
  // Append the spawn-time skill-creation directive so agent-authored skills
  // land in the canonical managed folder instead of `.opencode/skills/`.
  // Folder is read live from settings on each spawn — see the Skills
  // Management spec.
  const skillsFolder = s.agentMode?.skills?.folder ?? DEFAULT_SKILLS_FOLDER;
  const skillManagerReady = SkillManager.hasInstance();
  const skillsDirs = skillManagerReady
    ? Object.values(SkillManager.getInstance().getAgentDirsProjectRel())
    : [];
  const prompt = `${basePrompt}\n\n${buildPillSyntaxDirective()}\n\n${buildSkillCreationDirective("opencode", skillsFolder, skillsDirs)}`;
  config.agent = {
    [OPENCODE_BUILTIN_BUILD_AGENT_ID]: {
      prompt,
    },
    [OPENCODE_COPILOT_BUILD_AGENT_ID]: {
      mode: "primary",
      permission: { bash: "ask", edit: "ask" },
      prompt,
    },
  };

  // Apply the seed (model, effort) at spawn so the very first turn (before
  // `unstable_setSessionModel` lands) uses the user's pick. The seed comes
  // from `AgentSessionManager.getLastSelection(backendId)` via the spawn
  // ctx; `null` here means the user hasn't picked a model on this backend
  // yet, so we leave `config.model` unset and let opencode fall back to
  // its own catalog default.
  if (seedSelection?.baseModelId) {
    config.model = seedSelection.effort
      ? `${seedSelection.baseModelId}/${seedSelection.effort}`
      : seedSelection.baseModelId;
  }

  // Always spawn in canonical `default` (ask-before-write `copilot-build`).
  // Mode selection is never persisted — every fresh session starts in ask
  // mode, so we pin the spawn-time `default_agent` to the canonical default
  // here. Otherwise OpenCode would land on its no-ask built-in `build` agent.
  config.default_agent = OPENCODE_COPILOT_BUILD_AGENT_ID;

  // Synthesize deny rules for managed skills that OpenCode would
  // cross-discover (via `.claude/skills/` and `.agents/skills/`) but are
  // not enabled for OpenCode in their `metadata.copilot-enabled-agents`.
  // Read SkillManager live at spawn time — same pattern as the
  // skill-creation directive. If SkillManager isn't initialised yet (plugin
  // still booting; OpenCode session spawned before the Skills tab has
  // hydrated), fall back to an empty deny list — the next reconciliation
  // pass + session restart closes the eventual-consistency window.
  //
  // Note: we intentionally do NOT set `OPENCODE_DISABLE_EXTERNAL_SKILLS` or
  // `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS`. We want OpenCode to walk the
  // cross-discovery paths so the per-name `permission.skill.<name> = "deny"`
  // entries below can take effect.
  if (!skillManagerReady) {
    // SkillManager initialises asynchronously from `main.ts onload`. If
    // OpenCode spawns before that finishes, we ship an empty deny list
    // for this session — the next OpenCode spawn (after SkillManager
    // hydrates) gets the correct one.
    logInfo(
      "[AgentMode] SkillManager not yet initialised at OpenCode spawn — shipping empty deny list; next session will pick it up."
    );
  }
  const managedSkills = skillManagerReady ? getManagedSkills() : [];
  const denyNames = composeDenyList(
    managedSkills,
    OpencodeBackendDescriptor.id,
    OpencodeBackendDescriptor.crossDiscoveredAgents
  );
  if (denyNames.length > 0) {
    // Be additive: opencode's config schema allows `permission` as a
    // top-level key with sub-fields (`skill`, `tool`, `write`, …). Preserve
    // any existing `permission.*` settings the user may have provided
    // through other surfaces.
    const existingPermission = config.permission as Record<string, unknown> | undefined;
    const existingSkillMap = existingPermission?.skill as Record<string, string> | undefined;
    const mergedSkillMap: Record<string, string> = { ...(existingSkillMap ?? {}) };
    for (const name of denyNames) {
      // User-provided entries win — if the user explicitly allowed a skill
      // we'd otherwise deny, respect their override.
      if (!(name in mergedSkillMap)) mergedSkillMap[name] = "deny";
    }
    config.permission = {
      ...(existingPermission ?? {}),
      skill: mergedSkillMap,
    };
    logInfo(
      `[AgentMode] opencode deny list: ${denyNames.length} cross-discovered skill(s) denied (${denyNames.join(", ")})`
    );
  }

  return config;
}
