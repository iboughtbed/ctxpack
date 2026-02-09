import { z } from "@hono/zod-openapi";

export const SearchModeSchema = z.enum(["hybrid", "text", "vector"]);

export const SearchRequestSchema = z
  .object({
    query: z.string().min(1).openapi({
      description: "Search query text",
      example: "How does auth middleware work?",
    }),
    resourceIds: z
      .array(z.uuid())
      .optional()
      .openapi({
        description: "Optional list of resource IDs to scope search",
        example: ["0f1b5b9f-61e4-4d3a-9a2e-9df4f2b7c1e1"],
      }),
    mode: SearchModeSchema.default("hybrid").optional().openapi({
      description: "Search strategy",
      example: "hybrid",
    }),
    alpha: z.number().min(0).max(1).default(0.5).optional().openapi({
      description: "Hybrid weight (0=text only, 1=vector only)",
      example: 0.5,
    }),
    topK: z.number().int().min(1).max(50).default(10).optional().openapi({
      description: "Maximum number of results",
      example: 10,
    }),
  })
  .openapi({
    description: "Search request payload",
  });

export const SearchResultSchema = z
  .object({
    chunkId: z.uuid().nullable().openapi({
      description: "Matched chunk ID (null for text-only results)",
      example: "5fce8b65-57a6-4ff8-8f89-a9c5c7244a65",
    }),
    resourceId: z.uuid().openapi({
      description: "Owning resource ID",
      example: "0f1b5b9f-61e4-4d3a-9a2e-9df4f2b7c1e1",
    }),
    resourceName: z.string().openapi({
      description: "Owning resource name",
      example: "my-app",
    }),
    filepath: z.string().openapi({
      description: "File path of the matched chunk",
      example: "src/middleware/auth.ts",
    }),
    lineStart: z.number().int().openapi({
      description: "Chunk start line",
      example: 10,
    }),
    lineEnd: z.number().int().openapi({
      description: "Chunk end line",
      example: 42,
    }),
    text: z.string().openapi({
      description: "Chunk content",
      example: "export const withAuth = createMiddleware(...)",
    }),
    score: z.number().openapi({
      description: "Final ranking score",
      example: 0.82,
    }),
    matchType: SearchModeSchema.openapi({
      description: "Dominant match type for this result",
      example: "hybrid",
    }),
    matchSources: z.array(z.enum(["text", "vector"])).openapi({
      description: "Actual retrieval channels that contributed to this result",
      example: ["text", "vector"],
    }),
  })
  .openapi({
    description: "Single search result",
  });

export const SearchResponseSchema = z.array(SearchResultSchema).openapi({
  description: "Search results",
});
