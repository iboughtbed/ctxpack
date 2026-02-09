import { and, eq, inArray, isNull } from "drizzle-orm";

import { db } from "@ctxpack/db";
import { resources } from "@ctxpack/db/schema";

import {
  getGitResourcePath,
  pathExists,
  readGitHeadCommit,
  readRemoteBranchHead,
  toErrorMessage,
} from "./git";
import { normalizeResourceIds } from "./resources";

type CheckInput = {
  userId: string | null;
  resourceIds?: string[];
};

export function scheduleGitUpdateChecks(input: CheckInput): void {
  void runGitUpdateChecks(input).catch((error) => {
    console.error("[updates] background check failed:", toErrorMessage(error));
  });
}

async function runGitUpdateChecks(input: CheckInput): Promise<void> {
  const resourceIds = normalizeResourceIds(input.resourceIds);
  const rows = await db
    .select({
      id: resources.id,
      url: resources.url,
      branch: resources.branch,
    })
    .from(resources)
    .where(
      and(
        input.userId
          ? eq(resources.userId, input.userId)
          : isNull(resources.userId),
        eq(resources.type, "git"),
        eq(resources.contentStatus, "ready"),
        resourceIds.length > 0 ? inArray(resources.id, resourceIds) : undefined,
      ),
    );

  await Promise.all(rows.map((row) => checkOneResource(row)));
}

async function checkOneResource(row: {
  id: string;
  url: string | null;
  branch: string | null;
}): Promise<void> {
  if (!row.url) {
    return;
  }

  const repositoryPath = getGitResourcePath(row.id);
  if (!(await pathExists(repositoryPath))) {
    await db
      .update(resources)
      .set({
        lastUpdateCheckAt: new Date(),
      })
      .where(eq(resources.id, row.id));
    return;
  }

  const [localCommit, remoteCommit] = await Promise.all([
    readGitHeadCommit(repositoryPath),
    readRemoteBranchHead({
      url: row.url,
      branch: row.branch ?? "main",
    }),
  ]);

  await db
    .update(resources)
    .set({
      lastLocalCommit: localCommit,
      lastRemoteCommit: remoteCommit,
      updateAvailable:
        Boolean(localCommit) && Boolean(remoteCommit)
          ? localCommit !== remoteCommit
          : false,
      lastUpdateCheckAt: new Date(),
    })
    .where(eq(resources.id, row.id));
}
