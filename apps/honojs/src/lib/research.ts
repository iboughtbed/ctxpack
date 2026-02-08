import { generateText, streamText, stepCountIs } from "ai";

import type { ModelConfig, ProviderKeys } from "../context";
import { createAgentTools } from "./agent-tools";
import { getResearchModel, getResearchModelInfo } from "./models";
import {
  loadScopedResources,
  normalizeResourceIds,
  type SearchResource,
} from "./resources";
import type { SearchResult } from "./search";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type ResearchStep = {
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

export type ResearchResult = {
  answer: string;
  model: string;
  sources: SearchResult[];
  steps: ResearchStep[];
};

type ResearchInput = {
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
/*  System prompt                                                      */
/* ------------------------------------------------------------------ */

function buildResearchSystemPrompt(resources: SearchResource[]): string {
  const resourceList = resources
    .map((r) => {
      const meta: string[] = [`id=${r.id}`, `type=${r.type}`];
      if (r.path) meta.push(`path=${r.path}`);
      if (r.url) meta.push(`url=${r.url}`);
      return `- "${r.name}" (${meta.join(", ")})`;
    })
    .join("\n");

  const resourceNames = resources.map((r) => `"${r.name}"`).join(", ");

  return `You are a deep research agent. Your job is to conduct an exhaustive, thorough investigation across indexed codebases and produce a comprehensive, well-structured report. Your output will be consumed by developer agents and humans who need a complete understanding of the topic.

## Indexed Resources

${resourceList}

## Tools

- **search**: Keyword/semantic search across ALL indexed resources. Finds code chunks matching a query. Use short, specific queries (2-4 keywords work best). Avoid long natural-language sentences.
- **grep**: Ripgrep pattern search within a specific resource. Best for finding exact symbols, function names, imports, type definitions, and specific identifiers.
- **read**: Read file contents (with optional line range). Use after finding relevant files via search/grep/list.
- **list**: List files in a resource directory. Use to understand project structure.
- **glob**: Find files matching a glob pattern (e.g. "**/*.ts", "examples/**"). Use to discover relevant files by name or extension.

## Research Strategy

You have a large step budget (50 steps). Use it wisely to be THOROUGH.

1. **Map the landscape**: Start by listing ALL resources and understanding their structure. Use \`list\` and \`glob\` to build a mental map of every resource.
2. **Search broadly, then deeply**: Run multiple \`search\` and \`grep\` queries with different keywords. Don't stop at the first result — explore alternative terms, synonyms, and related concepts.
3. **Cross-reference everything**: If the question involves multiple concepts, explore EACH concept independently across ALL resources (${resourceNames}). Then look for intersections and integration points.
4. **Read extensively**: Read entire files when relevant, not just snippets. Read documentation files, examples, tests, and implementation code.
5. **Verify findings**: When you find something interesting, grep for its usage elsewhere. Follow the dependency chain — who calls this function? Where is this type used?
6. **Look for patterns**: Check for similar patterns across different resources. Find best practices, common idioms, and established conventions.
7. **Check edge cases**: Look for error handling, edge cases, configuration options, and alternative approaches mentioned in the code.

## Output Format

Produce a **structured research report** with clear sections:

- **## Summary**: A brief executive summary of findings (2-3 sentences)
- **## Key Findings**: Numbered list of the most important discoveries
- **## Detailed Analysis**: In-depth analysis organized by topic, with code snippets and file references
- **## Code Examples**: Complete, working code examples where applicable
- **## References**: All file paths and line numbers referenced, formatted as \`resource_name:filepath:startLine-endLine\`

Every code snippet must come from actual tool results. Never fabricate code.

## Critical Rules

- ALWAYS explore ALL available resources. Never answer based on only one resource if others might be relevant.
- Use your full step budget — investigate thoroughly before synthesizing.
- Use SHORT, SPECIFIC search queries — 2-4 keywords. NOT full sentences.
- When a search returns empty, try different keywords or use grep with specific symbols.
- Prefer grep for finding specific identifiers (function names, type names, imports).
- Prefer search for finding conceptual matches (patterns, approaches, related code).
- Read actual files — don't guess or hallucinate code.
- Cross-reference findings across resources to identify patterns and integration points.${
    resources.length === 1
      ? `\n\nSince there is only one resource ("${resources[0]!.name}"), you can omit resourceId in tool calls. Focus on exploring it exhaustively from multiple angles.`
      : ""
  }`;
}

/* ------------------------------------------------------------------ */
/*  Research runner (sync)                                              */
/* ------------------------------------------------------------------ */

const MAX_RESEARCH_STEPS = 50;

export async function runResearch(
  input: ResearchInput,
): Promise<ResearchResult> {
  const resourceIds = normalizeResourceIds(input.resourceIds);
  const scopedResources = await loadScopedResources({
    userId: input.userId,
    resourceIds,
  });

  if (scopedResources.length === 0) {
    return {
      answer:
        "No indexed resources found. Please add and index a resource first using `ctxpack add` and `ctxpack index`.",
      model: `${getResearchModelInfo(input.modelConfig).provider}/${getResearchModelInfo(input.modelConfig).model}`,
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

  const systemPrompt = buildResearchSystemPrompt(scopedResources) + modeNote;
  const researchModel = getResearchModel(input.modelConfig, input.providerKeys);
  const modelInfo = getResearchModelInfo(input.modelConfig);

  const collectedSteps: ResearchStep[] = [];
  const collectedSources: SearchResult[] = [];
  const seenSourceKeys = new Set<string>();

  const result = await generateText({
    model: researchModel,
    system: systemPrompt,
    prompt: input.query,
    tools,
    stopWhen: stepCountIs(MAX_RESEARCH_STEPS),
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

      for (const tr of toolResults) {
        if (tr.toolName === "search" && Array.isArray(tr.output)) {
          for (const item of tr.output) {
            const sr = item as SearchResult;
            const key = sr.chunkId ?? `${sr.resourceId}:${sr.filepath}:${String(sr.lineStart)}`;
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
/*  Research runner (streaming)                                         */
/* ------------------------------------------------------------------ */

export async function runResearchStream(input: ResearchInput) {
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

  const systemPrompt = buildResearchSystemPrompt(scopedResources) + modeNote;
  const researchModel = getResearchModel(input.modelConfig, input.providerKeys);
  const modelInfo = getResearchModelInfo(input.modelConfig);

  const result = streamText({
    model: researchModel,
    system: systemPrompt,
    prompt: input.query,
    tools,
    stopWhen: stepCountIs(MAX_RESEARCH_STEPS),
  });

  return {
    fullStream: result.fullStream,
    model: `${modelInfo.provider}/${modelInfo.model}`,
  };
}
