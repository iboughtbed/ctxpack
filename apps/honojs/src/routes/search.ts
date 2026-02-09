import { createRoute, OpenAPIHono } from "@hono/zod-openapi";

import { isRemoteExecutionMode } from "@ctxpack/sandbox";

import type { Context } from "../context";
import { runAgentAsk, runAgentAskStream } from "../lib/agent";
import { runAnswer, runAnswerStream } from "../lib/answer";
import { runResearch, runResearchStream } from "../lib/research";
import { createResearchJob, getResearchJob } from "../lib/research-jobs";
import { hybridSearch } from "../lib/search";
import { scheduleGitUpdateChecks } from "../lib/update-checker";
import { AskRequestSchema, AskResponseSchema } from "./schemas/ask";
import { ErrorSchema } from "./schemas/resources";
import { SearchRequestSchema, SearchResponseSchema } from "./schemas/search";

const searchRouter = new OpenAPIHono<Context>();
const isRemoteMode = isRemoteExecutionMode();

/* ------------------------------------------------------------------ */
/*  Shared NDJSON streaming helpers                                     */
/* ------------------------------------------------------------------ */

const HEARTBEAT_INTERVAL_MS = 5_000;

/**
 * Extracts a human-readable error message from stream errors which may be
 * plain strings, Error instances, or structured API error objects.
 */
function toStreamErrorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    // AI SDK / OpenAI-style error objects: { message: "..." }
    if (
      "message" in error &&
      typeof (error as { message?: unknown }).message === "string"
    ) {
      return (error as { message: string }).message;
    }
    // Nested: { error: { message: "..." } }
    if (
      "error" in error &&
      typeof (error as { error?: unknown }).error === "object"
    ) {
      const inner = (error as { error: { message?: unknown } }).error;
      if (inner && "message" in inner && typeof inner.message === "string") {
        return inner.message;
      }
    }
    try {
      return JSON.stringify(error);
    } catch {
      // fall through
    }
  }
  return String(error);
}

const encoder = new TextEncoder();

function emit(
  controller: ReadableStreamDefaultController,
  data: Record<string, unknown>,
) {
  controller.enqueue(encoder.encode(JSON.stringify(data) + "\n"));
}

function ndjsonResponse(readable: ReadableStream): Response {
  return new Response(readable, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache",
    },
  });
}

/**
 * Creates a keepalive timer that sends `{"type":"ping"}` events to prevent
 * idle connection timeouts during long-running agent streams.
 */
function createHeartbeat(controller: ReadableStreamDefaultController) {
  const timer = setInterval(() => {
    try {
      emit(controller, { type: "ping" });
    } catch {
      // Controller may be closed -- ignore
      clearInterval(timer);
    }
  }, HEARTBEAT_INTERVAL_MS);
  return {
    stop() {
      clearInterval(timer);
    },
  };
}

/**
 * Stream an agent's fullStream (with tool-call / tool-result / text-delta
 * events) as NDJSON, with keepalive heartbeats.
 */
function createAgentNdjsonStream(
  fullStream: AsyncIterable<{
    type: string;
    [key: string]: unknown;
  }>,
  model: string,
): ReadableStream {
  return new ReadableStream({
    async start(controller) {
      const heartbeat = createHeartbeat(controller);
      let stepNumber = 0;
      let lastType = "";

      emit(controller, { type: "start", model });

      try {
        for await (const part of fullStream) {
          if (part.type === "text-delta") {
            emit(controller, {
              type: "text-delta",
              textDelta: part.text as string,
            });
            lastType = part.type;
          } else if (part.type === "tool-call") {
            if (lastType !== "tool-call") {
              stepNumber += 1;
            }
            emit(controller, {
              type: "tool-call",
              stepNumber,
              toolName: part.toolName as string,
              input: part.input as Record<string, unknown>,
            });
            lastType = part.type;
          } else if (part.type === "tool-result") {
            emit(controller, {
              type: "tool-result",
              stepNumber,
              toolName: part.toolName as string,
              output: part.output,
            });
            lastType = part.type;
          } else if (part.type === "finish") {
            emit(controller, { type: "done", model });
            lastType = part.type;
          } else if (part.type === "error") {
            emit(controller, {
              type: "error",
              message: toStreamErrorMessage(part.error),
            });
            lastType = part.type;
          } else {
            lastType = part.type;
          }
        }
      } catch (err) {
        emit(controller, {
          type: "error",
          message: toStreamErrorMessage(err),
        });
      }

      heartbeat.stop();
      controller.close();
    },
  });
}

function createCheckedAgentNdjsonStream(
  fullStream: AsyncIterable<{
    type: string;
    [key: string]: unknown;
  }>,
  model: string,
  onDone: () => void,
): ReadableStream {
  const source = createAgentNdjsonStream(fullStream, model);
  return new ReadableStream({
    async start(controller) {
      const reader = source.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          controller.enqueue(value);
        }
      } finally {
        try {
          onDone();
        } catch {
          // Background side-effect failed -- ignore.
        }
        try {
          controller.close();
        } catch {
          // Stream already closed/cancelled.
        }
      }
    },
  });
}

/* ------------------------------------------------------------------ */
/*  POST /api/search  (raw ranked chunks)                              */
/* ------------------------------------------------------------------ */

const rawSearchRoute = createRoute({
  method: "post",
  path: "/api/search",
  tags: ["Search"],
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: SearchRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Search results",
      content: {
        "application/json": {
          schema: SearchResponseSchema,
        },
      },
    },
    401: {
      description: "Unauthorized",
      content: {
        "application/json": {
          schema: ErrorSchema,
        },
      },
    },
  },
});

searchRouter.openapi(rawSearchRoute, async (c) => {
  const user = c.get("user");
  if (isRemoteMode && !user) {
    return c.json({ message: "Unauthorized" }, 401);
  }

  const input = c.req.valid("json");
  const userId = user?.id ?? null;
  const results = await hybridSearch({
    userId,
    query: input.query,
    resourceIds: input.resourceIds,
    mode: input.mode,
    alpha: input.alpha,
    topK: input.topK,
    providerKeys: c.get("providerKeys"),
    modelConfig: c.get("modelConfig"),
  });
  scheduleGitUpdateChecks({ userId, resourceIds: input.resourceIds });

  return c.json(results, 200);
});

/* ------------------------------------------------------------------ */
/*  POST /api/search/answer  (quick answer: search + single LLM)       */
/* ------------------------------------------------------------------ */

const answerRoute = createRoute({
  method: "post",
  path: "/api/search/answer",
  tags: ["Search"],
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: AskRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Quick AI answer with source citations",
      content: {
        "application/json": {
          schema: AskResponseSchema,
        },
      },
    },
    401: {
      description: "Unauthorized",
      content: {
        "application/json": {
          schema: ErrorSchema,
        },
      },
    },
  },
});

searchRouter.openapi(answerRoute, async (c) => {
  const user = c.get("user");
  if (isRemoteMode && !user) {
    return c.json({ message: "Unauthorized" }, 401);
  }

  const input = c.req.valid("json");
  const userId = user?.id ?? null;

  const result = await runAnswer({
    userId,
    query: input.query,
    resourceIds: input.resourceIds,
    mode: input.mode,
    alpha: input.alpha,
    topK: input.topK,
    providerKeys: c.get("providerKeys"),
    modelConfig: c.get("modelConfig"),
  });
  scheduleGitUpdateChecks({ userId, resourceIds: input.resourceIds });

  return c.json({ ...result, steps: [] }, 200);
});

/* ------------------------------------------------------------------ */
/*  POST /api/search/answer/stream  (streaming quick answer, NDJSON)    */
/* ------------------------------------------------------------------ */

searchRouter.post("/api/search/answer/stream", async (c) => {
  const user = c.get("user");
  if (isRemoteMode && !user) {
    return c.json({ message: "Unauthorized" }, 401);
  }

  const body = await c.req.json();
  const parsed = AskRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ message: "Invalid request" }, 400);
  }

  const input = parsed.data;
  const userId = user?.id ?? null;

  const streamResult = await runAnswerStream({
    userId,
    query: input.query,
    resourceIds: input.resourceIds,
    mode: input.mode,
    alpha: input.alpha,
    topK: input.topK,
    providerKeys: c.get("providerKeys"),
    modelConfig: c.get("modelConfig"),
  });

  const { fullStream, model, sources } = streamResult;

  const sourcesPayload = sources.map((s) => ({
    resourceName: s.resourceName,
    filepath: s.filepath,
    lineStart: s.lineStart,
    lineEnd: s.lineEnd,
    matchType: s.matchType,
    score: s.score,
  }));

  if (!fullStream) {
    const readable = new ReadableStream({
      start(controller) {
        emit(controller, { type: "start", model });
        emit(controller, { type: "sources", sources: sourcesPayload });
        emit(controller, {
          type: "text-delta",
          textDelta:
            "No relevant code found. Make sure resources are indexed and try a different query.",
        });
        emit(controller, { type: "done", model });
        scheduleGitUpdateChecks({ userId, resourceIds: input.resourceIds });
        controller.close();
      },
    });
    return ndjsonResponse(readable);
  }

  const readable = new ReadableStream({
    async start(controller) {
      const heartbeat = createHeartbeat(controller);

      emit(controller, { type: "start", model });
      emit(controller, { type: "sources", sources: sourcesPayload });

      try {
        for await (const part of fullStream) {
          if (part.type === "text-delta") {
            emit(controller, {
              type: "text-delta",
              textDelta: part.text,
            });
          } else if (part.type === "finish") {
            emit(controller, { type: "done", model });
          } else if (part.type === "error") {
            emit(controller, {
              type: "error",
              message: toStreamErrorMessage(part.error),
            });
          }
        }
      } catch (err) {
        emit(controller, {
          type: "error",
          message: toStreamErrorMessage(err),
        });
      }

      heartbeat.stop();
      scheduleGitUpdateChecks({ userId, resourceIds: input.resourceIds });
      controller.close();
    },
  });

  return ndjsonResponse(readable);
});

/* ------------------------------------------------------------------ */
/*  POST /api/search/explore  (agent exploration)                       */
/* ------------------------------------------------------------------ */

const exploreRoute = createRoute({
  method: "post",
  path: "/api/search/explore",
  tags: ["Search"],
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: AskRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description:
        "Agent-generated answer with source citations and tool steps",
      content: {
        "application/json": {
          schema: AskResponseSchema,
        },
      },
    },
    401: {
      description: "Unauthorized",
      content: {
        "application/json": {
          schema: ErrorSchema,
        },
      },
    },
  },
});

searchRouter.openapi(exploreRoute, async (c) => {
  const user = c.get("user");
  if (isRemoteMode && !user) {
    return c.json({ message: "Unauthorized" }, 401);
  }

  const input = c.req.valid("json");
  const userId = user?.id ?? null;

  const result = await runAgentAsk({
    userId,
    query: input.query,
    resourceIds: input.resourceIds,
    mode: input.mode,
    alpha: input.alpha,
    topK: input.topK,
    providerKeys: c.get("providerKeys"),
    modelConfig: c.get("modelConfig"),
  });
  scheduleGitUpdateChecks({ userId, resourceIds: input.resourceIds });

  return c.json(result, 200);
});

/* ------------------------------------------------------------------ */
/*  POST /api/search/explore/stream  (streaming agent, NDJSON)          */
/* ------------------------------------------------------------------ */

searchRouter.post("/api/search/explore/stream", async (c) => {
  const user = c.get("user");
  if (isRemoteMode && !user) {
    return c.json({ message: "Unauthorized" }, 401);
  }

  const body = await c.req.json();
  const parsed = AskRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ message: "Invalid request" }, 400);
  }

  const input = parsed.data;
  const userId = user?.id ?? null;

  const streamResult = await runAgentAskStream({
    userId,
    query: input.query,
    resourceIds: input.resourceIds,
    mode: input.mode,
    alpha: input.alpha,
    topK: input.topK,
    providerKeys: c.get("providerKeys"),
    modelConfig: c.get("modelConfig"),
  });

  if (!streamResult) {
    const errorStream = new ReadableStream({
      start(controller) {
        emit(controller, {
          type: "error",
          message: "No indexed resources found. Add and index resources first.",
        });
        controller.close();
      },
    });
    return ndjsonResponse(errorStream);
  }

  return ndjsonResponse(
    createCheckedAgentNdjsonStream(
      streamResult.fullStream,
      streamResult.model,
      () => scheduleGitUpdateChecks({ userId, resourceIds: input.resourceIds }),
    ),
  );
});

/* ------------------------------------------------------------------ */
/*  POST /api/search/research  (sync deep research)                     */
/* ------------------------------------------------------------------ */

const researchRoute = createRoute({
  method: "post",
  path: "/api/search/research",
  tags: ["Search"],
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: AskRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Deep research report with source citations and agent steps",
      content: {
        "application/json": {
          schema: AskResponseSchema,
        },
      },
    },
    401: {
      description: "Unauthorized",
      content: {
        "application/json": {
          schema: ErrorSchema,
        },
      },
    },
  },
});

searchRouter.openapi(researchRoute, async (c) => {
  const user = c.get("user");
  if (isRemoteMode && !user) {
    return c.json({ message: "Unauthorized" }, 401);
  }

  const input = c.req.valid("json");
  const userId = user?.id ?? null;

  const result = await runResearch({
    userId,
    query: input.query,
    resourceIds: input.resourceIds,
    mode: input.mode,
    alpha: input.alpha,
    topK: input.topK,
    providerKeys: c.get("providerKeys"),
    modelConfig: c.get("modelConfig"),
  });
  scheduleGitUpdateChecks({ userId, resourceIds: input.resourceIds });

  return c.json(result, 200);
});

/* ------------------------------------------------------------------ */
/*  POST /api/search/research/stream  (streaming deep research, NDJSON) */
/* ------------------------------------------------------------------ */

searchRouter.post("/api/search/research/stream", async (c) => {
  const user = c.get("user");
  if (isRemoteMode && !user) {
    return c.json({ message: "Unauthorized" }, 401);
  }

  const body = await c.req.json();
  const parsed = AskRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ message: "Invalid request" }, 400);
  }

  const input = parsed.data;
  const userId = user?.id ?? null;

  const streamResult = await runResearchStream({
    userId,
    query: input.query,
    resourceIds: input.resourceIds,
    mode: input.mode,
    alpha: input.alpha,
    topK: input.topK,
    providerKeys: c.get("providerKeys"),
    modelConfig: c.get("modelConfig"),
  });

  if (!streamResult) {
    const errorStream = new ReadableStream({
      start(controller) {
        emit(controller, {
          type: "error",
          message: "No indexed resources found. Add and index resources first.",
        });
        controller.close();
      },
    });
    return ndjsonResponse(errorStream);
  }

  return ndjsonResponse(
    createCheckedAgentNdjsonStream(
      streamResult.fullStream,
      streamResult.model,
      () => scheduleGitUpdateChecks({ userId, resourceIds: input.resourceIds }),
    ),
  );
});

/* ------------------------------------------------------------------ */
/*  POST /api/search/research/jobs  (create async research job)         */
/* ------------------------------------------------------------------ */

searchRouter.post("/api/search/research/jobs", async (c) => {
  const user = c.get("user");
  if (isRemoteMode && !user) {
    return c.json({ message: "Unauthorized" }, 401);
  }

  const body = await c.req.json();
  const parsed = AskRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ message: "Invalid request" }, 400);
  }

  const input = parsed.data;

  const { jobId, status } = await createResearchJob({
    userId: user?.id ?? null,
    query: input.query,
    resourceIds: input.resourceIds,
    mode: input.mode,
    alpha: input.alpha,
    topK: input.topK,
    providerKeys: c.get("providerKeys"),
    modelConfig: c.get("modelConfig"),
  });

  return c.json({ jobId, status }, 200);
});

/* ------------------------------------------------------------------ */
/*  GET /api/search/research/jobs/:id  (poll async research job)        */
/* ------------------------------------------------------------------ */

searchRouter.get("/api/search/research/jobs/:id", async (c) => {
  const user = c.get("user");
  if (isRemoteMode && !user) {
    return c.json({ message: "Unauthorized" }, 401);
  }

  const jobId = c.req.param("id");
  const job = await getResearchJob(jobId);

  if (!job) {
    return c.json({ message: "Research job not found" }, 404);
  }

  return c.json(job, 200);
});

export { searchRouter };
