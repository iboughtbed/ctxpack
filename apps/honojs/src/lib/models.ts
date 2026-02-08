import type { EmbeddingModel, LanguageModel } from "ai";
import { anthropic, createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI, google } from "@ai-sdk/google";
import { createOpenAI, openai } from "@ai-sdk/openai";

import type { ModelConfig, ProviderKeys } from "../context";
import type { OpenAIProvider } from "@ai-sdk/openai";

/* ------------------------------------------------------------------ */
/*  Configuration from environment                                     */
/* ------------------------------------------------------------------ */

const DEFAULT_EMBEDDING_PROVIDER = (
  process.env.CTXPACK_EMBEDDING_PROVIDER ?? "openai"
).toLowerCase();
const DEFAULT_EMBEDDING_MODEL =
  process.env.CTXPACK_EMBEDDING_MODEL ?? "text-embedding-3-small";

const DEFAULT_CHAT_PROVIDER = (
  process.env.CTXPACK_CHAT_PROVIDER ??
  process.env.CTXPACK_EMBEDDING_PROVIDER ??
  "openai"
).toLowerCase();
const DEFAULT_CHAT_MODEL = process.env.CTXPACK_CHAT_MODEL ?? "gpt-5.2-codex";

const DEFAULT_RESEARCH_PROVIDER = (
  process.env.CTXPACK_RESEARCH_PROVIDER ?? DEFAULT_CHAT_PROVIDER
).toLowerCase();
const DEFAULT_RESEARCH_MODEL =
  process.env.CTXPACK_RESEARCH_MODEL ?? DEFAULT_CHAT_MODEL;

const OPENAI_AUTH_MODE = (
  process.env.CTXPACK_OPENAI_AUTH_MODE ?? "apikey"
).toLowerCase();
const OPENAI_OAUTH_ACCESS_TOKEN =
  process.env.CTXPACK_OPENAI_OAUTH_ACCESS_TOKEN ?? "";
const OPENAI_OAUTH_ACCOUNT_ID =
  process.env.CTXPACK_OPENAI_OAUTH_ACCOUNT_ID ?? "";

const SUPPORTED_EMBEDDING_PROVIDERS = ["openai", "google"] as const;
const SUPPORTED_CHAT_PROVIDERS = ["openai", "anthropic", "google"] as const;
const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex";
const DUMMY_API_KEY = "ctxpack-oauth-dummy";
const DEFAULT_CODEX_INSTRUCTIONS =
  "You are ctxpack's code assistant. Follow the provided system prompt and user input to answer accurately.";

type ResolvedModelConfig = {
  embeddingProvider: string;
  embeddingModel: string;
  chatProvider: string;
  chatModel: string;
  researchProvider: string;
  researchModel: string;
};

let cachedOpenAIOAuthProvider: OpenAIProvider | null = null;

type CodexRequestBody = {
  instructions?: unknown;
  store?: unknown;
  stream?: unknown;
  [key: string]: unknown;
};

function ensureCodexInstructionsBody(
  body: BodyInit | null | undefined,
): BodyInit | null | undefined {
  if (typeof body !== "string") return body;

  try {
    const parsed = JSON.parse(body) as CodexRequestBody;
    if (!parsed || typeof parsed !== "object") return body;

    const next: CodexRequestBody = { ...parsed };
    if (
      !("instructions" in next) ||
      next.instructions === undefined ||
      next.instructions === null ||
      next.instructions === ""
    ) {
      next.instructions = DEFAULT_CODEX_INSTRUCTIONS;
    }
    // Codex backend requires store to be explicitly false.
    next.store = false;
    // Codex backend requires stream to be explicitly true.
    next.stream = true;
    return JSON.stringify(next);
  } catch {
    return body;
  }
}

/* ------------------------------------------------------------------ */
/*  OpenAI provider selection                                          */
/* ------------------------------------------------------------------ */

function getOpenAIOAuthProviderFromEnv(): OpenAIProvider {
  if (cachedOpenAIOAuthProvider) {
    return cachedOpenAIOAuthProvider;
  }

  if (!OPENAI_OAUTH_ACCESS_TOKEN) {
    throw new Error(
      "CTXPACK_OPENAI_AUTH_MODE is set to oauth but CTXPACK_OPENAI_OAUTH_ACCESS_TOKEN is missing.",
    );
  }

  cachedOpenAIOAuthProvider = createOpenAI({
    apiKey: DUMMY_API_KEY,
    baseURL: CODEX_API_ENDPOINT,
    name: "openai-oauth",
    fetch: (async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.delete("authorization");
      headers.delete("Authorization");
      headers.set("Authorization", `Bearer ${OPENAI_OAUTH_ACCESS_TOKEN}`);
      headers.set("originator", "ctxpack");
      if (OPENAI_OAUTH_ACCOUNT_ID) {
        headers.set("ChatGPT-Account-Id", OPENAI_OAUTH_ACCOUNT_ID);
      }

      const url =
        input instanceof URL
          ? input
          : new URL(typeof input === "string" ? input : input.url);
      const shouldRewrite =
        url.pathname.includes("/v1/responses") ||
        url.pathname.includes("/chat/completions") ||
        url.pathname.includes("/responses");
      const targetUrl = shouldRewrite
        ? new URL(`${CODEX_API_ENDPOINT}/responses`)
        : url;
      const nextInit =
        shouldRewrite && init?.method?.toUpperCase() === "POST"
          ? {
              ...init,
              body: ensureCodexInstructionsBody(init.body),
            }
          : init;

      return fetch(targetUrl, {
        ...nextInit,
        headers,
      });
    }) as typeof fetch,
  });

  return cachedOpenAIOAuthProvider;
}

/**
 * Creates an OpenAI OAuth provider from per-request tokens.
 * Unlike the env-based version this is NOT cached because each request may
 * carry a different (refreshed) access token.
 */
function createOpenAIOAuthProviderFromKeys(
  accessToken: string,
  accountId?: string,
): OpenAIProvider {
  return createOpenAI({
    apiKey: DUMMY_API_KEY,
    baseURL: CODEX_API_ENDPOINT,
    name: "openai-oauth",
    fetch: (async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.delete("authorization");
      headers.delete("Authorization");
      headers.set("Authorization", `Bearer ${accessToken}`);
      headers.set("originator", "ctxpack");
      if (accountId) {
        headers.set("ChatGPT-Account-Id", accountId);
      }

      const url =
        input instanceof URL
          ? input
          : new URL(typeof input === "string" ? input : input.url);
      const shouldRewrite =
        url.pathname.includes("/v1/responses") ||
        url.pathname.includes("/chat/completions") ||
        url.pathname.includes("/responses");
      const targetUrl = shouldRewrite
        ? new URL(`${CODEX_API_ENDPOINT}/responses`)
        : url;
      const nextInit =
        shouldRewrite && init?.method?.toUpperCase() === "POST"
          ? {
              ...init,
              body: ensureCodexInstructionsBody(init.body),
            }
          : init;

      return fetch(targetUrl, {
        ...nextInit,
        headers,
      });
    }) as typeof fetch,
  });
}

/**
 * Returns the appropriate OpenAI chat/language model provider.
 *
 * Priority:
 * 1. Per-request OAuth token from `keys` (CLI forwarded via headers)
 * 2. Environment OAuth (`CTXPACK_OPENAI_AUTH_MODE=oauth`)
 * 3. Per-request API key from `keys`
 * 4. Environment API key (`OPENAI_API_KEY`)
 */
function resolveOpenAIChatProvider(keys?: ProviderKeys): OpenAIProvider {
  // 1. Per-request OAuth token (from CLI headers)
  if (keys?.openaiOAuthToken) {
    return createOpenAIOAuthProviderFromKeys(
      keys.openaiOAuthToken,
      keys.openaiOAuthAccountId,
    );
  }
  // 2. Env-based OAuth
  if (OPENAI_AUTH_MODE === "oauth") {
    return getOpenAIOAuthProviderFromEnv();
  }
  // 3. Per-request API key
  if (keys?.openai) {
    return createOpenAI({ apiKey: keys.openai });
  }
  // 4. Default (reads OPENAI_API_KEY from env)
  return openai;
}

function resolveModelConfig(config?: ModelConfig): ResolvedModelConfig {
  const embeddingProvider = (
    config?.embeddingProvider ?? DEFAULT_EMBEDDING_PROVIDER
  ).toLowerCase();
  const embeddingModel = config?.embeddingModel ?? DEFAULT_EMBEDDING_MODEL;

  const chatProvider = (
    config?.chatProvider ??
    embeddingProvider ??
    DEFAULT_CHAT_PROVIDER
  ).toLowerCase();
  const chatModel = config?.chatModel ?? DEFAULT_CHAT_MODEL;

  const researchProvider = (
    config?.researchProvider ??
    chatProvider ??
    DEFAULT_RESEARCH_PROVIDER
  ).toLowerCase();
  const researchModel = config?.researchModel ?? chatModel;

  return {
    embeddingProvider,
    embeddingModel,
    chatProvider,
    chatModel,
    researchProvider,
    researchModel,
  };
}

/* ------------------------------------------------------------------ */
/*  Model factories                                                    */
/* ------------------------------------------------------------------ */

export function getEmbeddingModel(
  config?: ModelConfig,
  keys?: ProviderKeys,
): EmbeddingModel {
  const resolved = resolveModelConfig(config);
  // Embeddings always use the standard API key provider.
  // The Codex/OAuth endpoint does not support embeddings.
  switch (resolved.embeddingProvider) {
    case "openai":
      if (keys?.openai) {
        return createOpenAI({ apiKey: keys.openai }).embedding(
          resolved.embeddingModel,
        );
      }
      return openai.embedding(resolved.embeddingModel);
    case "google":
      if (keys?.google) {
        return createGoogleGenerativeAI({ apiKey: keys.google }).embeddingModel(
          resolved.embeddingModel,
        );
      }
      return google.embeddingModel(resolved.embeddingModel);
    default:
      throw new Error(
        `Unsupported embedding provider "${resolved.embeddingProvider}". Supported: ${SUPPORTED_EMBEDDING_PROVIDERS.join(", ")}`,
      );
  }
}

export function getChatModel(
  config?: ModelConfig,
  keys?: ProviderKeys,
): LanguageModel {
  const resolved = resolveModelConfig(config);
  switch (resolved.chatProvider) {
    case "openai":
      return resolveOpenAIChatProvider(keys)(resolved.chatModel);
    case "anthropic":
      if (keys?.anthropic) {
        return createAnthropic({ apiKey: keys.anthropic })(resolved.chatModel);
      }
      return anthropic(resolved.chatModel);
    case "google":
      if (keys?.google) {
        return createGoogleGenerativeAI({ apiKey: keys.google })(
          resolved.chatModel,
        );
      }
      return google(resolved.chatModel);
    default:
      throw new Error(
        `Unsupported chat provider "${resolved.chatProvider}". Supported: ${SUPPORTED_CHAT_PROVIDERS.join(", ")}`,
      );
  }
}

export function getChatModelInfo(
  config?: ModelConfig,
  keys?: ProviderKeys,
): {
  provider: string;
  model: string;
  authMode: string;
} {
  const resolved = resolveModelConfig(config);
  let authMode = OPENAI_AUTH_MODE;
  if (resolved.chatProvider === "openai" && keys?.openaiOAuthToken) {
    authMode = "oauth";
  }
  return {
    provider: resolved.chatProvider,
    model: resolved.chatModel,
    authMode,
  };
}

export function getResearchModel(
  config?: ModelConfig,
  keys?: ProviderKeys,
): LanguageModel {
  const resolved = resolveModelConfig(config);
  switch (resolved.researchProvider) {
    case "openai":
      return resolveOpenAIChatProvider(keys)(resolved.researchModel);
    case "anthropic":
      if (keys?.anthropic) {
        return createAnthropic({ apiKey: keys.anthropic })(
          resolved.researchModel,
        );
      }
      return anthropic(resolved.researchModel);
    case "google":
      if (keys?.google) {
        return createGoogleGenerativeAI({ apiKey: keys.google })(
          resolved.researchModel,
        );
      }
      return google(resolved.researchModel);
    default:
      throw new Error(
        `Unsupported research provider "${resolved.researchProvider}". Supported: ${SUPPORTED_CHAT_PROVIDERS.join(", ")}`,
      );
  }
}

export function getResearchModelInfo(config?: ModelConfig): {
  provider: string;
  model: string;
} {
  const resolved = resolveModelConfig(config);
  return { provider: resolved.researchProvider, model: resolved.researchModel };
}

export function getEmbeddingModelInfo(config?: ModelConfig): {
  provider: string;
  model: string;
} {
  const resolved = resolveModelConfig(config);
  return {
    provider: resolved.embeddingProvider,
    model: resolved.embeddingModel,
  };
}
