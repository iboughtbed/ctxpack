import { eq } from "drizzle-orm";

import { db } from "@repo/db";
import { researchJobs } from "@repo/db/schema";

import { runResearch, type ResearchResult } from "./research";
import { scheduleGitUpdateChecks } from "./update-checker";
import type { ModelConfig, ProviderKeys } from "../context";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type ResearchJobRow = {
  id: string;
  userId: string | null;
  query: string;
  resourceIds: string[];
  options: {
    mode?: "hybrid" | "text" | "vector";
    alpha?: number;
    topK?: number;
  };
  status: "queued" | "running" | "completed" | "failed";
  result: ResearchResult | null;
  error: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date | null;
};

/* ------------------------------------------------------------------ */
/*  Create job + run in background                                     */
/* ------------------------------------------------------------------ */

type CreateResearchJobInput = {
  userId: string | null;
  query: string;
  resourceIds?: string[];
  mode?: "hybrid" | "text" | "vector";
  alpha?: number;
  topK?: number;
  providerKeys?: ProviderKeys;
  modelConfig?: ModelConfig;
};

export async function createResearchJob(
  input: CreateResearchJobInput,
): Promise<{ jobId: string; status: string }> {
  const resourceIds = input.resourceIds ?? [];
  const options = {
    ...(input.mode ? { mode: input.mode } : {}),
    ...(input.alpha !== undefined ? { alpha: input.alpha } : {}),
    ...(input.topK !== undefined ? { topK: input.topK } : {}),
  };

  const [row] = await db
    .insert(researchJobs)
    .values({
      userId: input.userId,
      query: input.query,
      resourceIds,
      options,
      status: "queued",
    })
    .returning({ id: researchJobs.id, status: researchJobs.status });

  if (!row) {
    throw new Error("Failed to create research job");
  }

  // Fire and forget -- run in background
  void runResearchJobInBackground(row.id, input);

  return { jobId: row.id, status: row.status! };
}

/* ------------------------------------------------------------------ */
/*  Background runner                                                   */
/* ------------------------------------------------------------------ */

async function runResearchJobInBackground(
  jobId: string,
  input: CreateResearchJobInput,
): Promise<void> {
  try {
    // Mark as running
    await db
      .update(researchJobs)
      .set({ status: "running", startedAt: new Date() })
      .where(eq(researchJobs.id, jobId));

    const result = await runResearch({
      userId: input.userId,
      query: input.query,
      resourceIds: input.resourceIds,
      mode: input.mode,
      alpha: input.alpha,
      topK: input.topK,
      providerKeys: input.providerKeys,
      modelConfig: input.modelConfig,
    });

    // Mark as completed with result
    await db
      .update(researchJobs)
      .set({
        status: "completed",
        result,
        completedAt: new Date(),
      })
      .where(eq(researchJobs.id, jobId));

    scheduleGitUpdateChecks({
      userId: input.userId,
      resourceIds: input.resourceIds,
    });
  } catch (err) {
    // Mark as failed
    await db
      .update(researchJobs)
      .set({
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        completedAt: new Date(),
      })
      .where(eq(researchJobs.id, jobId));
  }
}

/* ------------------------------------------------------------------ */
/*  Get job status                                                      */
/* ------------------------------------------------------------------ */

export async function getResearchJob(
  jobId: string,
): Promise<ResearchJobRow | null> {
  const rows = await db
    .select()
    .from(researchJobs)
    .where(eq(researchJobs.id, jobId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    userId: row.userId,
    query: row.query,
    resourceIds: (row.resourceIds ?? []) as string[],
    options: (row.options ?? {}) as ResearchJobRow["options"],
    status: row.status as ResearchJobRow["status"],
    result: (row.result as ResearchResult) ?? null,
    error: row.error,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
  };
}
