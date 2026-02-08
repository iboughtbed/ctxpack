import { sql } from "drizzle-orm";
import {
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export type ResearchJobOptions = {
  mode?: "hybrid" | "text" | "vector";
  alpha?: number;
  topK?: number;
};

export const researchJobs = pgTable("research_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id"),
  query: text("query").notNull(),
  resourceIds: jsonb("resource_ids")
    .$type<string[]>()
    .default(sql`'[]'::jsonb`),
  options: jsonb("options")
    .$type<ResearchJobOptions>()
    .default(sql`'{}'::jsonb`),

  status: text("status", {
    enum: ["queued", "running", "completed", "failed"],
  })
    .default("queued")
    .notNull(),

  // Full result stored as JSON once completed
  result: jsonb("result"),
  error: text("error"),

  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow(),
});
