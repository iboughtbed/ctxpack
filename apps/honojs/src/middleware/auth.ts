import { createMiddleware } from "hono/factory";
import { eq } from "drizzle-orm";

import { auth, AUTH_API_KEY_HEADERS } from "@ctxpack/auth";
import { db } from "@ctxpack/db";
import { users } from "@ctxpack/db/schema";

import type {
  ApiKeyContext,
  Context,
  ModelConfig,
  ProviderKeys,
} from "../context";

type AuthenticatedSession = {
  user: NonNullable<Context["Variables"]["user"]>;
  session: NonNullable<Context["Variables"]["session"]>;
};

function unwrapApiResult(value: unknown): unknown {
  if (
    value &&
    typeof value === "object" &&
    "data" in value &&
    (value as { data?: unknown }).data !== undefined
  ) {
    return (value as { data?: unknown }).data;
  }
  return value;
}

function parseSessionResult(value: unknown): AuthenticatedSession | null {
  const payload = unwrapApiResult(value);
  if (!payload || typeof payload !== "object") {
    return null;
  }

  if (!("user" in payload) || !("session" in payload)) {
    return null;
  }

  const user = (payload as { user?: unknown }).user;
  const session = (payload as { session?: unknown }).session;

  if (
    !user ||
    typeof user !== "object" ||
    !session ||
    typeof session !== "object"
  ) {
    return null;
  }

  return {
    user: user as NonNullable<Context["Variables"]["user"]>,
    session: session as NonNullable<Context["Variables"]["session"]>,
  };
}

function normalizePermissions(value: unknown): Record<string, string[]> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const normalized: Record<string, string[]> = {};
  for (const [resource, actions] of Object.entries(value)) {
    if (!Array.isArray(actions)) {
      continue;
    }

    const validActions = actions.filter(
      (action): action is string =>
        typeof action === "string" && action.length > 0,
    );
    if (validActions.length > 0) {
      normalized[resource] = validActions;
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : null;
}

function parseVerifyApiKeyResult(value: unknown): ApiKeyContext | null {
  const payload = unwrapApiResult(value);
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const valid = (payload as { valid?: unknown }).valid === true;
  if (!valid) {
    return null;
  }

  const key = (payload as { key?: unknown }).key;
  if (!key || typeof key !== "object") {
    return null;
  }

  const id = (key as { id?: unknown }).id;
  const userId = (key as { userId?: unknown }).userId;
  if (typeof id !== "string" || id.length === 0) {
    return null;
  }
  if (typeof userId !== "string" || userId.length === 0) {
    return null;
  }

  const name = (key as { name?: unknown }).name;
  const prefix = (key as { prefix?: unknown }).prefix;
  const permissions = normalizePermissions(
    (key as { permissions?: unknown }).permissions,
  );

  return {
    id,
    userId,
    name: typeof name === "string" ? name : null,
    prefix: typeof prefix === "string" ? prefix : null,
    permissions,
    metadata: (key as { metadata?: unknown }).metadata ?? null,
  };
}

function extractApiKey(headers: Headers): string | null {
  for (const header of AUTH_API_KEY_HEADERS) {
    const value = headers.get(header);
    if (!value) {
      continue;
    }

    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  return null;
}

async function loadUserById(
  userId: string,
): Promise<NonNullable<Context["Variables"]["user"]> | null> {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) {
    return null;
  }

  return user as unknown as NonNullable<Context["Variables"]["user"]>;
}

/**
 * Extracts per-request provider API keys from `x-provider-*-key` headers.
 * These are sent by the CLI so the Hono server can use them when calling
 * AI SDK providers, without relying solely on server-side env vars.
 */
function extractProviderKeys(headers: Headers): ProviderKeys {
  const packed = parseJsonHeader(headers, "x-ctxpack-provider-keys");
  if (packed && typeof packed === "object") {
    const payload = packed as Record<string, unknown>;
    return {
      openai: asNonEmptyString(payload.openai),
      anthropic: asNonEmptyString(payload.anthropic),
      google: asNonEmptyString(payload.google),
      openaiOAuthToken: asNonEmptyString(payload.openaiOAuthToken),
      openaiOAuthAccountId: asNonEmptyString(payload.openaiOAuthAccountId),
    };
  }

  const keys: ProviderKeys = {};
  const openai = headers.get("x-provider-openai-key");
  if (openai) keys.openai = openai;
  const anthropic = headers.get("x-provider-anthropic-key");
  if (anthropic) keys.anthropic = anthropic;
  const google = headers.get("x-provider-google-key");
  if (google) keys.google = google;
  const oauthToken = headers.get("x-provider-openai-oauth-token");
  if (oauthToken) keys.openaiOAuthToken = oauthToken;
  const oauthAccountId = headers.get("x-provider-openai-oauth-account-id");
  if (oauthAccountId) keys.openaiOAuthAccountId = oauthAccountId;
  return keys;
}

function readHeader(headers: Headers, name: string): string | undefined {
  const value = headers.get(name)?.trim();
  return value && value.length > 0 ? value : undefined;
}

function extractModelConfig(headers: Headers): ModelConfig {
  const packed = parseJsonHeader(headers, "x-ctxpack-model-config");
  if (packed && typeof packed === "object") {
    const payload = packed as Record<string, unknown>;
    return {
      embeddingProvider: asNonEmptyString(payload.embeddingProvider),
      embeddingModel: asNonEmptyString(payload.embeddingModel),
      chatProvider: asNonEmptyString(payload.chatProvider),
      chatModel: asNonEmptyString(payload.chatModel),
      researchProvider: asNonEmptyString(payload.researchProvider),
      researchModel: asNonEmptyString(payload.researchModel),
    };
  }

  return {
    embeddingProvider: readHeader(headers, "x-model-embedding-provider"),
    embeddingModel: readHeader(headers, "x-model-embedding"),
    chatProvider: readHeader(headers, "x-model-chat-provider"),
    chatModel: readHeader(headers, "x-model-chat"),
    researchProvider: readHeader(headers, "x-model-research-provider"),
    researchModel: readHeader(headers, "x-model-research"),
  };
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseJsonHeader(headers: Headers, name: string): unknown {
  const raw = headers.get(name);
  if (!raw || raw.trim().length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export const withAuth = createMiddleware<Context>(async (c, next) => {
  // Always extract provider keys, regardless of auth mode.
  c.set("providerKeys", extractProviderKeys(c.req.raw.headers));
  c.set("modelConfig", extractModelConfig(c.req.raw.headers));

  const setAnonymous = () => {
    c.set("user", null);
    c.set("session", null);
    c.set("authMode", "anonymous");
    c.set("apiKey", null);
  };

  const setSessionAuth = (session: AuthenticatedSession) => {
    c.set("user", session.user);
    c.set("session", session.session);
    c.set("authMode", "session");
    c.set("apiKey", null);
  };

  const setApiKeyAuth = (
    user: NonNullable<Context["Variables"]["user"]>,
    apiKey: ApiKeyContext,
  ) => {
    c.set("user", user);
    c.set("session", null);
    c.set("authMode", "api_key");
    c.set("apiKey", apiKey);
  };

  const headers = c.req.raw.headers;

  const sessionResult = await auth.api.getSession({ headers });
  const authenticatedSession = parseSessionResult(sessionResult);
  if (authenticatedSession) {
    setSessionAuth(authenticatedSession);
    await next();
    return;
  }

  const apiKey = extractApiKey(headers);
  if (!apiKey) {
    setAnonymous();
    await next();
    return;
  }

  const verifyResult = await auth.api.verifyApiKey({
    body: {
      key: apiKey,
    },
  });
  const verifiedKey = parseVerifyApiKeyResult(verifyResult);
  if (!verifiedKey) {
    setAnonymous();
    await next();
    return;
  }

  const user = await loadUserById(verifiedKey.userId);
  if (!user) {
    setAnonymous();
    await next();
    return;
  }

  setApiKeyAuth(user, verifiedKey);
  await next();
});
