import { generateText, stepCountIs, streamText } from "ai";

import type { ModelConfig, ProviderKeys } from "../context";
import type { SearchResource } from "./resources";
import type { SearchResult } from "./search";
import { createAgentTools } from "./agent-tools";
import { getChatModel, getChatModelInfo } from "./models";
import { loadScopedResources, normalizeResourceIds } from "./resources";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

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

export type AgentAskResult = {
  answer: string;
  model: string;
  sources: SearchResult[];
  steps: AgentStep[];
};

type AgentAskInput = {
  userId: string | null;
  query: string;
  resourceIds?: string[];
  mode?: "hybrid" | "text" | "vector";
  alpha?: number;
  topK?: number;
  providerKeys?: ProviderKeys;
  modelConfig?: ModelConfig;
};

/* ------------------------------------------------------------------ */
/*  System prompt builder                                              */
/* ------------------------------------------------------------------ */

function buildAgentSystemPrompt(resources: SearchResource[]): string {
  const resourceList = resources
    .map((r) => {
      const meta: string[] = [`id=${r.id}`, `type=${r.type}`];
      if (r.path) meta.push(`path=${r.path}`);
      if (r.url) meta.push(`url=${r.url}`);
      return `- "${r.name}" (${meta.join(", ")})`;
    })
    .join("\n");

  const resourceNames = resources.map((r) => `"${r.name}"`).join(", ");

  return `You are a context retrieval agent. Your job is to find and return relevant code, documentation, and examples from indexed codebases to answer the user's question. Your output will be consumed by developer agents (Cursor, Claude Code, Codex) that need precise, actionable context.

## Indexed Resources

${resourceList}

## Tools

- **search**: Keyword/semantic search across ALL indexed resources. Finds code chunks matching a query. Use short, specific queries (2-4 keywords work best). Avoid long natural-language sentences.
- **grep**: Ripgrep pattern search within a specific resource. Best for finding exact symbols, function names, imports, type definitions, and specific identifiers.
- **read**: Read file contents (with optional line range). Use after finding relevant files via search/grep/list.
- **list**: List files in a resource directory. Use to understand project structure.
- **glob**: Find files matching a glob pattern (e.g. "**/*.ts", "examples/**"). Use to discover relevant files by name or extension.

## Strategy

You MUST explore ALL relevant resources (${resourceNames}). Do not fixate on one resource.

1. **Explore structure first**: Use \`list\` on each resource to understand what's available. Look for directories like "examples/", "docs/", "src/", "packages/".
2. **Search broadly**: Run \`search\` with short keyword queries (e.g. "Effect generators", "Hono middleware"). Run \`grep\` for specific symbols, types, and function names.
3. **Read deeply**: Once you find relevant files, use \`read\` to get the full content. Read example files, documentation, and implementation code.
4. **Cross-reference resources**: If the question is about integrating X with Y, explore BOTH the X and Y resources. Find patterns in X, find integration points in Y.
5. **Synthesize**: Combine findings from all resources into a clear, structured answer.

## Output Format

Your answer must be structured and precise:
- Reference actual code with exact file paths and line numbers: \`resource_name:filepath:startLine-endLine\`
- Include relevant code snippets inline (don't just describe them — show them)
- When showing integration patterns, provide complete, working code examples
- If the resources contain examples or documentation, extract and present them directly
- Organize the answer with clear sections (e.g. "## Setup", "## Usage", "## Examples")

## Critical Rules

- ALWAYS explore multiple resources when available. Never answer based on only one resource if others are relevant.
- Use SHORT, SPECIFIC search queries — 2-4 keywords. NOT full sentences.
- When a search returns empty, try different keywords or use grep with specific symbols.
- Prefer grep for finding specific identifiers (function names, type names, imports).
- Prefer search for finding conceptual matches (patterns, approaches, related code).
- Read actual files — don't guess or hallucinate code. Every code snippet must come from a tool result.${
    resources.length === 1
      ? `\n\nSince there is only one resource ("${resources[0]!.name}"), you can omit resourceId in tool calls.`
      : ""
  }`;
}

/* ------------------------------------------------------------------ */
/*  Agent runner                                                       */
/* ------------------------------------------------------------------ */

const MAX_AGENT_STEPS = 20;

export async function runAgentAsk(
  input: AgentAskInput,
): Promise<AgentAskResult> {
  const resourceIds = normalizeResourceIds(input.resourceIds);
  const scopedResources = await loadScopedResources({
    userId: input.userId,
    resourceIds,
  });

  if (scopedResources.length === 0) {
    return {
      answer:
        "No indexed resources found. Please add and index a resource first using `ctxpack add` and `ctxpack index`.",
      model: `${getChatModelInfo(input.modelConfig, input.providerKeys).provider}/${getChatModelInfo(input.modelConfig, input.providerKeys).model}`,
      sources: [],
      steps: [],
    };
  }

  const tools = createAgentTools({
    userId: input.userId,
    resourceIds,
    resources: scopedResources,
    searchDefaults: {
      mode: input.mode,
      alpha: input.alpha,
      topK: input.topK,
    },
    providerKeys: input.providerKeys,
    modelConfig: input.modelConfig,
  });

  let modeNote = "";
  if (input.mode === "text") {
    modeNote =
      "\n\n## Search Mode: TEXT ONLY\nAll search tool calls are locked to text mode (keyword matching via ripgrep). Vector/semantic search is disabled. Rely heavily on grep, list, glob, and read for precise file-level exploration. Use search with short specific keywords.";
  } else if (input.mode === "vector") {
    modeNote =
      "\n\n## Search Mode: VECTOR ONLY\nAll search tool calls are locked to vector mode (embedding similarity). Text search is disabled. Use search for conceptual/semantic queries. Supplement with grep for exact symbol lookups.";
  } else if (input.mode === "hybrid") {
    modeNote =
      "\n\n## Search Mode: HYBRID\nAll search tool calls use hybrid mode (combining text keyword matching + vector similarity). This is the most effective mode for general queries.";
  }
  const systemPrompt = buildAgentSystemPrompt(scopedResources) + modeNote;
  const chatModel = getChatModel(input.modelConfig, input.providerKeys);
  const modelInfo = getChatModelInfo(input.modelConfig, input.providerKeys);

  const collectedSteps: AgentStep[] = [];
  const collectedSources: SearchResult[] = [];
  const seenSourceKeys = new Set<string>();

  const result = await generateText({
    model: chatModel,
    system: systemPrompt,
    prompt: input.query,
    tools,
    stopWhen: stepCountIs(MAX_AGENT_STEPS),
    onStepFinish: (step) => {
      const stepNumber = collectedSteps.length + 1;

      const toolCalls = (step.toolCalls ?? []).map((tc) => ({
        toolName: tc.toolName as string,
        input: (tc.input ?? {}) as Record<string, unknown>,
      }));

      const toolResults = (step.toolResults ?? []).map((tr) => ({
        toolName: tr.toolName as string,
        output: tr.output as unknown,
      }));

      // Collect sources from search tool results
      for (const tr of toolResults) {
        if (tr.toolName === "search" && Array.isArray(tr.output)) {
          for (const item of tr.output) {
            const sr = item as SearchResult;
            const key =
              sr.chunkId ??
              `${sr.resourceId}:${sr.filepath}:${String(sr.lineStart)}`;
            if (!seenSourceKeys.has(key)) {
              seenSourceKeys.add(key);
              collectedSources.push(sr);
            }
          }
        }
      }

      collectedSteps.push({
        stepNumber,
        text: step.text ?? "",
        reasoning:
          typeof step.reasoningText === "string" ? step.reasoningText : null,
        toolCalls,
        toolResults,
        finishReason: step.finishReason ?? "unknown",
        usage: {
          promptTokens: step.usage?.inputTokens ?? 0,
          completionTokens: step.usage?.outputTokens ?? 0,
          totalTokens:
            (step.usage?.inputTokens ?? 0) + (step.usage?.outputTokens ?? 0),
        },
      });
    },
  });

  return {
    answer: result.text,
    model: `${modelInfo.provider}/${modelInfo.model}`,
    sources: collectedSources,
    steps: collectedSteps,
  };
}

/* ------------------------------------------------------------------ */
/*  Streaming agent runner                                             */
/* ------------------------------------------------------------------ */

export async function runAgentAskStream(input: AgentAskInput) {
  const resourceIds = normalizeResourceIds(input.resourceIds);
  const scopedResources = await loadScopedResources({
    userId: input.userId,
    resourceIds,
  });

  if (scopedResources.length === 0) {
    return null;
  }

  const tools = createAgentTools({
    userId: input.userId,
    resourceIds,
    resources: scopedResources,
    searchDefaults: {
      mode: input.mode,
      alpha: input.alpha,
      topK: input.topK,
    },
    providerKeys: input.providerKeys,
    modelConfig: input.modelConfig,
  });

  let modeNote = "";
  if (input.mode === "text") {
    modeNote =
      "\n\n## Search Mode: TEXT ONLY\nAll search tool calls are locked to text mode (keyword matching via ripgrep). Vector/semantic search is disabled. Rely heavily on grep, list, glob, and read for precise file-level exploration. Use search with short specific keywords.";
  } else if (input.mode === "vector") {
    modeNote =
      "\n\n## Search Mode: VECTOR ONLY\nAll search tool calls are locked to vector mode (embedding similarity). Text search is disabled. Use search for conceptual/semantic queries. Supplement with grep for exact symbol lookups.";
  } else if (input.mode === "hybrid") {
    modeNote =
      "\n\n## Search Mode: HYBRID\nAll search tool calls use hybrid mode (combining text keyword matching + vector similarity). This is the most effective mode for general queries.";
  }

  const systemPrompt = buildAgentSystemPrompt(scopedResources) + modeNote;
  const chatModel = getChatModel(input.modelConfig, input.providerKeys);
  const modelInfo = getChatModelInfo(input.modelConfig, input.providerKeys);

  const result = streamText({
    model: chatModel,
    system: systemPrompt,
    prompt: input.query,
    tools,
    stopWhen: stepCountIs(MAX_AGENT_STEPS),
  });

  return {
    fullStream: result.fullStream,
    model: `${modelInfo.provider}/${modelInfo.model}`,
  };
}
