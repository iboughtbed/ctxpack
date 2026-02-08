#!/usr/bin/env bun
import { stat } from "node:fs/promises";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { fileURLToPath } from "node:url";

import type {
  AgentStep,
  AnswerStreamEvent,
  ApiSearchResult,
  ModelConfig,
  ExploreStreamEvent,
  ResearchJob,
  SearchAnswerResponse,
} from "./lib/api";
import type { ParsedArgv } from "./lib/args";
import type { AuthFile, OAuthCredential } from "./lib/openai-auth";
import { CtxpackApiClient, type ProviderKeys } from "./lib/api";
import {
  getOptionArray,
  getOptionBoolean,
  getOptionNumber,
  getOptionString,
  parseArgv,
} from "./lib/args";
import {
  clearRemoteApiKey,
  createDefaultProjectConfig,
  ensureCtxpackHomeDirectories,
  ensureProjectConfig,
  getAuthFilePath,
  getConfigPath,
  getCtxpackHomePath,
  getCtxpackReposPath,
  getProjectConfigPath,
  isLocalEndpoint,
  readConfig,
  readProjectConfig,
  resolveApiKey,
  resolveEndpoint,
  saveRemoteConfig,
  writeProjectConfig,
} from "./lib/config";
import {
  CODEX_MODELS,
  DEFAULT_CODEX_CHAT_MODEL,
  ensureFreshOAuthTokens,
  getOpenCodeAuthFilePath,
  loginWithBrowser,
  readAuthFile,
  removeProviderAuth,
  setProviderAuth,
} from "./lib/openai-auth";

type SearchMode = "hybrid" | "text" | "vector";

type ApiContext = {
  client: CtxpackApiClient;
  endpoint: string;
};

const DEFAULT_PROVIDER_API_KEY_ENV: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  cohere: "COHERE_API_KEY",
  mistral: "MISTRAL_API_KEY",
  xai: "XAI_API_KEY",
};

type ConnectProvider = {
  id: string;
  auth: string;
  defaultApiKeyEnv?: string;
  notes?: string;
};

const SUPPORTED_CONNECT_PROVIDERS: ConnectProvider[] = [
  {
    id: "openai",
    auth: "OAuth link or API key",
    defaultApiKeyEnv: DEFAULT_PROVIDER_API_KEY_ENV.openai,
    notes:
      "OAuth LLM models: gpt-5.2-codex, gpt-5.3-codex, gpt-5.1-codex-max, gpt-5.2, gpt-5.1-codex-mini. Embeddings require API key.",
  },
  {
    id: "anthropic",
    auth: "API key",
    defaultApiKeyEnv: DEFAULT_PROVIDER_API_KEY_ENV.anthropic,
  },
  {
    id: "google",
    auth: "API key",
    defaultApiKeyEnv: DEFAULT_PROVIDER_API_KEY_ENV.google,
  },
];

function printSupportedConnectProviders(): void {
  console.log("Supported providers:");
  for (const provider of SUPPORTED_CONNECT_PROVIDERS) {
    const apiKeyEnv = provider.defaultApiKeyEnv
      ? `, default env: ${provider.defaultApiKeyEnv}`
      : "";
    console.log(`  - ${provider.id}: ${provider.auth}${apiKeyEnv}`);
    if (provider.notes) {
      console.log(`    ${provider.notes}`);
    }
  }
  console.log("");
  console.log("Examples:");
  console.log("  ctxpack connect openai");
  console.log(
    "  ctxpack connect --provider anthropic --chat-model claude-sonnet-4-5",
  );
  console.log(
    "  ctxpack connect --provider google --embedding-model text-embedding-004",
  );
}

function getConnectProviderChoices(): { label: string; value: string }[] {
  return [
    ...SUPPORTED_CONNECT_PROVIDERS.map((provider) => ({
      label: `${provider.id} (${provider.auth})`,
      value: provider.id,
    })),
    { label: "Cancel", value: "cancel" },
  ];
}

function printHelp(): void {
  console.log(
    [
      "ctxpack CLI",
      "",
      "Setup:",
      "  ctxpack                                            Create ./ctxpack.config.jsonc (if missing)",
      "  ctxpack setup [--force]                            Initialize/refresh project config",
      "",
      "Core commands:",
      "  ctxpack connect openai                             Connect OpenAI via OAuth (ChatGPT Plus/Pro)",
      "  ctxpack connect                                    Select provider interactively",
      "  ctxpack connect --provider <id> --model <id> [--api-key-env <ENV_NAME>]",
      "  ctxpack disconnect",
      "  ctxpack auth status                                Show stored auth credentials",
      "  ctxpack auth logout [provider]                     Remove stored credentials",
      "  ctxpack config",
      "  ctxpack server [--port <n>]                        Start local Hono server",
      "  ctxpack serve [--port <n>]                         Alias for server",
      "  ctxpack list",
      "  ctxpack add <url-or-path> [--name <name>] [--type git|local] [--branch <branch>] [--commit <sha>] [--paths <a,b>] [--notes <text>] [--index]",
      "  ctxpack rm <resource-id>",
      "  ctxpack sync <name-or-id> [...] [--all]",
      "  ctxpack index <name-or-id>",
      "  ctxpack updates [--all] [--resource <name-or-id>] Show resources with remote updates available",
      "  ctxpack reindex <name-or-id> [...]                Deprecated alias for index",
      "  ctxpack job <job-id>",
      "",
      "  ctxpack search <query> [options]                  Search indexed codebases",
      "    (default)                                       Quick AI answer from search results (~2-3s)",
      "    --raw                                           Raw ranked chunks, no AI",
      "    --explore                                       Agent-based exploration with tools (~10-30s)",
      "    --research                                      Deep thorough research (50 steps, ~1-5min)",
      "    --research --async                              Run research in background, returns job ID",
      "",
      "  Common search options:",
      "    --resource, -r <name-or-id>                     Scope to specific resource(s) (omit for all)",
      "    --mode <hybrid|text|vector>                     Search strategy (default: hybrid)",
      "    --stream                                        Stream response",
      "    --verbose, -v                                   Show agent trace (explore/research)",
      "    --top-k <n>                                     Max context chunks",
      "    --alpha <0-1>                                   Hybrid weight",
      "",
      "  ctxpack ask <query> [options]                     Alias for: search --explore",
      "  ctxpack research-status <job-id>                  Check async research job status",
      "",
      "Tool commands (direct resource access):",
      "  ctxpack grep <pattern> --resource <name-or-id> [--paths a,b] [--case-sensitive]",
      "  ctxpack read <filepath> --resource <name-or-id> [--start-line N] [--end-line N]",
      "  ctxpack list --resource <name-or-id> [--path <subpath>]",
      "  ctxpack glob <pattern> --resource <name-or-id>",
      "",
      "Remote aliases:",
      "  ctxpack remote link --key <api-key> [--endpoint <url>]",
      "  ctxpack remote unlink",
      "  ctxpack remote add ...",
      "  ctxpack remote list",
      "  ctxpack remote ask ...",
      "  ctxpack remote rm <resource-id>",
      "",
      "Global options for API commands:",
      "  --endpoint <url>   Override API endpoint",
      "  --api-key <key>    Override API key for this command",
    ].join("\n"),
  );
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function inferResourceType(target: string): "git" | "local" {
  if (
    target.startsWith("http://") ||
    target.startsWith("https://") ||
    target.startsWith("git@")
  ) {
    return "git";
  }
  return "local";
}

function inferResourceName(target: string): string {
  const normalized = target.replace(/\/+$/, "");
  const last = basename(normalized);
  return last.replace(/\.git$/i, "") || "resource";
}

function coerceSearchMode(value: string | undefined): SearchMode | undefined {
  if (!value) {
    return undefined;
  }
  if (value === "hybrid" || value === "text" || value === "vector") {
    return value;
  }
  throw new Error(`Invalid search mode: ${value}`);
}

function formatSnippet(text: string): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= 180) {
    return singleLine;
  }
  return `${singleLine.slice(0, 177)}...`;
}

function formatMatchLabel(result: {
  matchType: SearchMode;
  matchSources?: Array<"text" | "vector">;
}): string {
  if (result.matchSources && result.matchSources.length > 0) {
    return result.matchSources.join("+");
  }
  return result.matchType;
}

function defaultApiKeyEnvForProvider(providerId: string): string {
  return (
    DEFAULT_PROVIDER_API_KEY_ENV[providerId.toLowerCase()] ?? "MODEL_API_KEY"
  );
}

/**
 * Reads stored provider credentials (auth.json) and environment variables
 * to build a ProviderKeys map that will be forwarded to the Hono server
 * via request headers.
 */
async function resolveProviderKeys(): Promise<ProviderKeys> {
  const keys: ProviderKeys = {};
  const auth = await readAuthFile();

  // Resolve from env vars first
  if (process.env.OPENAI_API_KEY) keys.openai = process.env.OPENAI_API_KEY;
  if (process.env.ANTHROPIC_API_KEY)
    keys.anthropic = process.env.ANTHROPIC_API_KEY;
  if (process.env.GOOGLE_GENERATIVE_AI_API_KEY)
    keys.google = process.env.GOOGLE_GENERATIVE_AI_API_KEY;

  // Override with stored credentials if present
  for (const [providerId, cred] of Object.entries(auth)) {
    const id = providerId.toLowerCase();

    if (cred.type === "apikey" && cred.apiKey.trim()) {
      if (id === "openai" && !keys.openai) keys.openai = cred.apiKey.trim();
      if (id === "anthropic" && !keys.anthropic)
        keys.anthropic = cred.apiKey.trim();
      if (id === "google" && !keys.google) keys.google = cred.apiKey.trim();
    }

    // OpenAI OAuth: refresh token if needed and pass the access token
    if (cred.type === "oauth" && id === "openai" && !keys.openaiOAuthToken) {
      try {
        const fresh = await ensureFreshOAuthTokens(providerId);
        if (fresh) {
          keys.openaiOAuthToken = fresh.accessToken;
          if (fresh.accountId) {
            keys.openaiOAuthAccountId = fresh.accountId;
          }
        }
      } catch {
        // OAuth refresh failed -- skip, server will fall back to API key
      }
    }
  }

  return keys;
}

function resolveModelConfig(projectConfig: Awaited<ReturnType<typeof readProjectConfig>>): ModelConfig {
  const baseProvider = (projectConfig?.provider?.id ?? "openai").toLowerCase();
  const embeddingModel =
    projectConfig?.models?.embedding ??
    projectConfig?.provider?.model ??
    "text-embedding-3-small";
  const chatModel = projectConfig?.models?.chat ?? DEFAULT_CODEX_CHAT_MODEL;
  const researchProvider =
    process.env.CTXPACK_RESEARCH_PROVIDER?.toLowerCase() ?? baseProvider;
  const researchModel = process.env.CTXPACK_RESEARCH_MODEL ?? chatModel;

  return {
    embeddingProvider: baseProvider,
    embeddingModel,
    chatProvider: baseProvider,
    chatModel,
    researchProvider,
    researchModel,
  };
}

async function createApiContext(parsed: ParsedArgv): Promise<ApiContext> {
  const globalConfig = await readConfig();
  const projectConfig = await readProjectConfig();
  const endpoint = resolveEndpoint(
    globalConfig,
    getOptionString(parsed.options, ["endpoint", "e"]),
    projectConfig,
    getOptionBoolean(parsed.options, ["__remote"]),
  );
  const apiKey = resolveApiKey(
    globalConfig,
    getOptionString(parsed.options, ["api-key", "key"]),
  );

  if (!apiKey && !isLocalEndpoint(endpoint)) {
    throw new Error(
      "Missing API key for remote endpoint. Use `ctxpack remote link --key <api-key>` or pass `--api-key`.",
    );
  }

  const providerKeys = await resolveProviderKeys();
  const modelConfig = resolveModelConfig(projectConfig);

  return {
    client: new CtxpackApiClient({
      endpoint,
      apiKey,
      providerKeys,
      modelConfig,
    }),
    endpoint,
  };
}

async function handleSetup(parsed: ParsedArgv): Promise<void> {
  await ensureCtxpackHomeDirectories();

  const projectConfigPath = getProjectConfigPath();
  const force = getOptionBoolean(parsed.options, ["force", "f"]);

  const ensured = force
    ? {
        path: projectConfigPath,
        config: createDefaultProjectConfig(),
        created: true,
      }
    : await ensureProjectConfig(projectConfigPath);

  if (force) {
    await writeProjectConfig(ensured.config, ensured.path);
  }

  console.log(
    `${ensured.created ? "Created" : "Using existing"} project config: ${ensured.path}`,
  );
  console.log(
    "Storage root: " + (ensured.config.storage?.root ?? getCtxpackHomePath()),
  );
  console.log(
    "Repository cache: " +
      (ensured.config.storage?.repos ?? getCtxpackReposPath()),
  );
  console.log(
    "Next steps: edit provider/models in ctxpack.config.jsonc, run `ctxpack server`, then `ctxpack add ...`.",
  );
}

/* ------------------------------------------------------------------ */
/*  Interactive stdin helpers                                           */
/* ------------------------------------------------------------------ */

/**
 * Module-level flag to ensure `emitKeypressEvents` is only called once.
 * Calling it multiple times on the same stream adds duplicate internal
 * data→keypress converters, which causes ghost keypress events that can
 * silently resolve subsequent prompts.
 */
let stdinKeypressInitialized = false;

function promptChoice(
  message: string,
  choices: { label: string; value: string }[],
): Promise<string> {
  const defaultValue = choices[0]?.value ?? "";

  if (choices.length === 0) {
    return Promise.resolve("");
  }

  if (process.stdin.isTTY && process.stdout.isTTY) {
    return new Promise((resolve, reject) => {
      let selectedIndex = 0;
      let renderedLineCount = 0;
      let acceptInput = false;
      const stdin = process.stdin;
      const stdout = process.stdout;

      const clearRendered = () => {
        if (renderedLineCount <= 0) {
          return;
        }
        stdout.write(`\x1b[${String(renderedLineCount)}A`);
        stdout.write("\x1b[0J");
        renderedLineCount = 0;
      };

      const render = () => {
        clearRendered();
        const lines = [
          "",
          message,
          ...choices.map(
            (choice, index) =>
              `${index === selectedIndex ? ">" : " "} ${choice.label}`,
          ),
          "",
          "Use Up/Down arrows to navigate, Enter to select.",
        ];
        stdout.write(`${lines.join("\n")}\n`);
        renderedLineCount = lines.length;
      };

      const cleanup = () => {
        stdin.removeListener("keypress", onKeypress);
        if (stdin.isTTY) {
          stdin.setRawMode(false);
        }
        stdin.pause();
        clearRendered();
        stdout.write("\x1b[?25h");
      };

      const onKeypress = (
        _str: string,
        key: { name?: string; ctrl?: boolean },
      ) => {
        if (key.ctrl && key.name === "c") {
          cleanup();
          reject(new Error("Cancelled by user."));
          return;
        }

        // Ignore ghost keypresses from previous prompts
        if (!acceptInput) return;

        if (key.name === "up") {
          selectedIndex = (selectedIndex - 1 + choices.length) % choices.length;
          render();
          return;
        }

        if (key.name === "down") {
          selectedIndex = (selectedIndex + 1) % choices.length;
          render();
          return;
        }

        if (key.name === "return" || key.name === "enter") {
          const selected = choices[selectedIndex]?.value ?? defaultValue;
          cleanup();
          resolve(selected);
        }
      };

      if (!stdinKeypressInitialized) {
        emitKeypressEvents(stdin);
        stdinKeypressInitialized = true;
      }
      if (stdin.isTTY) {
        stdin.setRawMode(true);
      }
      stdin.resume();
      stdout.write("\x1b[?25l");
      stdin.on("keypress", onKeypress);
      render();

      // Delay accepting input briefly so ghost keypresses from a
      // previous prompt (buffered Enter, duplicate emitKeypressEvents
      // converters, etc.) are silently discarded. 100 ms is imperceptible
      // to a human but long enough to drain one full event-loop cycle.
      setTimeout(() => {
        acceptInput = true;
      }, 100);
    });
  }

  return new Promise((resolve) => {
    console.log(`\n${message}`);
    for (let i = 0; i < choices.length; i++) {
      const choice = choices[i];
      if (choice) console.log(`  ${String(i + 1)}) ${choice.label}`);
    }
    process.stdout.write("\nChoice [1]: ");

    const onData = (data: Buffer) => {
      process.stdin.removeListener("data", onData);
      process.stdin.pause();
      const input = data.toString().trim();
      if (input === "") {
        resolve(defaultValue);
        return;
      }
      const idx = parseInt(input, 10) - 1;
      const selected =
        idx >= 0 && idx < choices.length ? choices[idx] : undefined;
      resolve(selected?.value ?? defaultValue);
    };

    process.stdin.resume();
    process.stdin.once("data", onData);
  });
}

function promptInput(message: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(`${message}: `);

    const onData = (data: Buffer) => {
      process.stdin.removeListener("data", onData);
      process.stdin.pause();
      resolve(data.toString().trim());
    };

    process.stdin.resume();
    process.stdin.once("data", onData);
  });
}

/* ------------------------------------------------------------------ */
/*  handleConnect                                                      */
/* ------------------------------------------------------------------ */

async function handleConnect(parsed: ParsedArgv): Promise<void> {
  const provider = getOptionString(parsed.options, ["provider", "p"]);
  const model = getOptionString(parsed.options, ["model", "m"]);
  const embeddingModel = getOptionString(parsed.options, ["embedding-model"]);
  const chatModel = getOptionString(parsed.options, ["chat-model"]);
  const apiKeyEnv = getOptionString(parsed.options, ["api-key-env"]);

  // Check if user did `ctxpack connect openai` (positional)
  const positionalProvider = parsed.positionals[0]?.toLowerCase();
  let effectiveProvider = provider ?? positionalProvider;

  if (
    !effectiveProvider &&
    !model &&
    !embeddingModel &&
    !chatModel &&
    !apiKeyEnv
  ) {
    printSupportedConnectProviders();
    const selectedProvider = await promptChoice(
      "Select provider to connect:",
      getConnectProviderChoices(),
    );
    if (selectedProvider === "cancel") {
      return;
    }
    effectiveProvider = selectedProvider;
  }

  // OpenAI OAuth flow
  if (
    effectiveProvider === "openai" &&
    !model &&
    !embeddingModel &&
    !chatModel &&
    !apiKeyEnv
  ) {
    await handleConnectOpenAI(parsed);
    return;
  }

  const ensured = await ensureProjectConfig();
  const current = ensured.config;

  const nextProviderId = effectiveProvider ?? current.provider?.id ?? "openai";
  const providerChanged =
    typeof effectiveProvider === "string" &&
    effectiveProvider.length > 0 &&
    effectiveProvider !== (current.provider?.id ?? "");
  const nextEmbeddingModel =
    embeddingModel ??
    model ??
    current.models?.embedding ??
    current.provider?.model ??
    "text-embedding-3-small";
  const nextChatModel =
    chatModel ?? current.models?.chat ?? DEFAULT_CODEX_CHAT_MODEL;
  const nextApiKeyEnv =
    apiKeyEnv ??
    (providerChanged ? undefined : current.provider?.apiKeyEnv) ??
    defaultApiKeyEnvForProvider(nextProviderId);

  const nextConfig = {
    ...current,
    provider: {
      ...(current.provider ?? {}),
      id: nextProviderId,
      model: nextEmbeddingModel,
      apiKeyEnv: nextApiKeyEnv,
    },
    models: {
      ...(current.models ?? {}),
      embedding: nextEmbeddingModel,
      chat: nextChatModel,
    },
  };

  await writeProjectConfig(nextConfig, ensured.path);
  console.log(`Updated provider configuration in ${ensured.path}`);
  console.log(`Provider: ${nextProviderId}`);
  console.log(`Embedding model: ${nextEmbeddingModel}`);
  console.log(`Chat model: ${nextChatModel}`);
  console.log(`API key env var: ${nextApiKeyEnv}`);
}

async function handleConnectOpenAI(_parsed: ParsedArgv): Promise<void> {
  const method = await promptChoice("Select authentication method:", [
    { label: "ChatGPT Plus/Pro (OAuth link)", value: "oauth-link" },
    { label: "Manually enter API Key", value: "apikey" },
  ]);

  if (method === "apikey") {
    const apiKey = await promptInput("Enter your OpenAI API key");
    if (!apiKey) {
      throw new Error("No API key provided.");
    }
    await setProviderAuth("openai", { type: "apikey", apiKey });
    console.log(
      `\nAPI key stored in ${getAuthFilePath()} (mirrored to ${getOpenCodeAuthFilePath()})`,
    );

    // Update project config -- keep existing models, just ensure provider is openai
    const ensured = await ensureProjectConfig();
    const current = ensured.config;
    const nextConfig = {
      ...current,
      provider: {
        ...(current.provider ?? {}),
        id: "openai",
        apiKeyEnv: "OPENAI_API_KEY",
      },
    };
    await writeProjectConfig(nextConfig, ensured.path);
    console.log("Provider set to openai (API key mode).");
    return;
  }

  // OAuth link flow
  const credential: OAuthCredential = await loginWithBrowser();

  console.log("\nAuthentication successful!");
  if (credential.accountId) {
    console.log(`Account ID: ${credential.accountId}`);
  }
  console.log(
    `Tokens stored in ${getAuthFilePath()} (mirrored to ${getOpenCodeAuthFilePath()})`,
  );

  // Auto-update project config to use a Codex-compatible chat model
  const ensured = await ensureProjectConfig();
  const current = ensured.config;
  const currentChat = current.models?.chat ?? "";
  const needsModelUpdate = !CODEX_MODELS.has(currentChat);

  const nextConfig = {
    ...current,
    provider: {
      ...(current.provider ?? {}),
      id: "openai",
    },
    models: {
      ...(current.models ?? {}),
      chat: needsModelUpdate ? DEFAULT_CODEX_CHAT_MODEL : currentChat,
    },
  };

  await writeProjectConfig(nextConfig, ensured.path);
  console.log(`Provider set to openai (OAuth mode).`);
  if (needsModelUpdate) {
    console.log(
      `Chat model auto-set to ${DEFAULT_CODEX_CHAT_MODEL} (compatible with ChatGPT subscription).`,
    );
  }
  console.log(
    "\nNote: Embeddings still require an API key or a different provider (e.g., google).",
  );
}

async function handleDisconnect(): Promise<void> {
  const projectConfigPath = getProjectConfigPath();
  const config = await readProjectConfig(projectConfigPath);
  if (!config) {
    console.log(`No project config found at ${projectConfigPath}`);
    return;
  }

  const nextConfig = {
    ...config,
  };
  delete nextConfig.provider;
  delete nextConfig.models;

  await writeProjectConfig(nextConfig, projectConfigPath);
  console.log(`Removed provider/model configuration from ${projectConfigPath}`);
}

/* ------------------------------------------------------------------ */
/*  Auth management commands                                           */
/* ------------------------------------------------------------------ */

async function handleAuthStatus(): Promise<void> {
  const auth = await readAuthFile();
  const providers = Object.keys(auth);

  if (providers.length === 0) {
    console.log("No stored credentials.");
    console.log(`ctxpack auth file: ${getAuthFilePath()}`);
    console.log(`OpenCode auth file: ${getOpenCodeAuthFilePath()}`);
    return;
  }

  console.log("Stored credentials:");
  console.log(`  ctxpack auth file: ${getAuthFilePath()}`);
  console.log(`  OpenCode auth file: ${getOpenCodeAuthFilePath()}\n`);
  for (const providerId of providers) {
    const cred = auth[providerId];
    if (!cred) continue;
    if (cred.type === "oauth") {
      const expiresIn = cred.expiresAt - Date.now();
      const expired = expiresIn <= 0;
      const expiryLabel = expired
        ? "EXPIRED"
        : `expires in ${Math.round(expiresIn / 60_000)}m`;
      console.log(`  ${providerId}: OAuth (${expiryLabel})`);
      if (cred.accountId) {
        console.log(`    Account ID: ${cred.accountId}`);
      }
    } else if (cred.type === "apikey") {
      const masked = `${cred.apiKey.slice(0, 8)}...${cred.apiKey.slice(-4)}`;
      console.log(`  ${providerId}: API Key (${masked})`);
    }
  }
}

async function handleAuthLogout(parsed: ParsedArgv): Promise<void> {
  const providerId = parsed.positionals[0] ?? "openai";
  const auth = await readAuthFile();

  if (!auth[providerId]) {
    console.log(`No stored credentials for "${providerId}".`);
    return;
  }

  await removeProviderAuth(providerId);
  console.log(
    `Removed credentials for "${providerId}" from ${getAuthFilePath()} and ${getOpenCodeAuthFilePath()}.`,
  );
}

async function routeAuth(parsed: ParsedArgv): Promise<void> {
  const sub = parsed.positionals[0];

  if (!sub || sub === "status") {
    await handleAuthStatus();
    return;
  }

  if (sub === "logout" || sub === "remove") {
    // Shift positionals so the provider arg is [0]
    const shifted: ParsedArgv = {
      ...parsed,
      positionals: parsed.positionals.slice(1),
    };
    await handleAuthLogout(shifted);
    return;
  }

  throw new Error(
    "Usage: ctxpack auth status\n" + "       ctxpack auth logout [provider]",
  );
}

/* ------------------------------------------------------------------ */
/*  Remote link                                                        */
/* ------------------------------------------------------------------ */

async function handleRemoteLink(parsed: ParsedArgv): Promise<void> {
  const endpoint = getOptionString(parsed.options, ["endpoint", "e"]);
  const apiKey =
    getOptionString(parsed.options, ["key", "api-key", "k"]) ?? undefined;

  if (!endpoint && !apiKey) {
    throw new Error(
      "Usage: ctxpack remote link --key <api-key> [--endpoint <url>]",
    );
  }

  await saveRemoteConfig({
    endpoint,
    apiKey,
  });

  console.log(`Saved remote config to ${getConfigPath()}`);
  if (endpoint) {
    console.log(`Endpoint: ${endpoint}`);
  }
  if (apiKey) {
    console.log("API key: saved");
  }
}

async function handleRemoteUnlink(): Promise<void> {
  await clearRemoteApiKey();
  console.log("Remote API key removed from global config.");
}

async function handleShowConfig(): Promise<void> {
  const globalConfig = await readConfig();
  const projectConfigPath = getProjectConfigPath();
  const projectConfig = await readProjectConfig(projectConfigPath);

  const endpoint = resolveEndpoint(globalConfig, undefined, projectConfig);
  const hasApiKey = Boolean(resolveApiKey(globalConfig));

  console.log(`Project config path: ${projectConfigPath}`);
  console.log(`Project config exists: ${projectConfig ? "yes" : "no"}`);
  if (projectConfig?.provider?.id) {
    console.log(`Provider: ${projectConfig.provider.id}`);
  }
  if (projectConfig?.models?.embedding) {
    console.log(`Embedding model: ${projectConfig.models.embedding}`);
  }
  if (projectConfig?.models?.chat) {
    console.log(`Chat model: ${projectConfig.models.chat}`);
  }
  console.log(`Global config path: ${getConfigPath()}`);
  console.log(`Effective endpoint: ${endpoint}`);
  console.log(`Remote API key configured: ${hasApiKey ? "yes" : "no"}`);
}

async function handleList(parsed: ParsedArgv): Promise<void> {
  const { client, endpoint } = await createApiContext(parsed);
  const resources = await client.listResources();

  if (resources.length === 0) {
    console.log(`No resources found at ${endpoint}`);
    return;
  }

  console.log(`Resources (${resources.length})`);
  for (const resource of resources) {
    const updateTag =
      resource.type === "git" && resource.updateAvailable ? " | updates=available" : "";
    console.log(
      `- ${resource.id} | content=${resource.contentStatus} | vector=${resource.vectorStatus} | ${resource.type} | chunks=${resource.chunkCount}${updateTag} | ${resource.name}`,
    );
  }
}

async function handleAdd(parsed: ParsedArgv): Promise<void> {
  const target = parsed.positionals[0];
  if (!target) {
    throw new Error("Usage: ctxpack add <url-or-path> [options]");
  }

  const typeOption = getOptionString(parsed.options, ["type", "t"]);
  const type =
    typeOption === "git" || typeOption === "local"
      ? typeOption
      : inferResourceType(target);

  const name =
    getOptionString(parsed.options, ["name", "n"]) ?? inferResourceName(target);
  const branch = getOptionString(parsed.options, ["branch", "b"]);
  const commit = getOptionString(parsed.options, ["commit", "c"]);
  const notes = getOptionString(parsed.options, ["notes", "note"]);
  const paths = getOptionArray(parsed.options, ["paths", "p"]);
  const shouldIndex = getOptionBoolean(parsed.options, ["index", "i"]);

  const { client } = await createApiContext(parsed);

  const created = await client.createResource({
    name,
    type,
    ...(type === "git" ? { url: target } : { path: resolvePath(target) }),
    ...(branch ? { branch } : {}),
    ...(commit ? { commit } : {}),
    ...(notes ? { notes } : {}),
    ...(paths.length > 0 ? { paths } : {}),
  });

  console.log(`Created resource ${created.id} (${created.name})`);

  if (created.type === "git") {
    const syncJob = await client.triggerResourceSync(created.id);
    console.log(`Queued sync job ${syncJob.jobId}`);
  }

  if (shouldIndex) {
    const job = await client.triggerResourceIndex(created.id);
    console.log(`Queued index job ${job.jobId}`);
  }
}

async function handleRemove(parsed: ParsedArgv): Promise<void> {
  const resourceId = parsed.positionals[0];
  if (!resourceId) {
    throw new Error("Usage: ctxpack rm <resource-id>");
  }

  const { client } = await createApiContext(parsed);
  await client.deleteResource(resourceId);
  console.log(`Deleted resource ${resourceId}`);
}

async function handleIndex(parsed: ParsedArgv): Promise<void> {
  const target = parsed.positionals[0];
  if (!target) {
    throw new Error("Usage: ctxpack index <name-or-id>");
  }

  const { client } = await createApiContext(parsed);
  const [resourceId] = await resolveResourceNames(client, [target]);
  if (!resourceId) {
    throw new Error(`Resource \"${target}\" not found.`);
  }
  const job = await client.triggerResourceIndex(resourceId);
  console.log(
    `Queued ${job.jobType} job ${job.jobId} for resource ${job.resourceId}`,
  );
}

async function handleSync(parsed: ParsedArgv): Promise<void> {
  const { client } = await createApiContext(parsed);
  const all = getOptionBoolean(parsed.options, ["all", "a"]);
  const names = parsed.positionals;
  if (!all && names.length === 0) {
    throw new Error("Usage: ctxpack sync <name-or-id> [...] or ctxpack sync --all");
  }

  const allResources = await client.listResources();
  const resourceIds = all
    ? allResources.map((resource) => resource.id)
    : await resolveResourceNames(client, names);

  if (resourceIds.length === 0) {
    console.log("No resources to sync.");
    return;
  }

  console.log(`Syncing ${resourceIds.length} resource(s)...\n`);
  for (const resourceId of resourceIds) {
    const resource = allResources.find((item) => item.id === resourceId);
    try {
      const job = await client.triggerResourceSync(resourceId);
      console.log(
        `[queued] ${resource?.name ?? resourceId} -> ${job.jobType} job ${job.jobId}`,
      );
    } catch (error) {
      console.error(
        `[failed] ${resource?.name ?? resourceId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

async function handleReindex(parsed: ParsedArgv): Promise<void> {
  console.log(
    "Warning: `reindex` is deprecated. Use `index` for vector indexing and `sync` for git updates.",
  );
  const { client } = await createApiContext(parsed);
  const all = getOptionBoolean(parsed.options, ["all", "a"]);
  const names = parsed.positionals;

  if (!all && names.length === 0) {
    throw new Error(
      "Usage: ctxpack reindex <name-or-id> [...] or ctxpack reindex --all",
    );
  }

  const allResources = await client.listResources();

  let targets: typeof allResources;

  if (all) {
    targets = allResources;
  } else {
    targets = [];
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    for (const name of names) {
      if (uuidRegex.test(name)) {
        const match = allResources.find((r) => r.id === name);
        if (!match) {
          throw new Error(`Resource with id "${name}" not found.`);
        }
        targets.push(match);
      } else {
        const match = allResources.find(
          (r) => r.name.toLowerCase() === name.toLowerCase(),
        );
        if (!match) {
          throw new Error(
            `Resource "${name}" not found. Available: ${allResources.map((r) => r.name).join(", ")}`,
          );
        }
        targets.push(match);
      }
    }
  }

  if (targets.length === 0) {
    console.log("No resources to reindex.");
    return;
  }

  console.log(`Reindexing ${targets.length} resource(s)...\n`);

  for (const resource of targets) {
    const label = `${resource.name} (${resource.type}, ${resource.id})`;
    try {
      const job = await client.triggerResourceIndex(resource.id);
      console.log(`[queued] ${label} -> ${job.jobType} job ${job.jobId}`);
    } catch (error) {
      console.error(
        `[failed] ${label}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  console.log(
    "\nAll jobs queued. Use `ctxpack job <job-id>` to check progress.",
  );
}

async function handleUpdates(parsed: ParsedArgv): Promise<void> {
  const { client } = await createApiContext(parsed);
  const resourceNames = getOptionArray(parsed.options, ["resource", "r"]);
  const allResources = await client.listResources();
  const scopedIds = await resolveResourceNames(client, resourceNames);
  const targets = allResources.filter((resource) =>
    scopedIds.length === 0 ? true : scopedIds.includes(resource.id),
  );
  const stale = targets.filter(
    (resource) => resource.type === "git" && resource.updateAvailable,
  );

  if (stale.length === 0) {
    console.log("No git resources with updates available.");
    return;
  }

  console.log(`Resources with updates (${stale.length})`);
  for (const resource of stale) {
    console.log(
      `- ${resource.name} (${resource.id}) local=${resource.lastLocalCommit ?? "unknown"} remote=${resource.lastRemoteCommit ?? "unknown"}`,
    );
  }
}

async function handleJob(parsed: ParsedArgv): Promise<void> {
  const jobId = parsed.positionals[0];
  if (!jobId) {
    throw new Error("Usage: ctxpack job <job-id>");
  }

  const { client } = await createApiContext(parsed);
  const job = await client.getJob(jobId);
  console.log(`Job: ${job.id}`);
  console.log(`Resource: ${job.resourceId}`);
  console.log(`Type: ${job.jobType}`);
  console.log(`Status: ${job.status}`);
  console.log(`Progress: ${job.progress}%`);
  console.log(`Files: ${job.processedFiles}/${job.totalFiles ?? "?"}`);
  if (job.error) {
    console.log(`Error: ${job.error}`);
  }
  if (job.warnings.length > 0) {
    console.log(`Warnings: ${job.warnings.length}`);
  }
}

function printSearchResult(result: ApiSearchResult, index: number): void {
  const sources = formatMatchLabel(result);
  console.log(
    `${index + 1}. [${sources}] ${result.resourceName}:${result.filepath}:${result.lineStart}-${result.lineEnd} score=${result.score.toFixed(4)}`,
  );
  console.log(`   ${formatSnippet(result.text)}`);
}

async function resolveResourceNames(
  client: InstanceType<typeof CtxpackApiClient>,
  names: string[],
): Promise<string[]> {
  if (names.length === 0) return [];

  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const alreadyUuids = names.filter((n) => uuidRegex.test(n));
  const toResolve = names.filter((n) => !uuidRegex.test(n));

  if (toResolve.length === 0) return alreadyUuids;

  const allResources = await client.listResources();
  const resolved: string[] = [...alreadyUuids];

  for (const name of toResolve) {
    const match = allResources.find(
      (r) => r.name.toLowerCase() === name.toLowerCase(),
    );
    if (match) {
      resolved.push(match.id);
    } else {
      throw new Error(
        `Resource "${name}" not found. Available: ${allResources.map((r) => r.name).join(", ")}`,
      );
    }
  }

  return resolved;
}

async function maybePrintUpdateReminder(
  client: InstanceType<typeof CtxpackApiClient>,
  scopedResourceIds: string[],
): Promise<void> {
  const resources = await client.listResources();
  const candidates = resources.filter((resource) =>
    scopedResourceIds.length === 0 ? true : scopedResourceIds.includes(resource.id),
  );
  const stale = candidates.filter(
    (resource) => resource.type === "git" && resource.updateAvailable,
  );
  if (stale.length === 0) {
    return;
  }
  const hint =
    stale.length === 1
      ? `ctxpack sync ${stale[0]!.id}`
      : "ctxpack updates";
  console.log(
    `\nUpdate available for ${stale.length} git resource(s). Run \`${hint}\` to pull latest changes.`,
  );
}

async function handleSearch(parsed: ParsedArgv): Promise<void> {
  const query =
    getOptionString(parsed.options, ["query", "q"]) ??
    parsed.positionals.join(" ").trim();
  if (!query) {
    throw new Error("Usage: ctxpack search <query> [options]");
  }

  const mode = coerceSearchMode(getOptionString(parsed.options, ["mode", "m"]));
  const alpha = getOptionNumber(parsed.options, ["alpha"]);
  const topK = getOptionNumber(parsed.options, ["top-k", "topK", "k"]);
  const resourceNames = getOptionArray(parsed.options, ["resource", "r"]);
  const rawMode = getOptionBoolean(parsed.options, ["raw"]);
  const exploreMode = getOptionBoolean(parsed.options, ["explore"]);
  const researchMode = getOptionBoolean(parsed.options, ["research"]);
  const verbose = getOptionBoolean(parsed.options, ["verbose", "v"]);
  const stream = getOptionBoolean(parsed.options, ["stream"]);

  if (alpha !== undefined && (alpha < 0 || alpha > 1)) {
    throw new Error("--alpha must be between 0 and 1");
  }
  if (topK !== undefined && (!Number.isInteger(topK) || topK < 1)) {
    throw new Error("--top-k must be a positive integer");
  }

  const { client } = await createApiContext(parsed);
  const resourceIds = await resolveResourceNames(client, resourceNames);

  const searchPayload = {
    query,
    ...(mode ? { mode } : {}),
    ...(alpha !== undefined ? { alpha } : {}),
    ...(topK !== undefined ? { topK } : {}),
    ...(resourceIds.length > 0 ? { resourceIds } : {}),
  };

  /* --raw: raw ranked chunks, no AI */
  if (rawMode) {
    const results = await client.search(searchPayload);
    if (results.length === 0) {
      console.log("No results.");
      await maybePrintUpdateReminder(client, resourceIds);
      return;
    }
    console.log(`Results (${results.length})`);
    results.forEach(printSearchResult);
    await maybePrintUpdateReminder(client, resourceIds);
    return;
  }

  /* --research: deep research (50 steps) */
  if (researchMode) {
    const asyncMode = getOptionBoolean(parsed.options, ["async"]);

    if (asyncMode) {
      const { jobId, status } = await client.createResearchJob(searchPayload);
      console.log(`Research job created: ${jobId} (${status})`);
      console.log(`Check status: ctxpack research-status ${jobId}`);
      await maybePrintUpdateReminder(client, resourceIds);
      return;
    }

    if (stream) {
      const events = client.searchResearchStream(searchPayload);
      await printExploreStream(events, verbose);
    } else {
      const response = await client.searchResearch(searchPayload);
      printExploreResponse(response, verbose);
    }
    await maybePrintUpdateReminder(client, resourceIds);
    return;
  }

  /* --explore: agent-based exploration */
  if (exploreMode) {
    if (stream) {
      const events = client.searchExploreStream(searchPayload);
      await printExploreStream(events, verbose);
    } else {
      const response = await client.searchExplore(searchPayload);
      printExploreResponse(response, verbose);
    }
    await maybePrintUpdateReminder(client, resourceIds);
    return;
  }

  /* default: quick answer (search + single LLM) */
  if (stream) {
    const events = client.searchAnswerStream(searchPayload);
    await printAnswerStream(events);
  } else {
    const response = await client.searchAnswer(searchPayload);
    printAnswerResponse(response);
  }
  await maybePrintUpdateReminder(client, resourceIds);
}

/* ------------------------------------------------------------------ */
/*  Quick answer output                                                */
/* ------------------------------------------------------------------ */

function printAnswerResponse(response: SearchAnswerResponse): void {
  console.log(response.answer);

  if (response.sources.length > 0) {
    console.log(
      `\n--- Sources (${response.sources.length}) [${response.model}] ---\n`,
    );
    for (const [index, source] of response.sources.entries()) {
      console.log(
        `${index + 1}. ${source.resourceName}:${source.filepath}:${source.lineStart}-${source.lineEnd} (${formatMatchLabel(source)}, score=${source.score.toFixed(4)})`,
      );
    }
  }
}

async function printAnswerStream(
  events: AsyncGenerator<AnswerStreamEvent>,
): Promise<void> {
  let hasAnswerText = false;
  let model = "";
  let bufferedSources: Array<{
    resourceName: string;
    filepath: string;
    lineStart: number;
    lineEnd: number;
    matchType: string;
    score: number;
  }> = [];

  for await (const event of events) {
    switch (event.type) {
      case "start":
        model = event.model;
        break;

      case "text-delta":
        hasAnswerText = true;
        process.stdout.write(event.textDelta);
        break;

      case "sources":
        bufferedSources = event.sources;
        break;

      case "done":
        if (hasAnswerText) {
          console.log("");
        }
        if (bufferedSources.length > 0) {
          console.log(
            `\n--- Sources (${bufferedSources.length}) [${model}] ---\n`,
          );
          for (const [index, source] of bufferedSources.entries()) {
            console.log(
              `${index + 1}. ${source.resourceName}:${source.filepath}:${source.lineStart}-${source.lineEnd} (${formatMatchLabel({ matchType: source.matchType as SearchMode })}, score=${source.score.toFixed(4)})`,
            );
          }
        }
        break;

      case "ping":
        // Keepalive heartbeat -- ignore
        break;

      case "error":
        console.error(`\nError: ${event.message}`);
        break;
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Explore (agent) output                                             */
/* ------------------------------------------------------------------ */

function printAgentStep(step: AgentStep): void {
  console.log(`\n--- Step ${step.stepNumber} [${step.finishReason}] ---`);

  if (step.reasoning) {
    console.log(`[Reasoning] ${step.reasoning}`);
  }

  for (const tc of step.toolCalls) {
    const inputStr = JSON.stringify(tc.input, null, 2)
      .split("\n")
      .map((line, i) => (i === 0 ? line : `  ${line}`))
      .join("\n");
    console.log(`[Tool Call] ${tc.toolName}(${inputStr})`);
  }

  for (const tr of step.toolResults) {
    const outputStr =
      typeof tr.output === "string"
        ? tr.output
        : JSON.stringify(tr.output, null, 2);
    const truncated =
      outputStr.length > 500
        ? `${outputStr.slice(0, 500)}... (truncated)`
        : outputStr;
    console.log(`[Tool Result] ${tr.toolName} -> ${truncated}`);
  }

  if (step.text) {
    console.log(`[Text] ${step.text}`);
  }

  console.log(
    `[Usage] prompt=${step.usage.promptTokens} completion=${step.usage.completionTokens} total=${step.usage.totalTokens}`,
  );
}

function printExploreResponse(
  response: SearchAnswerResponse,
  verbose?: boolean,
): void {
  if (verbose && response.steps.length > 0) {
    console.log(
      `=== Agent Trace (${response.steps.length} steps) [${response.model}] ===`,
    );
    for (const step of response.steps) {
      printAgentStep(step);
    }
    console.log("\n=== Answer ===\n");
  } else {
    // Non-verbose: print compact tool trace
    for (const step of response.steps) {
      for (const tc of step.toolCalls) {
        console.log(`[${tc.toolName}]`);
      }
    }
  }

  console.log(response.answer);

  if (response.sources.length > 0) {
    console.log(
      `\n--- Sources (${response.sources.length}) [${response.model}] ---\n`,
    );
    for (const [index, source] of response.sources.entries()) {
      console.log(
        `${index + 1}. ${source.resourceName}:${source.filepath}:${source.lineStart}-${source.lineEnd} (${formatMatchLabel(source)}, score=${source.score.toFixed(4)})`,
      );
    }
  }
}

async function printExploreStream(
  events: AsyncGenerator<ExploreStreamEvent>,
  verbose?: boolean,
): Promise<void> {
  let currentStep = 0;
  let hasAnswerText = false;

  for await (const event of events) {
    switch (event.type) {
      case "start":
        if (verbose) {
          console.log(`=== Agent Trace (streaming) [${event.model}] ===`);
        }
        break;

      case "text-delta":
        if (!hasAnswerText && verbose) {
          console.log("\n=== Answer ===\n");
        }
        hasAnswerText = true;
        process.stdout.write(event.textDelta);
        break;

      case "tool-call":
        if (verbose) {
          if (event.stepNumber > currentStep) {
            currentStep = event.stepNumber;
            console.log(`\n--- Step ${String(currentStep)} ---`);
          }
          const inputStr = JSON.stringify(event.input, null, 2)
            .split("\n")
            .map((line, i) => (i === 0 ? line : `  ${line}`))
            .join("\n");
          console.log(`[Tool Call] ${event.toolName}(${inputStr})`);
        } else {
          // Non-verbose: compact tool trace (btca-style)
          console.log(`[${event.toolName}]`);
        }
        break;

      case "tool-result":
        if (verbose) {
          const outputStr =
            typeof event.output === "string"
              ? event.output
              : JSON.stringify(event.output, null, 2);
          const truncated =
            outputStr.length > 500
              ? `${outputStr.slice(0, 500)}... (truncated)`
              : outputStr;
          console.log(`[Tool Result] ${event.toolName} -> ${truncated}`);
        }
        break;

      case "done":
        if (hasAnswerText) {
          console.log("");
        }
        if (verbose) {
          console.log(`\n[Model: ${event.model}]`);
        }
        break;

      case "ping":
        // Keepalive heartbeat -- ignore
        break;

      case "error":
        console.error(`\nError: ${event.message}`);
        break;
    }
  }
}

function inferPortFromEndpoint(endpoint: string): string | null {
  const candidates = endpoint.includes("://")
    ? [endpoint]
    : [`http://${endpoint}`];

  for (const candidate of candidates) {
    try {
      const parsed = new URL(candidate);
      if (parsed.port) {
        return parsed.port;
      }
      return parsed.protocol === "https:" ? "443" : "80";
    } catch {
      continue;
    }
  }

  return null;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function resolveHonoDirectory(): Promise<string> {
  const sourceDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.CTXPACK_HONO_PATH,
    resolvePath(process.cwd(), "apps/honojs"),
    resolvePath(sourceDir, "..", "..", "honojs"),
    resolvePath(sourceDir, "..", "honojs"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    const packageJsonPath = join(candidate, "package.json");
    if (await pathExists(packageJsonPath)) {
      return candidate;
    }
  }

  throw new Error(
    "Unable to find apps/honojs. Set CTXPACK_HONO_PATH to your Hono app directory.",
  );
}

async function resolveDockerComposeDirectory(): Promise<string | null> {
  const sourceDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.CTXPACK_PROJECT_ROOT,
    process.cwd(),
    resolvePath(sourceDir, "..", "..", ".."),
    resolvePath(sourceDir, "..", ".."),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    const composePath = join(candidate, "docker-compose.yml");
    if (await pathExists(composePath)) {
      return candidate;
    }
  }

  return null;
}

const DEFAULT_DATABASE_URL =
  "postgresql://postgres:postgres@localhost:5432/ctxpack";

const PROVIDER_API_KEY_ENV_MAP: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  cohere: "COHERE_API_KEY",
  mistral: "MISTRAL_API_KEY",
  xai: "XAI_API_KEY",
};

async function runShellCommand(
  argv: string[],
  cwd?: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(argv, {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    proc.stdout ? new Response(proc.stdout).text() : Promise.resolve(""),
    proc.stderr ? new Response(proc.stderr).text() : Promise.resolve(""),
  ]);
  return { exitCode, stdout, stderr };
}

async function isDockerContainerRunning(
  containerName: string,
): Promise<boolean> {
  try {
    const result = await runShellCommand([
      "docker",
      "ps",
      "--filter",
      `name=${containerName}`,
      "--filter",
      "status=running",
      "--format",
      "{{.Names}}",
    ]);
    return (
      result.exitCode === 0 && result.stdout.trim().includes(containerName)
    );
  } catch {
    return false;
  }
}

async function ensurePostgresRunning(composeDir: string | null): Promise<void> {
  if (await isDockerContainerRunning("ctxpack-postgres")) {
    console.log("Postgres container already running.");
    return;
  }

  if (!composeDir) {
    console.log(
      "Warning: docker-compose.yml not found. Ensure Postgres is running manually.",
    );
    return;
  }

  console.log("Starting Postgres container...");
  const result = await runShellCommand(
    ["docker", "compose", "up", "-d", "postgres"],
    composeDir,
  );

  if (result.exitCode !== 0) {
    console.error(
      `Warning: Failed to start Postgres via docker compose: ${result.stderr.trim() || result.stdout.trim()}`,
    );
    return;
  }

  console.log("Waiting for Postgres to be ready...");
  const maxAttempts = 30;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const health = await runShellCommand([
      "docker",
      "exec",
      "ctxpack-postgres",
      "pg_isready",
      "-U",
      "postgres",
      "-d",
      "ctxpack",
    ]);

    if (health.exitCode === 0) {
      console.log("Postgres is ready.");
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  console.log(
    "Warning: Postgres health check timed out. The server may fail to connect.",
  );
}

async function ensureDatabaseSchema(
  databaseUrl: string,
  dbPackageDir: string | null,
): Promise<void> {
  if (!dbPackageDir) {
    return;
  }

  console.log("Pushing database schema...");
  const result = await runShellCommand(
    ["bunx", "drizzle-kit", "push", "--force"],
    dbPackageDir,
  );

  if (result.exitCode !== 0) {
    console.error(
      `Warning: Schema push failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
    return;
  }

  console.log("Database schema is up to date.");
}

async function resolveDbPackageDirectory(): Promise<string | null> {
  const sourceDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolvePath(process.cwd(), "packages/db"),
    resolvePath(sourceDir, "..", "..", "..", "packages", "db"),
    resolvePath(sourceDir, "..", "..", "packages", "db"),
  ];

  for (const candidate of candidates) {
    if (await pathExists(join(candidate, "drizzle.config.ts"))) {
      return candidate;
    }
  }

  return null;
}

function resolveProviderApiKey(
  providerId: string,
  providerApiKeyEnv: string | undefined,
  auth: AuthFile,
  childEnv: Record<string, string | undefined>,
): void {
  const normalizedProviderId = providerId.toLowerCase();
  const standardEnvVar = PROVIDER_API_KEY_ENV_MAP[normalizedProviderId];
  if (!standardEnvVar) {
    return;
  }

  if (childEnv[standardEnvVar]) {
    return;
  }

  if (providerApiKeyEnv && process.env[providerApiKeyEnv]) {
    childEnv[standardEnvVar] = process.env[providerApiKeyEnv];
    return;
  }

  const storedCred = auth[normalizedProviderId] ?? auth[providerId];
  if (storedCred?.type === "apikey" && storedCred.apiKey.trim()) {
    childEnv[standardEnvVar] = storedCred.apiKey.trim();
  }
}

async function handleServer(parsed: ParsedArgv): Promise<void> {
  const ensured = await ensureProjectConfig();
  await ensureCtxpackHomeDirectories();

  const overrideEndpoint = getOptionString(parsed.options, ["endpoint", "e"]);
  const endpoint =
    overrideEndpoint ??
    ensured.config.server?.endpoint ??
    "http://localhost:3000";
  const portOption = getOptionString(parsed.options, ["port", "p"]);
  const port = portOption ?? inferPortFromEndpoint(endpoint) ?? "3000";

  const storageRoot = ensured.config.storage?.root ?? getCtxpackHomePath();
  const reposPath = ensured.config.storage?.repos ?? getCtxpackReposPath();
  const embeddingProvider = ensured.config.provider?.id ?? "openai";
  const embeddingModel =
    ensured.config.models?.embedding ??
    ensured.config.provider?.model ??
    "text-embedding-3-small";
  const chatProvider = ensured.config.provider?.id ?? "openai";
  const researchProvider =
    process.env.CTXPACK_RESEARCH_PROVIDER?.toLowerCase() ?? chatProvider;
  const chatModel = ensured.config.models?.chat ?? DEFAULT_CODEX_CHAT_MODEL;
  const providerApiKeyEnv = ensured.config.provider?.apiKeyEnv;
  const sandboxRoot =
    process.env.CTXPACK_SANDBOX_ROOT_PATH ?? join(storageRoot, "sandbox");

  const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;

  const skipSetup = getOptionBoolean(parsed.options, ["skip-setup"]);

  if (!skipSetup) {
    const composeDir = await resolveDockerComposeDirectory();
    await ensurePostgresRunning(composeDir);

    const dbPackageDir = await resolveDbPackageDirectory();
    await ensureDatabaseSchema(databaseUrl, dbPackageDir);
  }

  const honoDirectory = await resolveHonoDirectory();

  // Detect OpenAI OAuth credentials and refresh if needed
  let openaiAuthMode = "apikey";
  let openaiOAuthCredential: OAuthCredential | undefined;
  if (chatProvider === "openai" || researchProvider === "openai") {
    try {
      const oauthCred = await ensureFreshOAuthTokens("openai");
      if (oauthCred) {
        openaiOAuthCredential = oauthCred;
        openaiAuthMode = "oauth";
        console.log(
          "OpenAI auth default: OAuth (ChatGPT subscription, fallback only)",
        );
      }
    } catch (err) {
      // OAuth not configured or refresh failed -- fall back to API key
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes("refresh failed")) {
        console.log(
          `Warning: OpenAI OAuth token refresh failed. Falling back to API key. Run \`ctxpack connect openai\` to re-authenticate.`,
        );
      }
    }
  }

  let effectiveChatModel = chatModel;
  if (
    openaiAuthMode === "oauth" &&
    (chatProvider === "openai" || researchProvider === "openai") &&
    !CODEX_MODELS.has(effectiveChatModel)
  ) {
    console.log(
      `Warning: Chat model ${effectiveChatModel} is not supported for OpenAI OAuth. Using ${DEFAULT_CODEX_CHAT_MODEL}.`,
    );
    effectiveChatModel = DEFAULT_CODEX_CHAT_MODEL;
  }

  console.log(`Starting server from ${honoDirectory}`);
  console.log(`Port: ${port}`);
  console.log(`Repo storage: ${reposPath}`);
  console.log(
    "Model/API config mode: per-request overrides from CLI headers are enabled.",
  );
  console.log(
    "Startup values below are defaults/fallbacks when a request does not include overrides.",
  );
  console.log(`Default embedding fallback: ${embeddingProvider}/${embeddingModel}`);
  console.log(
    `Default chat fallback: ${chatProvider}/${effectiveChatModel}${openaiAuthMode === "oauth" ? " (OAuth)" : ""}`,
  );

  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    PORT: port,
    DATABASE_URL: databaseUrl,
    CTXPACK_HOME: storageRoot,
    REPO_STORAGE_PATH: reposPath,
    CTXPACK_SANDBOX_ROOT_PATH: sandboxRoot,
    CTXPACK_EMBEDDING_PROVIDER: embeddingProvider,
    CTXPACK_EMBEDDING_MODEL: embeddingModel,
    CTXPACK_CHAT_PROVIDER: chatProvider,
    CTXPACK_CHAT_MODEL: effectiveChatModel,
    CTXPACK_OPENAI_AUTH_MODE: openaiAuthMode === "oauth" ? "oauth" : undefined,
    CTXPACK_OPENAI_OAUTH_ACCESS_TOKEN:
      openaiAuthMode === "oauth" && openaiOAuthCredential
        ? openaiOAuthCredential.accessToken
        : undefined,
    CTXPACK_OPENAI_OAUTH_ACCOUNT_ID:
      openaiAuthMode === "oauth" && openaiOAuthCredential
        ? openaiOAuthCredential.accountId
        : undefined,
  };

  const auth = await readAuthFile();

  resolveProviderApiKey(embeddingProvider, providerApiKeyEnv, auth, childEnv);
  resolveProviderApiKey(chatProvider, providerApiKeyEnv, auth, childEnv);

  if (embeddingProvider === "openai" && !childEnv.OPENAI_API_KEY) {
    console.log(
      "Warning: OpenAI embeddings require OPENAI_API_KEY (env or stored API key credential).",
    );
  }

  const child = Bun.spawn(["bun", "run", "dev"], {
    cwd: honoDirectory,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: childEnv,
  });

  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`Server process exited with code ${String(exitCode)}`);
  }
}

/* ------------------------------------------------------------------ */
/*  Tool commands: grep, read, list, glob                              */
/* ------------------------------------------------------------------ */

async function resolveResourceIdForTool(
  client: InstanceType<typeof CtxpackApiClient>,
  parsed: ParsedArgv,
): Promise<string> {
  const resourceNames = getOptionArray(parsed.options, ["resource", "r"]);
  if (resourceNames.length === 0) {
    throw new Error("--resource <name-or-id> is required for tool commands.");
  }
  const resolved = await resolveResourceNames(client, [resourceNames[0]!]);
  return resolved[0]!;
}

async function handleGrep(parsed: ParsedArgv): Promise<void> {
  const pattern = parsed.positionals[0];
  if (!pattern) {
    throw new Error("Usage: ctxpack grep <pattern> --resource <name-or-id>");
  }

  const { client } = await createApiContext(parsed);
  const resourceId = await resolveResourceIdForTool(client, parsed);
  const paths = getOptionArray(parsed.options, ["paths", "p"]);
  const caseSensitive = getOptionBoolean(parsed.options, [
    "case-sensitive",
    "cs",
  ]);

  const result = await client.toolGrep({
    resourceId,
    pattern,
    ...(paths.length > 0 ? { paths } : {}),
    caseSensitive: caseSensitive || undefined,
  });

  if (result.matches.length === 0) {
    console.log("No matches.");
    return;
  }

  for (const match of result.matches) {
    console.log(`${match.filepath}:${match.line}: ${match.text}`);
  }
}

async function handleRead(parsed: ParsedArgv): Promise<void> {
  const filepath = parsed.positionals[0];
  if (!filepath) {
    throw new Error("Usage: ctxpack read <filepath> --resource <name-or-id>");
  }

  const { client } = await createApiContext(parsed);
  const resourceId = await resolveResourceIdForTool(client, parsed);
  const startLine = getOptionNumber(parsed.options, ["start-line", "start"]);
  const endLine = getOptionNumber(parsed.options, ["end-line", "end"]);

  const result = await client.toolRead({
    resourceId,
    filepath,
    ...(startLine ? { startLine } : {}),
    ...(endLine ? { endLine } : {}),
  });

  console.log(result.content);
}

async function handleListFiles(parsed: ParsedArgv): Promise<void> {
  const { client } = await createApiContext(parsed);
  const resourceId = await resolveResourceIdForTool(client, parsed);
  const subpath = getOptionString(parsed.options, ["path"]);

  const result = await client.toolList({
    resourceId,
    ...(subpath ? { path: subpath } : {}),
  });

  if (result.files.length === 0) {
    console.log("No files found.");
    return;
  }

  for (const file of result.files) {
    console.log(file);
  }
}

async function handleGlob(parsed: ParsedArgv): Promise<void> {
  const pattern = parsed.positionals[0];
  if (!pattern) {
    throw new Error("Usage: ctxpack glob <pattern> --resource <name-or-id>");
  }

  const { client } = await createApiContext(parsed);
  const resourceId = await resolveResourceIdForTool(client, parsed);

  const result = await client.toolGlob({
    resourceId,
    pattern,
  });

  if (result.files.length === 0) {
    console.log("No files matched.");
    return;
  }

  for (const file of result.files) {
    console.log(file);
  }
}

async function handleResearchStatus(parsed: ParsedArgv): Promise<void> {
  const jobId = parsed.positionals[0];
  if (!jobId) {
    throw new Error("Usage: ctxpack research-status <job-id>");
  }

  const { client } = await createApiContext(parsed);
  const job: ResearchJob = await client.getResearchJob(jobId);

  console.log(`Research Job: ${job.id}`);
  console.log(`Status: ${job.status}`);
  console.log(`Query: ${job.query}`);
  if (job.startedAt) console.log(`Started: ${job.startedAt}`);
  if (job.completedAt) console.log(`Completed: ${job.completedAt}`);

  if (job.status === "failed" && job.error) {
    console.error(`Error: ${job.error}`);
    return;
  }

  if (job.status === "completed" && job.result) {
    const verbose = getOptionBoolean(parsed.options, ["verbose", "v"]);
    printExploreResponse(job.result, verbose);
  } else if (job.status === "queued" || job.status === "running") {
    console.log("\nJob is still running. Check again later.");
  }
}

async function routeRemote(parsed: ParsedArgv): Promise<void> {
  const sub = parsed.subcommand;
  if (!sub) {
    throw new Error(
      "Usage: ctxpack remote <link|unlink|add|list|ask|rm|sync|index|job|updates>",
    );
  }

  if (sub === "link") {
    await handleRemoteLink(parsed);
    return;
  }

  if (sub === "unlink") {
    await handleRemoteUnlink();
    return;
  }

  if (sub === "sync") {
    console.log("Remote sync is not implemented yet.");
    return;
  }

  const aliased: ParsedArgv = {
    ...parsed,
    command: sub,
    subcommand: null,
    options: {
      ...parsed.options,
      __remote: true,
    },
  };

  await runCommand(aliased);
}

async function runCommand(parsed: ParsedArgv): Promise<void> {
  const command = parsed.command ?? "help";

  switch (command) {
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    case "setup":
    case "init":
      await handleSetup(parsed);
      return;
    case "connect":
      await handleConnect(parsed);
      return;
    case "disconnect":
      await handleDisconnect();
      return;
    case "auth":
      await routeAuth(parsed);
      return;
    case "config":
      await handleShowConfig();
      return;
    case "server":
    case "serve":
      await handleServer(parsed);
      return;
    case "list":
      if (getOptionArray(parsed.options, ["resource", "r"]).length > 0) {
        await handleListFiles(parsed);
      } else {
        await handleList(parsed);
      }
      return;
    case "add":
      await handleAdd(parsed);
      return;
    case "rm":
    case "remove":
      await handleRemove(parsed);
      return;
    case "index":
      await handleIndex(parsed);
      return;
    case "sync":
      await handleSync(parsed);
      return;
    case "reindex":
      await handleReindex(parsed);
      return;
    case "updates":
      await handleUpdates(parsed);
      return;
    case "job":
      await handleJob(parsed);
      return;
    case "search":
      await handleSearch(parsed);
      return;
    case "ask":
      // `ask` is an alias for `search --explore`
      parsed.options.explore = true;
      await handleSearch(parsed);
      return;
    case "research-status":
      await handleResearchStatus(parsed);
      return;
    case "grep":
      await handleGrep(parsed);
      return;
    case "read":
      await handleRead(parsed);
      return;
    case "files":
      await handleListFiles(parsed);
      return;
    case "glob":
      await handleGlob(parsed);
      return;
    case "remote":
      await routeRemote(parsed);
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

async function main(): Promise<void> {
  const parsed = parseArgv(process.argv.slice(2));
  if (!parsed.command) {
    if (getOptionBoolean(parsed.options, ["help", "h"])) {
      printHelp();
      return;
    }
    await handleSetup(parsed);
    return;
  }
  await runCommand(parsed);
}

void main().catch((error) => {
  console.error(`Error: ${toErrorMessage(error)}`);
  process.exitCode = 1;
});
