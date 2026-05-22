/**
 * Provider verification probes — one small HTTP call per provider type to
 * confirm the API key works against the configured endpoint.
 *
 * No LangChain, no `CustomModel`, no `ChatModelManager`. Routes everything
 * through Obsidian's `requestUrl` (via `safeFetchNoThrow`) so we bypass the
 * renderer's CORS restrictions.
 *
 * See: designdocs/MODEL_MANAGEMENT_REDESIGN_TECH_SPEC.md §3.6.
 */
import { logError } from "@/logger";
import type { ProviderConfig, ProviderId, VerificationResult } from "@/modelManagement/types";
import { safeFetchNoThrow } from "@/utils";

/** Soft UI timeout — `requestUrl` cannot be cancelled, but we stop waiting. */
const TIMEOUT_MS = 10_000;

/**
 * Shape passed in from the dialog before the provider is persisted. Mirrors
 * the `onTest` draft so the call site can forward without remapping.
 */
export interface ProviderDraft {
  providerId: ProviderId;
  apiKey: string;
  baseUrl?: string;
  extra?: Record<string, unknown>;
  type: ProviderConfig["type"];
}

/**
 * Probe the provider's API with the supplied draft credentials. Always
 * resolves — never throws — so the caller can treat the return value as a
 * boolean outcome plus a human-readable error.
 */
export async function verifyProvider(draft: ProviderDraft): Promise<VerificationResult> {
  try {
    return await Promise.race([probeFor(draft), timeoutAfter(TIMEOUT_MS)]);
  } catch (err) {
    logError("[verifyProvider] Unexpected throw:", err);
    return fail(errorMessage(err));
  }
}

function probeFor(draft: ProviderDraft): Promise<VerificationResult> {
  switch (draft.type) {
    case "anthropic":
      return verifyAnthropic(draft);
    case "openai-compatible":
      return verifyOpenAICompatible(draft);
    case "google":
      return verifyGoogle(draft);
    case "azure":
      return verifyAzure(draft);
    case "bedrock":
      return verifyBedrock(draft);
    case "github-copilot":
      return Promise.resolve(fail("Sign in to GitHub Copilot in main Copilot settings first."));
    case undefined:
      // System providers don't go through the BYOK adapter layer; the BYOK UI
      // filters them out so the dialog should never invoke `verifyProvider`
      // on one. If it does, surface a clear failure rather than crashing.
      return Promise.resolve(fail("Provider type is required for verification."));
  }
}

async function verifyAnthropic(draft: ProviderDraft): Promise<VerificationResult> {
  if (!draft.apiKey.trim()) return fail("API key is required");
  const base = trimTrailingSlash(draft.baseUrl) || defaultBaseUrl(draft.providerId);
  if (!base) return fail("Base URL is required");
  const url = `${base}/v1/models`;
  const response = await safeFetchNoThrow(url, {
    method: "GET",
    headers: {
      "x-api-key": draft.apiKey.trim(),
      "anthropic-version": "2023-06-01",
    },
  });
  return interpretHttp(response);
}

async function verifyOpenAICompatible(draft: ProviderDraft): Promise<VerificationResult> {
  const base = trimTrailingSlash(draft.baseUrl) || defaultBaseUrl(draft.providerId);
  if (!base) return fail("Base URL is required");
  // Probe endpoint must require auth — otherwise any string "verifies". Most
  // OpenAI-shape providers gate `/models` behind the API key, but a few
  // (notably OpenRouter) leave it public. For those we hit an auth-only path
  // instead. Local providers (Ollama / LM Studio) don't require a key, so we
  // probe `/models` without auth — connectivity is the real signal there.
  const url = `${base}${probePathFor(draft.providerId)}`;
  const headers: Record<string, string> = {};
  if (draft.apiKey.trim()) {
    headers["Authorization"] = `Bearer ${draft.apiKey.trim()}`;
  }
  const orgId = stringExtra(draft.extra, "openAIOrgId");
  if (orgId) headers["OpenAI-Organization"] = orgId;
  const response = await safeFetchNoThrow(url, { method: "GET", headers });
  return interpretHttp(response);
}

/**
 * Per-provider path appended to the base URL. Defaults to `/models` (which
 * OpenAI, DeepSeek, xAI, Groq, Mistral, SiliconFlow, Cohere all gate behind
 * auth). Override only when a provider's `/models` is public.
 */
function probePathFor(providerId: ProviderId): string {
  switch (providerId) {
    case "openrouter":
      // `/api/v1/auth/key` requires auth; `/api/v1/models` is public.
      return "/auth/key";
    default:
      return "/models";
  }
}

async function verifyGoogle(draft: ProviderDraft): Promise<VerificationResult> {
  if (!draft.apiKey.trim()) return fail("API key is required");
  const base = trimTrailingSlash(draft.baseUrl) || defaultBaseUrl(draft.providerId);
  if (!base) return fail("Base URL is required");
  const url = `${base}/v1beta/models?key=${encodeURIComponent(draft.apiKey.trim())}`;
  const response = await safeFetchNoThrow(url, { method: "GET" });
  return interpretHttp(response);
}

async function verifyAzure(draft: ProviderDraft): Promise<VerificationResult> {
  if (!draft.apiKey.trim()) return fail("API key is required");
  // Extras are the source of truth; baseUrl is a fallback that we parse for
  // the host and any embedded `api-version` query param.
  const instance = stringExtra(draft.extra, "azureInstanceName");
  const version = stringExtra(draft.extra, "azureApiVersion");
  const fallback = parseAzureUrl(draft.baseUrl);
  const host = instance ? `https://${instance}.openai.azure.com` : fallback.azureHost;
  const apiVersion = version || fallback.apiVersion;
  if (!host || !apiVersion) {
    return fail("Set Azure instance and API version under Advanced.");
  }
  const url = `${host}/openai/deployments?api-version=${encodeURIComponent(apiVersion)}`;
  const response = await safeFetchNoThrow(url, {
    method: "GET",
    headers: { "api-key": draft.apiKey.trim() },
  });
  return interpretHttp(response);
}

async function verifyBedrock(draft: ProviderDraft): Promise<VerificationResult> {
  if (!draft.apiKey.trim()) return fail("AWS Bedrock API key is required");
  const region = stringExtra(draft.extra, "bedrockRegion") || "us-east-1";
  const base =
    trimTrailingSlash(draft.baseUrl) || `https://bedrock-runtime.${region}.amazonaws.com`;
  // Cheap, commonly-available Anthropic model. If the user hasn't enabled
  // this specific model in their AWS console, the response surfaces a
  // model-access error — actionable signal, not a verifier failure mode we
  // need to special-case here.
  const probeModel = "anthropic.claude-3-5-haiku-20241022-v1:0";
  const url = `${base}/model/${encodeURIComponent(probeModel)}/invoke`;
  const response = await safeFetchNoThrow(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${draft.apiKey.trim()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  return interpretHttp(response);
}

async function interpretHttp(response: Response): Promise<VerificationResult> {
  if (response.ok) return { ok: true, verifiedAt: Date.now() };
  const body = await response.text().catch(() => "");
  return fail(parseHttpError(response.status, body));
}

function parseHttpError(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string } | string;
      message?: string;
      detail?: { message?: string } | string;
    };
    if (typeof parsed.error === "string") return `${status}: ${parsed.error}`;
    if (parsed.error && typeof parsed.error === "object" && parsed.error.message) {
      return `${status}: ${parsed.error.message}`;
    }
    if (parsed.message) return `${status}: ${parsed.message}`;
    if (typeof parsed.detail === "string") return `${status}: ${parsed.detail}`;
    if (parsed.detail && typeof parsed.detail === "object" && parsed.detail.message) {
      return `${status}: ${parsed.detail.message}`;
    }
  } catch {
    // Body isn't JSON — fall through to the generic mapping.
  }
  if (status === 401) return "401: Invalid API key";
  if (status === 403) return "403: Forbidden — check key permissions";
  if (status === 404) return "404: Endpoint not found — check Base URL";
  if (status >= 500) return `${status}: Provider error — try again later`;
  return body ? `${status}: ${body.slice(0, 200)}` : `HTTP ${status}`;
}

/**
 * Extract the Azure host (`https://{instance}.openai.azure.com`) and any
 * `api-version` query param from a URL the user may have pasted in full.
 * Listing deployments lives at the account host, not under any
 * deployment-specific path — so we keep only the origin, not the path.
 */
function parseAzureUrl(raw: string | undefined): {
  azureHost: string | undefined;
  apiVersion: string | undefined;
} {
  if (!raw?.trim()) return { azureHost: undefined, apiVersion: undefined };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { azureHost: undefined, apiVersion: undefined };
  }
  return {
    azureHost: `${url.protocol}//${url.host}`,
    apiVersion: url.searchParams.get("api-version") || undefined,
  };
}

/**
 * Canonical endpoint for a known provider id. Used both as the verify-time
 * fallback when the user leaves Base URL blank and as the UI placeholder so
 * users see where the request will land.
 */
export function defaultBaseUrl(providerId: ProviderId): string | undefined {
  switch (providerId) {
    case "anthropic":
      return "https://api.anthropic.com";
    case "google":
      return "https://generativelanguage.googleapis.com";
    case "openai":
      return "https://api.openai.com/v1";
    case "openrouter":
      return "https://openrouter.ai/api/v1";
    case "deepseek":
      return "https://api.deepseek.com";
    case "xai":
      return "https://api.x.ai/v1";
    case "groq":
      return "https://api.groq.com/openai/v1";
    case "mistral":
      return "https://api.mistral.ai/v1";
    case "siliconflow":
      return "https://api.siliconflow.cn/v1";
    case "cohere":
      return "https://api.cohere.com/compatibility/v1";
    default:
      return undefined;
  }
}

function trimTrailingSlash(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const trimmed = s.trim().replace(/\/+$/, "");
  return trimmed || undefined;
}

function stringExtra(extra: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = extra?.[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function fail(error: string): VerificationResult {
  return { ok: false, error, verifiedAt: Date.now() };
}

function timeoutAfter(ms: number): Promise<VerificationResult> {
  return new Promise((resolve) => {
    window.setTimeout(() => resolve(fail(`No response after ${Math.round(ms / 1000)}s`)), ms);
  });
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
