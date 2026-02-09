type RequestMethod = "GET" | "POST" | "DELETE";

/** Per-request provider API keys / OAuth tokens forwarded to the Hono server. */
export type ProviderKeys = {
  openai?: string;
  anthropic?: string;
  google?: string;
  /** OpenAI OAuth access token (ChatGPT Plus/Pro subscription via Codex). */
  openaiOAuthToken?: string;
  /** OpenAI OAuth account ID (optional, for multi-account setups). */
  openaiOAuthAccountId?: string;
};

/** Per-request model/provider overrides forwarded to Hono via headers. */
export type ModelConfig = {
  embeddingProvider?: string;
  embeddingModel?: string;
  chatProvider?: string;
  chatModel?: string;
  researchProvider?: string;
  researchModel?: string;
};

type ApiClientOptions = {
  endpoint: string;
  apiKey?: string;
  providerKeys?: ProviderKeys;
  modelConfig?: ModelConfig;
};

type SearchMode = "hybrid" | "text" | "vector";
export type ResourceScope = "project" | "global";

export type ApiResource = {
  id: string;
  userId: string | null;
  name: string;
  scope: ResourceScope;
  projectKey: string | null;
  type: "git" | "local";
  url: string | null;
  path: string | null;
  branch: string | null;
  commit: string | null;
  paths: string[] | null;
  notes: string | null;
  status: "pending" | "indexing" | "ready" | "failed";
  contentStatus: "missing" | "syncing" | "ready" | "failed";
  vectorStatus: "missing" | "indexing" | "ready" | "failed";
  contentError: string | null;
  vectorError: string | null;
  chunkCount: number;
  lastSyncedAt: string | null;
  lastIndexedAt: string | null;
  lastLocalCommit: string | null;
  lastRemoteCommit: string | null;
  updateAvailable: boolean;
  lastUpdateCheckAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type ApiIndexJob = {
  id: string;
  resourceId: string;
  jobType: "sync" | "index";
  status: "queued" | "running" | "completed" | "failed";
  progress: number;
  error: string | null;
  warnings: Array<{
    filepath: string;
    stage: "scan" | "read" | "chunk" | "embed" | "sync" | "remote-check";
    message: string;
  }>;
  totalFiles: number | null;
  processedFiles: number;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string | null;
};

export type ApiSearchResult = {
  chunkId: string | null;
  resourceId: string;
  resourceName: string;
  filepath: string;
  lineStart: number;
  lineEnd: number;
  text: string;
  score: number;
  matchType: SearchMode;
  matchSources: Array<"text" | "vector">;
};

type SearchRequest = {
  query: string;
  resourceIds?: string[];
  mode?: SearchMode;
  alpha?: number;
  topK?: number;
};

export type AgentStep = {
  stepNumber: number;
  text: string;
  reasoning: string | null;
  toolCalls: Array<{ toolName: string; input: Record<string, unknown> }>;
  toolResults: Array<{ toolName: string; output: unknown }>;
  finishReason: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
};

export type SearchAnswerResponse = {
  answer: string;
  model: string;
  sources: ApiSearchResult[];
  steps: AgentStep[];
};

export type GrepMatch = {
  filepath: string;
  line: number;
  text: string;
};

export type ToolGrepResponse = {
  matches: GrepMatch[];
};

export type ToolReadResponse = {
  filepath: string;
  content: string;
  totalLines: number;
};

export type ToolListResponse = {
  files: string[];
};

export type ToolGlobResponse = {
  files: string[];
};

/* ------------------------------------------------------------------ */
/*  Stream event types                                                  */
/* ------------------------------------------------------------------ */

/** Events emitted by /api/search/answer/stream */
export type AnswerStreamEvent =
  | { type: "start"; model: string }
  | {
      type: "sources";
      sources: Array<{
        resourceName: string;
        filepath: string;
        lineStart: number;
        lineEnd: number;
        matchType: string;
        score: number;
      }>;
    }
  | { type: "text-delta"; textDelta: string }
  | { type: "done"; model: string }
  | { type: "error"; message: string }
  | { type: "ping" };

/** Events emitted by /api/search/explore/stream and /api/search/research/stream */
export type ExploreStreamEvent =
  | { type: "start"; model: string }
  | { type: "text-delta"; textDelta: string }
  | {
      type: "tool-call";
      stepNumber: number;
      toolName: string;
      input: Record<string, unknown>;
    }
  | {
      type: "tool-result";
      stepNumber: number;
      toolName: string;
      output: unknown;
    }
  | { type: "done"; model: string }
  | { type: "error"; message: string }
  | { type: "ping" };

export type ResearchJob = {
  id: string;
  userId: string | null;
  query: string;
  resourceIds: string[];
  options: { mode?: string; alpha?: number; topK?: number };
  status: "queued" | "running" | "completed" | "failed";
  result: SearchAnswerResponse | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string | null;
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function joinUrl(base: string, path: string): string {
  const normalizedBase = trimTrailingSlash(base);
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
}

async function parseBody(res: Response): Promise<unknown> {
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return res.json();
  }
  return res.text();
}

function toErrorMessage(payload: unknown): string {
  if (typeof payload === "string" && payload.length > 0) {
    return payload;
  }

  if (
    typeof payload === "object" &&
    payload !== null &&
    "message" in payload &&
    typeof payload.message === "string"
  ) {
    return payload.message;
  }

  return "Request failed";
}

async function* streamNdjson<T>(response: Response): AsyncGenerator<T> {
  if (!response.body) {
    throw new Error("No response body for streaming");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        yield JSON.parse(line) as T;
      } catch {
        // Skip malformed lines
      }
    }
  }

  if (buffer.trim()) {
    try {
      yield JSON.parse(buffer) as T;
    } catch {
      // Skip
    }
  }
}

/* ------------------------------------------------------------------ */
/*  API Client                                                         */
/* ------------------------------------------------------------------ */

export class CtxpackApiClient {
  private readonly endpoint: string;

  private readonly apiKey?: string;

  private readonly providerKeys?: ProviderKeys;

  private readonly modelConfig?: ModelConfig;

  constructor(options: ApiClientOptions) {
    this.endpoint = trimTrailingSlash(options.endpoint);
    this.apiKey = options.apiKey;
    this.providerKeys = options.providerKeys;
    this.modelConfig = options.modelConfig;
  }

  private applyProviderHeaders(headers: Headers): void {
    if (!this.providerKeys) return;
    headers.set("x-ctxpack-provider-keys", JSON.stringify(this.providerKeys));
  }

  private applyModelHeaders(headers: Headers): void {
    if (!this.modelConfig) return;
    headers.set("x-ctxpack-model-config", JSON.stringify(this.modelConfig));
  }

  private async request<T>(params: {
    path: string;
    method?: RequestMethod;
    body?: unknown;
  }): Promise<T> {
    const { path, method = "GET", body } = params;
    const headers = new Headers();
    headers.set("Accept", "application/json");
    if (this.apiKey) {
      headers.set("x-api-key", this.apiKey);
    }
    this.applyProviderHeaders(headers);
    this.applyModelHeaders(headers);
    if (body !== undefined) {
      headers.set("Content-Type", "application/json");
    }

    const response = await fetch(joinUrl(this.endpoint, path), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const payload = await parseBody(response);
    if (!response.ok) {
      const message = toErrorMessage(payload);
      throw new Error(`${response.status} ${response.statusText}: ${message}`);
    }

    return payload as T;
  }

  private async fetchStream(path: string, body: unknown): Promise<Response> {
    const headers = new Headers();
    headers.set("Accept", "application/x-ndjson");
    if (this.apiKey) {
      headers.set("x-api-key", this.apiKey);
    }
    this.applyProviderHeaders(headers);
    this.applyModelHeaders(headers);
    headers.set("Content-Type", "application/json");

    const response = await fetch(joinUrl(this.endpoint, path), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const payload = await parseBody(response);
      const message = toErrorMessage(payload);
      throw new Error(`${response.status} ${response.statusText}: ${message}`);
    }

    return response;
  }

  /* ---- Resources ------------------------------------------------- */

  listResources(params?: {
    scope?: ResourceScope | "all";
    projectKey?: string;
  }): Promise<ApiResource[]> {
    const query = new URLSearchParams();
    if (params?.scope) {
      query.set("scope", params.scope);
    }
    if (params?.projectKey) {
      query.set("projectKey", params.projectKey);
    }
    const search = query.toString();
    return this.request<ApiResource[]>({
      path: search.length > 0 ? `/api/resources?${search}` : "/api/resources",
    });
  }

  createResource(payload: {
    name: string;
    scope: ResourceScope;
    projectKey?: string;
    type: "git" | "local";
    url?: string;
    path?: string;
    branch?: string;
    commit?: string;
    paths?: string[];
    notes?: string;
  }): Promise<ApiResource> {
    return this.request<ApiResource>({
      path: "/api/resources",
      method: "POST",
      body: payload,
    });
  }

  deleteResource(resourceId: string): Promise<void> {
    return this.request<void>({
      path: `/api/resources/${resourceId}`,
      method: "DELETE",
    });
  }

  triggerResourceIndex(resourceId: string): Promise<{
    jobId: string;
    resourceId: string;
    status: "queued" | "running" | "completed" | "failed";
    jobType: "sync" | "index";
  }> {
    return this.request({
      path: `/api/resources/${resourceId}/index`,
      method: "POST",
    });
  }

  triggerResourceSync(resourceId: string): Promise<{
    jobId: string;
    resourceId: string;
    status: "queued" | "running" | "completed" | "failed";
    jobType: "sync" | "index";
  }> {
    return this.request({
      path: `/api/resources/${resourceId}/sync`,
      method: "POST",
    });
  }

  getJob(jobId: string): Promise<ApiIndexJob> {
    return this.request<ApiIndexJob>({
      path: `/api/jobs/${jobId}`,
    });
  }

  /* ---- Raw search ------------------------------------------------ */

  search(payload: SearchRequest): Promise<ApiSearchResult[]> {
    return this.request<ApiSearchResult[]>({
      path: "/api/search",
      method: "POST",
      body: payload,
    });
  }

  /* ---- Quick answer (search + single LLM) ------------------------ */

  searchAnswer(payload: SearchRequest): Promise<SearchAnswerResponse> {
    return this.request<SearchAnswerResponse>({
      path: "/api/search/answer",
      method: "POST",
      body: payload,
    });
  }

  async *searchAnswerStream(
    payload: SearchRequest,
  ): AsyncGenerator<AnswerStreamEvent> {
    const response = await this.fetchStream(
      "/api/search/answer/stream",
      payload,
    );
    yield* streamNdjson<AnswerStreamEvent>(response);
  }

  /* ---- Agent exploration ----------------------------------------- */

  searchExplore(payload: SearchRequest): Promise<SearchAnswerResponse> {
    return this.request<SearchAnswerResponse>({
      path: "/api/search/explore",
      method: "POST",
      body: payload,
    });
  }

  async *searchExploreStream(
    payload: SearchRequest,
  ): AsyncGenerator<ExploreStreamEvent> {
    const response = await this.fetchStream(
      "/api/search/explore/stream",
      payload,
    );
    yield* streamNdjson<ExploreStreamEvent>(response);
  }

  /* ---- Deep research --------------------------------------------- */

  searchResearch(payload: SearchRequest): Promise<SearchAnswerResponse> {
    return this.request<SearchAnswerResponse>({
      path: "/api/search/research",
      method: "POST",
      body: payload,
    });
  }

  async *searchResearchStream(
    payload: SearchRequest,
  ): AsyncGenerator<ExploreStreamEvent> {
    const response = await this.fetchStream(
      "/api/search/research/stream",
      payload,
    );
    yield* streamNdjson<ExploreStreamEvent>(response);
  }

  createResearchJob(
    payload: SearchRequest,
  ): Promise<{ jobId: string; status: string }> {
    return this.request<{ jobId: string; status: string }>({
      path: "/api/search/research/jobs",
      method: "POST",
      body: payload,
    });
  }

  getResearchJob(jobId: string): Promise<ResearchJob> {
    return this.request<ResearchJob>({
      path: `/api/search/research/jobs/${jobId}`,
    });
  }

  /* ---- Tools ----------------------------------------------------- */

  toolGrep(payload: {
    resourceId: string;
    pattern: string;
    paths?: string[];
    caseSensitive?: boolean;
    fixedStrings?: boolean;
  }): Promise<ToolGrepResponse> {
    return this.request<ToolGrepResponse>({
      path: "/api/tools/grep",
      method: "POST",
      body: payload,
    });
  }

  toolRead(payload: {
    resourceId: string;
    filepath: string;
    startLine?: number;
    endLine?: number;
  }): Promise<ToolReadResponse> {
    return this.request<ToolReadResponse>({
      path: "/api/tools/read",
      method: "POST",
      body: payload,
    });
  }

  toolList(payload: {
    resourceId: string;
    path?: string;
  }): Promise<ToolListResponse> {
    return this.request<ToolListResponse>({
      path: "/api/tools/list",
      method: "POST",
      body: payload,
    });
  }

  toolGlob(payload: {
    resourceId: string;
    pattern: string;
  }): Promise<ToolGlobResponse> {
    return this.request<ToolGlobResponse>({
      path: "/api/tools/glob",
      method: "POST",
      body: payload,
    });
  }
}
