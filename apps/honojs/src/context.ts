import type { auth } from "@ctxpack/auth";

export type ApiKeyContext = {
  id: string;
  userId: string;
  name: string | null;
  prefix: string | null;
  permissions: Record<string, string[]> | null;
  metadata: unknown;
};

export type AuthMode = "anonymous" | "session" | "api_key";

/** Per-request provider API keys / OAuth tokens sent by the CLI via headers. */
export type ProviderKeys = {
  openai?: string;
  anthropic?: string;
  google?: string;
  /** OpenAI OAuth access token (ChatGPT Plus/Pro subscription via Codex). */
  openaiOAuthToken?: string;
  /** OpenAI OAuth account ID (optional, for multi-account setups). */
  openaiOAuthAccountId?: string;
};

/** Per-request model/provider overrides sent by the CLI via headers. */
export type ModelConfig = {
  embeddingProvider?: string;
  embeddingModel?: string;
  chatProvider?: string;
  chatModel?: string;
  researchProvider?: string;
  researchModel?: string;
};

export type Context = {
  Variables: {
    user: typeof auth.$Infer.Session.user | null;
    session: typeof auth.$Infer.Session.session | null;
    authMode: AuthMode;
    apiKey: ApiKeyContext | null;
    providerKeys: ProviderKeys;
    modelConfig: ModelConfig;
  };
};
