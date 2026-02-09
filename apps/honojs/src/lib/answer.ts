import { streamText } from "ai";

import type { ModelConfig, ProviderKeys } from "../context";
import type { SearchResult } from "./search";
import { getChatModel, getChatModelInfo } from "./models";
import { hybridSearch } from "./search";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type AnswerInput = {
  userId: string | null;
  query: string;
  resourceIds?: string[];
  mode?: "hybrid" | "text" | "vector";
  alpha?: number;
  topK?: number;
  providerKeys?: ProviderKeys;
  modelConfig?: ModelConfig;
};

export type AnswerResult = {
  answer: string;
  model: string;
  sources: SearchResult[];
};

/* ------------------------------------------------------------------ */
/*  System prompt                                                      */
/* ------------------------------------------------------------------ */

const ANSWER_SYSTEM_PROMPT = `You are a code search assistant. Answer the user's question based ONLY on the provided code context. Be precise, cite file paths, and include relevant code snippets. If the context doesn't contain enough information, say so.`;

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function buildContextBlock(results: SearchResult[]): string {
  return results
    .map(
      (r) =>
        `### ${r.resourceName}:${r.filepath}:${r.lineStart}-${r.lineEnd}\n\`\`\`\n${r.text}\n\`\`\``,
    )
    .join("\n\n");
}

/* ------------------------------------------------------------------ */
/*  Quick answer (non-streaming)                                       */
/* ------------------------------------------------------------------ */

export async function runAnswer(input: AnswerInput): Promise<AnswerResult> {
  const results = await hybridSearch({
    userId: input.userId,
    query: input.query,
    resourceIds: input.resourceIds,
    mode: input.mode ?? "hybrid",
    alpha: input.alpha,
    topK: input.topK ?? 10,
    providerKeys: input.providerKeys,
    modelConfig: input.modelConfig,
  });

  if (results.length === 0) {
    return {
      answer:
        "No relevant code found. Make sure resources are indexed and try a different query.",
      model: `${getChatModelInfo(input.modelConfig, input.providerKeys).provider}/${getChatModelInfo(input.modelConfig, input.providerKeys).model}`,
      sources: [],
    };
  }

  const context = buildContextBlock(results);
  const model = getChatModel(input.modelConfig, input.providerKeys);
  const modelInfo = getChatModelInfo(input.modelConfig, input.providerKeys);

  const stream = streamText({
    model,
    system: ANSWER_SYSTEM_PROMPT,
    prompt: `## Retrieved Context\n\n${context}\n\n## Question\n\n${input.query}`,
  });
  let text = "";

  for await (const part of stream.fullStream) {
    if (part.type === "text-delta") {
      text += part.text;
    }
  }

  return {
    answer: text,
    model: `${modelInfo.provider}/${modelInfo.model}`,
    sources: results,
  };
}

/* ------------------------------------------------------------------ */
/*  Quick answer (streaming)                                           */
/* ------------------------------------------------------------------ */

export async function runAnswerStream(input: AnswerInput) {
  const results = await hybridSearch({
    userId: input.userId,
    query: input.query,
    resourceIds: input.resourceIds,
    mode: input.mode ?? "hybrid",
    alpha: input.alpha,
    topK: input.topK ?? 10,
    providerKeys: input.providerKeys,
    modelConfig: input.modelConfig,
  });

  const modelInfo = getChatModelInfo(input.modelConfig, input.providerKeys);

  if (results.length === 0) {
    return {
      fullStream: null,
      model: `${modelInfo.provider}/${modelInfo.model}`,
      sources: results,
    };
  }

  const context = buildContextBlock(results);
  const model = getChatModel(input.modelConfig, input.providerKeys);

  const result = streamText({
    model,
    system: ANSWER_SYSTEM_PROMPT,
    prompt: `## Retrieved Context\n\n${context}\n\n## Question\n\n${input.query}`,
  });

  return {
    fullStream: result.fullStream,
    model: `${modelInfo.provider}/${modelInfo.model}`,
    sources: results,
  };
}
