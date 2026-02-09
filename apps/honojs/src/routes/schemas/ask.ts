import { z } from "@hono/zod-openapi";

import { SearchModeSchema, SearchResultSchema } from "./search";

export const AskRequestSchema = z
  .object({
    query: z.string().min(1).openapi({
      description: "Natural language question about the codebase",
      example: "How does the authentication middleware work?",
    }),
    resourceIds: z
      .array(z.uuid())
      .optional()
      .openapi({
        description: "Optional list of resource IDs to scope search",
        example: ["0f1b5b9f-61e4-4d3a-9a2e-9df4f2b7c1e1"],
      }),
    mode: SearchModeSchema.default("hybrid").optional().openapi({
      description: "Search strategy for retrieving context",
      example: "hybrid",
    }),
    alpha: z.number().min(0).max(1).default(0.5).optional().openapi({
      description: "Hybrid weight (0=text only, 1=vector only)",
      example: 0.5,
    }),
    topK: z.number().int().min(1).max(50).default(10).optional().openapi({
      description: "Maximum number of context chunks to retrieve",
      example: 10,
    }),
  })
  .openapi({
    description: "Ask request payload",
  });

export const AskSourceSchema = SearchResultSchema.openapi({
  description: "Source chunk used to generate the answer",
});

export const AgentToolCallSchema = z
  .object({
    toolName: z.string().openapi({ description: "Name of the tool called" }),
    input: z
      .record(z.string(), z.unknown())
      .openapi({ description: "Tool input arguments" }),
  })
  .openapi({ description: "A single tool call made by the agent" });

export const AgentToolResultSchema = z
  .object({
    toolName: z.string().openapi({ description: "Name of the tool" }),
    output: z.unknown().openapi({ description: "Tool output" }),
  })
  .openapi({ description: "A single tool result returned to the agent" });

export const AgentUsageSchema = z
  .object({
    promptTokens: z
      .number()
      .int()
      .openapi({ description: "Prompt tokens used" }),
    completionTokens: z
      .number()
      .int()
      .openapi({ description: "Completion tokens used" }),
    totalTokens: z.number().int().openapi({ description: "Total tokens used" }),
  })
  .openapi({ description: "Token usage for a step" });

export const AgentStepSchema = z
  .object({
    stepNumber: z
      .number()
      .int()
      .openapi({ description: "1-indexed step number" }),
    text: z.string().openapi({ description: "Text generated in this step" }),
    reasoning: z
      .string()
      .nullable()
      .openapi({ description: "Reasoning text (if model supports it)" }),
    toolCalls: z.array(AgentToolCallSchema).openapi({
      description: "Tool calls made in this step",
    }),
    toolResults: z.array(AgentToolResultSchema).openapi({
      description: "Tool results received in this step",
    }),
    finishReason: z.string().openapi({
      description: "Why this step finished (stop, tool-calls, etc.)",
    }),
    usage: AgentUsageSchema.openapi({
      description: "Token usage for this step",
    }),
  })
  .openapi({ description: "A single agent reasoning/tool-calling step" });

export const AskResponseSchema = z
  .object({
    answer: z.string().openapi({
      description: "LLM-generated answer based on retrieved code context",
      example:
        "The authentication middleware uses better-auth to verify sessions...",
    }),
    model: z.string().openapi({
      description: "Chat model used for generation",
      example: "gpt-5.2-codex",
    }),
    sources: z.array(AskSourceSchema).openapi({
      description: "Code chunks used as context for the answer",
    }),
    steps: z.array(AgentStepSchema).openapi({
      description:
        "Agent reasoning steps with tool calls and results (for verbose/debug output)",
    }),
  })
  .openapi({
    description:
      "Ask response with LLM answer, source citations, and agent steps",
  });
