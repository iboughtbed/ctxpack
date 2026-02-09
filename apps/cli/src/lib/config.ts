import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type CliConfig = {
  remote?: {
    endpoint?: string;
    apiKey?: string;
  };
};

export type SearchMode = "hybrid" | "text" | "vector";

export type ProjectConfig = {
  $schema?: string;
  server?: {
    endpoint?: string;
  };
  storage?: {
    root?: string;
    repos?: string;
    data?: string;
    logs?: string;
  };
  provider?: {
    id?: string;
    model?: string;
    apiKeyEnv?: string;
  };
  models?: {
    embedding?: string;
    chat?: string;
  };
  defaults?: {
    searchMode?: SearchMode;
    alpha?: number;
    topK?: number;
  };
  resources?: unknown[];
};

const DEFAULT_ENDPOINT = "http://localhost:8787";
const PROJECT_CONFIG_FILENAME = "ctxpack.config.jsonc";
const DEFAULT_SCHEMA_URL = "https://ctxpack.dev/schema.json";
const DEFAULT_PROVIDER_ID = "openai";
const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_CHAT_MODEL = "gpt-5.2-codex";
const DEFAULT_API_KEY_ENV = "OPENAI_API_KEY";

export function getCtxpackHomePath(): string {
  return process.env.CTXPACK_HOME ?? join(homedir(), ".ctxpack");
}

export function getCtxpackReposPath(): string {
  return join(getCtxpackHomePath(), "repos");
}

export function getCtxpackDataPath(): string {
  return join(getCtxpackHomePath(), "data");
}

export function getCtxpackLogsPath(): string {
  return join(getCtxpackHomePath(), "logs");
}

export function getAuthFilePath(): string {
  return join(getCtxpackHomePath(), "auth.json");
}

export async function ensureCtxpackHomeDirectories(): Promise<void> {
  await Promise.all([
    mkdir(getCtxpackHomePath(), { recursive: true }),
    mkdir(getCtxpackReposPath(), { recursive: true }),
    mkdir(getCtxpackDataPath(), { recursive: true }),
    mkdir(getCtxpackLogsPath(), { recursive: true }),
  ]);
}

export function getConfigPath(): string {
  return process.env.CTXPACK_CONFIG_PATH ?? join(getCtxpackHomePath(), "config.json");
}

export function getProjectConfigPath(cwd = process.cwd()): string {
  return join(cwd, PROJECT_CONFIG_FILENAME);
}

export async function readConfig(): Promise<CliConfig> {
  const path = getConfigPath();
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as CliConfig;
    return parsed ?? {};
  } catch {
    return {};
  }
}

export async function writeConfig(config: CliConfig): Promise<void> {
  const path = getConfigPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function parseJsonc(raw: string): unknown {
  const withoutBlockComments = raw.replace(/\/\*[\s\S]*?\*\//g, "");
  const withoutLineComments = withoutBlockComments.replace(
    /^[\t ]*\/\/.*$/gm,
    "",
  );
  const withoutTrailingCommas = withoutLineComments.replace(/,\s*([}\]])/g, "$1");
  return JSON.parse(withoutTrailingCommas);
}

export function createDefaultProjectConfig(): ProjectConfig {
  const homePath = getCtxpackHomePath();
  return {
    $schema: DEFAULT_SCHEMA_URL,
    server: {
      endpoint: DEFAULT_ENDPOINT,
    },
    storage: {
      root: homePath,
      repos: getCtxpackReposPath(),
      data: getCtxpackDataPath(),
      logs: getCtxpackLogsPath(),
    },
    provider: {
      id: DEFAULT_PROVIDER_ID,
      model: DEFAULT_EMBEDDING_MODEL,
      apiKeyEnv: DEFAULT_API_KEY_ENV,
    },
    models: {
      embedding: DEFAULT_EMBEDDING_MODEL,
      chat: DEFAULT_CHAT_MODEL,
    },
    defaults: {
      searchMode: "hybrid",
      alpha: 0.5,
      topK: 10,
    },
    resources: [],
  };
}

export async function readProjectConfig(
  configPath = getProjectConfigPath(),
): Promise<ProjectConfig | null> {
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = parseJsonc(raw) as ProjectConfig;
    return parsed ?? null;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

export async function writeProjectConfig(
  config: ProjectConfig,
  configPath = getProjectConfigPath(),
): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  const contents = `${JSON.stringify(config, null, 2)}\n`;
  await writeFile(configPath, contents, "utf8");
}

export async function ensureProjectConfig(
  configPath = getProjectConfigPath(),
): Promise<{ path: string; config: ProjectConfig; created: boolean }> {
  const existing = await readProjectConfig(configPath);
  if (existing) {
    return {
      path: configPath,
      config: existing,
      created: false,
    };
  }

  const config = createDefaultProjectConfig();
  await writeProjectConfig(config, configPath);
  return {
    path: configPath,
    config,
    created: true,
  };
}

export function resolveEndpoint(
  config: CliConfig,
  override?: string,
  projectConfig?: ProjectConfig | null,
  preferRemote = false,
): string {
  if (override) {
    return override;
  }

  if (process.env.CTXPACK_API_URL) {
    return process.env.CTXPACK_API_URL;
  }

  if (preferRemote && config.remote?.endpoint) {
    return config.remote.endpoint;
  }

  if (projectConfig?.server?.endpoint) {
    return projectConfig.server.endpoint;
  }

  return (
    config.remote?.endpoint ??
    DEFAULT_ENDPOINT
  );
}

export function resolveApiKey(
  config: CliConfig,
  override?: string,
): string | undefined {
  const apiKey = override ?? process.env.CTXPACK_API_KEY ?? config.remote?.apiKey;
  if (!apiKey || apiKey.trim().length === 0) {
    return undefined;
  }
  return apiKey.trim();
}

export function isLocalEndpoint(endpoint: string): boolean {
  const candidates = endpoint.includes("://")
    ? [endpoint]
    : [`http://${endpoint}`];

  for (const candidate of candidates) {
    try {
      const parsed = new URL(candidate);
      return ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
    } catch {
      continue;
    }
  }

  return false;
}

export async function saveRemoteConfig(params: {
  endpoint?: string;
  apiKey?: string;
}): Promise<void> {
  const config = await readConfig();
  const remote = {
    ...config.remote,
    ...(params.endpoint ? { endpoint: params.endpoint } : {}),
    ...(params.apiKey ? { apiKey: params.apiKey } : {}),
  };

  await writeConfig({
    ...config,
    remote,
  });
}

export async function clearRemoteApiKey(): Promise<void> {
  const config = await readConfig();
  const endpoint = config.remote?.endpoint;
  await writeConfig({
    ...config,
    remote: endpoint ? { endpoint } : {},
  });
}
