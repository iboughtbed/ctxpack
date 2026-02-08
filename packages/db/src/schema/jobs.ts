import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { resources } from "./resources";

export type IndexJobWarning = {
  filepath: string;
  stage: "scan" | "read" | "chunk" | "embed" | "sync" | "remote-check";
  message: string;
};

export const indexJobs = pgTable(
  "index_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    resourceId: uuid("resource_id").references(() => resources.id, {
      onDelete: "cascade",
    }),

    progress: integer("progress").default(0),
    error: text("error"),
    status: text("status", {
      enum: ["queued", "running", "completed", "failed"],
    }).default("queued"),
    jobType: text("job_type", {
      enum: ["sync", "index"],
    }).default("index"),

    totalFiles: integer("total_files"),
    processedFiles: integer("processed_files").default(0),
    warnings: jsonb("warnings")
      .$type<IndexJobWarning[]>()
      .default(sql`'[]'::jsonb`),

    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (t) => [
    index("index_jobs_resource_status_created_at_idx").on(
      t.resourceId,
      t.status,
      t.createdAt,
    ),
  ],
);
