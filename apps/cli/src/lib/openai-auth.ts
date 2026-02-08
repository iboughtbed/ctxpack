/**
 * OpenAI OAuth authentication for ctxpack CLI.
 *
 * Implements the OAuth 2.0 PKCE flow against auth.openai.com, adapted from
 * OpenCode's Codex Auth Plugin. Uses a link-based browser OAuth flow.
 *
 * Tokens are persisted in ~/.ctxpack/auth.json and mirrored to OpenCode's
 * auth store (~/.local/share/opencode/auth.json on Linux/macOS, %APPDATA% on
 * Windows) for interoperability.
 *
 * OpenCode OAuth: @see https://github.com/davis7dotsh/better-context/blob/main/apps/cli/src/lib/opencode-oauth.ts
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { getAuthFilePath } from "./config";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER = "https://auth.openai.com";
const OAUTH_PORT = 1455;
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const DEVICE_CODE_POLL_SAFETY_MS = 3000;

/** Models available through the ChatGPT subscription OAuth flow. */
export const CODEX_MODELS = new Set([
  "gpt-5.2-codex",
  "gpt-5.3-codex",
  "gpt-5.1-codex-max",
  "gpt-5.2",
  "gpt-5.1-codex-mini",
]);

export const DEFAULT_CODEX_CHAT_MODEL = "gpt-5.2-codex";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type OAuthCredential = {
  type: "oauth";
  accessToken: string;
  refreshToken: string;
  accountId?: string;
  expiresAt: number;
};

export type ApiKeyCredential = {
  type: "apikey";
  apiKey: string;
};

export type ProviderCredential = OAuthCredential | ApiKeyCredential;

export type AuthFile = {
  [providerId: string]: ProviderCredential;
};

type OpenCodeAuthRecord = Record<string, unknown>;

interface TokenResponse {
  id_token: string;
  access_token: string;
  refresh_token: string;
  expires_in?: number;
}

interface IdTokenClaims {
  chatgpt_account_id?: string;
  organizations?: Array<{ id: string }>;
  email?: string;
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string;
  };
}

interface PkceCodes {
  verifier: string;
  challenge: string;
}

/* ------------------------------------------------------------------ */
/*  Shared auth path helpers                                           */
/* ------------------------------------------------------------------ */

function resolveOpenCodeDataPath(): string {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    return join(appData || join(homedir(), "AppData", "Roaming"), "opencode");
  }

  const xdgDataHome = process.env.XDG_DATA_HOME;
  return join(xdgDataHome || join(homedir(), ".local", "share"), "opencode");
}

export function getOpenCodeAuthFilePath(): string {
  return join(resolveOpenCodeDataPath(), "auth.json");
}

/* ------------------------------------------------------------------ */
/*  Auth record mappers                                                */
/* ------------------------------------------------------------------ */

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseCtxpackCredential(
  value: unknown,
): ProviderCredential | undefined {
  if (!isObjectRecord(value)) return undefined;

  if (value.type === "apikey" && typeof value.apiKey === "string") {
    return {
      type: "apikey",
      apiKey: value.apiKey,
    };
  }

  if (
    value.type === "oauth" &&
    typeof value.accessToken === "string" &&
    typeof value.refreshToken === "string" &&
    typeof value.expiresAt === "number"
  ) {
    return {
      type: "oauth",
      accessToken: value.accessToken,
      refreshToken: value.refreshToken,
      expiresAt: value.expiresAt,
      accountId:
        typeof value.accountId === "string" ? value.accountId : undefined,
    };
  }

  return undefined;
}

function parseOpenCodeCredential(
  value: unknown,
): ProviderCredential | undefined {
  if (!isObjectRecord(value)) return undefined;

  if (value.type === "api" && typeof value.key === "string") {
    return {
      type: "apikey",
      apiKey: value.key,
    };
  }

  if (
    value.type === "oauth" &&
    typeof value.access === "string" &&
    typeof value.refresh === "string" &&
    typeof value.expires === "number"
  ) {
    return {
      type: "oauth",
      accessToken: value.access,
      refreshToken: value.refresh,
      expiresAt: value.expires,
      accountId:
        typeof value.accountId === "string" ? value.accountId : undefined,
    };
  }

  return undefined;
}

function toOpenCodeCredential(
  credential: ProviderCredential,
): OpenCodeAuthRecord {
  if (credential.type === "apikey") {
    return {
      type: "api",
      key: credential.apiKey,
    };
  }

  return {
    type: "oauth",
    access: credential.accessToken,
    refresh: credential.refreshToken,
    expires: credential.expiresAt,
    ...(credential.accountId ? { accountId: credential.accountId } : {}),
  };
}

async function readJsonRecord(path: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return isObjectRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function readCtxpackAuthFileOnly(): Promise<AuthFile> {
  const parsed = await readJsonRecord(getAuthFilePath());
  const auth: AuthFile = {};

  for (const [providerId, rawCredential] of Object.entries(parsed)) {
    const credential = parseCtxpackCredential(rawCredential);
    if (credential) {
      auth[providerId] = credential;
    }
  }

  return auth;
}

async function writeCtxpackAuthFileOnly(auth: AuthFile): Promise<void> {
  const path = getAuthFilePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(auth, null, 2)}\n`, "utf8");
}

async function upsertOpenCodeProviderAuth(
  providerId: string,
  credential: ProviderCredential,
): Promise<void> {
  const path = getOpenCodeAuthFilePath();
  const auth = await readJsonRecord(path);
  auth[providerId] = toOpenCodeCredential(credential);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(auth, null, 2)}\n`, "utf8");
}

async function removeOpenCodeProviderAuth(providerId: string): Promise<void> {
  const path = getOpenCodeAuthFilePath();
  const auth = await readJsonRecord(path);
  if (!(providerId in auth)) return;
  delete auth[providerId];
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(auth, null, 2)}\n`, "utf8");
}

/* ------------------------------------------------------------------ */
/*  PKCE helpers                                                       */
/* ------------------------------------------------------------------ */

function generateRandomString(length: number): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes)
    .map((b) => chars[b % chars.length])
    .join("");
}

function base64UrlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const binary = String.fromCharCode(...bytes);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function generatePKCE(): Promise<PkceCodes> {
  const verifier = generateRandomString(43);
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const challenge = base64UrlEncode(hash);
  return { verifier, challenge };
}

function generateState(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer);
}

/* ------------------------------------------------------------------ */
/*  JWT helpers                                                        */
/* ------------------------------------------------------------------ */

function parseJwtClaims(token: string): IdTokenClaims | undefined {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return undefined;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString());
  } catch {
    return undefined;
  }
}

function extractAccountIdFromClaims(claims: IdTokenClaims): string | undefined {
  return (
    claims.chatgpt_account_id ||
    claims["https://api.openai.com/auth"]?.chatgpt_account_id ||
    claims.organizations?.[0]?.id
  );
}

function extractAccountId(tokens: TokenResponse): string | undefined {
  if (tokens.id_token) {
    const claims = parseJwtClaims(tokens.id_token);
    const accountId = claims && extractAccountIdFromClaims(claims);
    if (accountId) return accountId;
  }
  if (tokens.access_token) {
    const claims = parseJwtClaims(tokens.access_token);
    return claims ? extractAccountIdFromClaims(claims) : undefined;
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/*  Token exchange / refresh                                           */
/* ------------------------------------------------------------------ */

async function exchangeCodeForTokens(
  code: string,
  redirectUri: string,
  pkce: PkceCodes,
): Promise<TokenResponse> {
  const response = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
      code_verifier: pkce.verifier,
    }).toString(),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Token exchange failed (${String(response.status)}): ${text}`,
    );
  }
  return response.json() as Promise<TokenResponse>;
}

export async function refreshAccessToken(
  refreshToken: string,
): Promise<TokenResponse> {
  const response = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }).toString(),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Token refresh failed (${String(response.status)}): ${text}`,
    );
  }
  return response.json() as Promise<TokenResponse>;
}

/* ------------------------------------------------------------------ */
/*  Auth file persistence                                              */
/* ------------------------------------------------------------------ */

export async function readAuthFile(): Promise<AuthFile> {
  const merged = await readCtxpackAuthFileOnly();
  const openCodeAuth = await readJsonRecord(getOpenCodeAuthFilePath());

  for (const [providerId, rawCredential] of Object.entries(openCodeAuth)) {
    if (providerId in merged) continue;
    const credential = parseOpenCodeCredential(rawCredential);
    if (credential) {
      merged[providerId] = credential;
    }
  }

  return merged;
}

export async function writeAuthFile(auth: AuthFile): Promise<void> {
  await writeCtxpackAuthFileOnly(auth);
  await Promise.all(
    Object.entries(auth).map(([providerId, credential]) =>
      upsertOpenCodeProviderAuth(providerId, credential),
    ),
  );
}

export async function getProviderAuth(
  providerId: string,
): Promise<ProviderCredential | undefined> {
  const auth = await readAuthFile();
  return auth[providerId];
}

export async function setProviderAuth(
  providerId: string,
  credential: ProviderCredential,
): Promise<void> {
  const auth = await readCtxpackAuthFileOnly();
  auth[providerId] = credential;
  await writeCtxpackAuthFileOnly(auth);
  await upsertOpenCodeProviderAuth(providerId, credential);
}

export async function removeProviderAuth(providerId: string): Promise<void> {
  const auth = await readCtxpackAuthFileOnly();
  delete auth[providerId];
  await writeCtxpackAuthFileOnly(auth);
  await removeOpenCodeProviderAuth(providerId);
}

/* ------------------------------------------------------------------ */
/*  Token refresh helper (for CLI use before server start)             */
/* ------------------------------------------------------------------ */

/**
 * Ensures the stored OAuth tokens are fresh. If expired, refreshes them
 * and writes the updated tokens back to auth.json.
 * Returns the (possibly refreshed) credential, or undefined if none stored.
 */
export async function ensureFreshOAuthTokens(
  providerId: string,
): Promise<OAuthCredential | undefined> {
  const cred = await getProviderAuth(providerId);
  if (!cred || cred.type !== "oauth") return undefined;

  // Refresh if expired or expiring within 60 seconds
  if (cred.expiresAt > Date.now() + 60_000) {
    return cred;
  }

  console.log("Refreshing expired OpenAI access token...");
  const tokens = await refreshAccessToken(cred.refreshToken);
  const refreshed: OAuthCredential = {
    type: "oauth",
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    accountId: extractAccountId(tokens) ?? cred.accountId,
    expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
  };
  await setProviderAuth(providerId, refreshed);
  console.log("Access token refreshed successfully.");
  return refreshed;
}

/* ------------------------------------------------------------------ */
/*  OAuth callback HTML                                                */
/* ------------------------------------------------------------------ */

const HTML_SUCCESS = `<!doctype html>
<html>
  <head>
    <title>ctxpack - Authorization Successful</title>
    <style>
      body {
        font-family: system-ui, -apple-system, sans-serif;
        display: flex; justify-content: center; align-items: center;
        height: 100vh; margin: 0;
        background: #131010; color: #f1ecec;
      }
      .container { text-align: center; padding: 2rem; }
      h1 { color: #f1ecec; margin-bottom: 1rem; }
      p { color: #b7b1b1; }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>Authorization Successful</h1>
      <p>You can close this window and return to ctxpack.</p>
    </div>
    <script>setTimeout(() => window.close(), 2000)</script>
  </body>
</html>`;

const HTML_ERROR = (error: string) => `<!doctype html>
<html>
  <head>
    <title>ctxpack - Authorization Failed</title>
    <style>
      body {
        font-family: system-ui, -apple-system, sans-serif;
        display: flex; justify-content: center; align-items: center;
        height: 100vh; margin: 0;
        background: #131010; color: #f1ecec;
      }
      .container { text-align: center; padding: 2rem; }
      h1 { color: #fc533a; margin-bottom: 1rem; }
      p { color: #b7b1b1; }
      .error {
        color: #ff917b; font-family: monospace; margin-top: 1rem;
        padding: 1rem; background: #3c140d; border-radius: 0.5rem;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>Authorization Failed</h1>
      <p>An error occurred during authorization.</p>
      <div class="error">${error}</div>
    </div>
  </body>
</html>`;

/* ------------------------------------------------------------------ */
/*  Browser-based OAuth flow                                           */
/* ------------------------------------------------------------------ */

function buildAuthorizeUrl(
  redirectUri: string,
  pkce: PkceCodes,
  state: string,
): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access",
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "ctxpack",
  });
  return `${ISSUER}/oauth/authorize?${params.toString()}`;
}

async function openBrowser(url: string): Promise<void> {
  if (process.platform === "darwin") {
    const proc = Bun.spawn(["open", url], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await proc.exited;
    return;
  }

  if (process.platform === "win32") {
    const proc = Bun.spawn(["cmd", "/c", "start", "", url], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await proc.exited;
    return;
  }

  const proc = Bun.spawn(["xdg-open", url], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await proc.exited;
}

/**
 * Opens a browser to auth.openai.com, starts a local callback server,
 * and waits for the user to complete authentication.
 * Returns the stored OAuthCredential.
 *
 * IMPORTANT: Bun.serve() must start BEFORE any `await` so the server
 * handle keeps the event-loop alive. Without an active handle, Bun may
 * terminate the process during the first `await` (e.g. generatePKCE).
 */
export async function loginWithBrowser(): Promise<OAuthCredential> {
  let server: ReturnType<typeof Bun.serve> | undefined;
  let pending:
    | {
        state: string;
        resolve: (code: string) => void;
        reject: (error: Error) => void;
      }
    | undefined;

  const redirectUri = `http://localhost:${String(OAUTH_PORT)}/auth/callback`;

  const waitForCallback = (state: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (pending) {
          pending = undefined;
          reject(
            new Error("OAuth timeout - authorization took too long (5 min)."),
          );
        }
      }, OAUTH_TIMEOUT_MS);

      pending = {
        state,
        resolve: (code: string) => {
          clearTimeout(timeout);
          resolve(code);
        },
        reject: (error: Error) => {
          clearTimeout(timeout);
          reject(error);
        },
      };
    });

  const stopServer = () => {
    if (server) {
      server.stop();
      server = undefined;
    }
  };

  try {
    // Start the callback server FIRST (before any `await`) so the
    // event-loop has an active handle and won't exit prematurely.
    server = Bun.serve({
      port: OAUTH_PORT,
      fetch(req) {
        const url = new URL(req.url);

        if (url.pathname !== "/auth/callback") {
          return new Response("Not found", { status: 404 });
        }

        const code = url.searchParams.get("code");
        const callbackState = url.searchParams.get("state");
        const error = url.searchParams.get("error");
        const errorDescription = url.searchParams.get("error_description");

        if (error) {
          const errorMsg = errorDescription ?? error;
          pending?.reject(new Error(errorMsg));
          pending = undefined;
          return new Response(HTML_ERROR(errorMsg), {
            headers: { "Content-Type": "text/html" },
          });
        }

        if (!code) {
          const errorMsg = "Missing authorization code";
          pending?.reject(new Error(errorMsg));
          pending = undefined;
          return new Response(HTML_ERROR(errorMsg), {
            status: 400,
            headers: { "Content-Type": "text/html" },
          });
        }

        if (!pending || callbackState !== pending.state) {
          const errorMsg = "Invalid state - potential CSRF attack";
          pending?.reject(new Error(errorMsg));
          pending = undefined;
          return new Response(HTML_ERROR(errorMsg), {
            status: 400,
            headers: { "Content-Type": "text/html" },
          });
        }

        const current = pending;
        pending = undefined;
        current.resolve(code);

        return new Response(HTML_SUCCESS, {
          headers: { "Content-Type": "text/html" },
        });
      },
    });

    // Generate PKCE + state AFTER the server is running so the
    // event-loop stays alive during the async crypto operations.
    const pkce = await generatePKCE();
    const state = generateState();
    const authUrl = buildAuthorizeUrl(redirectUri, pkce, state);

    console.log(`\nGo to: ${authUrl}\n`);

    try {
      await openBrowser(authUrl);
    } catch {
      // User will need to open manually
    }

    console.log("Waiting for authorization...");

    // Wait for the OAuth callback (resolves with the auth code)
    const code = await waitForCallback(state);

    // Exchange the authorization code for tokens
    const tokens = await exchangeCodeForTokens(code, redirectUri, pkce);
    const accountId = extractAccountId(tokens);

    const credential: OAuthCredential = {
      type: "oauth",
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      accountId,
      expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    };

    await setProviderAuth("openai", credential);
    return credential;
  } finally {
    stopServer();
  }
}

/* ------------------------------------------------------------------ */
/*  Device code (headless) OAuth flow                                  */
/* ------------------------------------------------------------------ */

/**
 * Optional device-code fallback for headless environments.
 * Not exposed in the default connect UX.
 */
export async function loginWithDeviceCode(): Promise<OAuthCredential> {
  const deviceResponse = await fetch(
    `${ISSUER}/api/accounts/deviceauth/usercode`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "ctxpack-cli",
      },
      body: JSON.stringify({ client_id: CLIENT_ID }),
    },
  );

  if (!deviceResponse.ok) {
    throw new Error(
      `Failed to initiate device authorization (${String(deviceResponse.status)})`,
    );
  }

  const deviceData = (await deviceResponse.json()) as {
    device_auth_id: string;
    user_code: string;
    interval: string;
  };
  const pollInterval = Math.max(parseInt(deviceData.interval) || 5, 1) * 1000;

  console.log(`\nNavigate to: ${ISSUER}/codex/device`);
  console.log(`Enter code:  ${deviceData.user_code}\n`);
  console.log("Waiting for authorization...");

  // Poll until authorized or timeout
  const deadline = Date.now() + OAUTH_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await Bun.sleep(pollInterval + DEVICE_CODE_POLL_SAFETY_MS);

    const response = await fetch(`${ISSUER}/api/accounts/deviceauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "ctxpack-cli",
      },
      body: JSON.stringify({
        device_auth_id: deviceData.device_auth_id,
        user_code: deviceData.user_code,
      }),
    });

    if (response.ok) {
      const data = (await response.json()) as {
        authorization_code: string;
        code_verifier: string;
      };

      // Exchange the code for tokens
      const tokenResponse = await fetch(`${ISSUER}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: data.authorization_code,
          redirect_uri: `${ISSUER}/deviceauth/callback`,
          client_id: CLIENT_ID,
          code_verifier: data.code_verifier,
        }).toString(),
      });

      if (!tokenResponse.ok) {
        throw new Error(
          `Token exchange failed (${String(tokenResponse.status)})`,
        );
      }

      const tokens = (await tokenResponse.json()) as TokenResponse;
      const accountId = extractAccountId(tokens);

      const credential: OAuthCredential = {
        type: "oauth",
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        accountId,
        expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      };

      await setProviderAuth("openai", credential);
      return credential;
    }

    // 403/404 = still pending, anything else is an error
    if (response.status !== 403 && response.status !== 404) {
      throw new Error(
        `Device authorization failed (${String(response.status)})`,
      );
    }
  }

  throw new Error("Device authorization timeout - took too long (5 min).");
}
