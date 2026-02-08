import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { users } from "./auth";

export const resources = pgTable(
  "resources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),

    name: text("name").notNull(),
    type: text("type", { enum: ["git", "local"] }).notNull(),
    url: text("url"),
    path: text("path"),
    branch: text("branch").default("main"),
    commit: text("commit"),
    searchPaths: text("search_paths").array(),
    notes: text("notes"),
    status: text("status", {
      enum: ["pending", "indexing", "ready", "failed"],
    }).default("pending"),
    contentStatus: text("content_status", {
      enum: ["missing", "syncing", "ready", "failed"],
    }).default("missing"),
    vectorStatus: text("vector_status", {
      enum: ["missing", "indexing", "ready", "failed"],
    }).default("missing"),
    contentError: text("content_error"),
    vectorError: text("vector_error"),

    chunkCount: integer("chunk_count").default(0),
    lastSyncedAt: timestamp("last_synced_at"),
    lastIndexedAt: timestamp("last_indexed_at"),
    lastLocalCommit: text("last_local_commit"),
    lastRemoteCommit: text("last_remote_commit"),
    updateAvailable: boolean("update_available").default(false),
    lastUpdateCheckAt: timestamp("last_update_check_at"),

    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("resources_user_id_idx").on(t.userId),
    uniqueIndex("resources_user_name_idx").on(t.userId, t.name),
  ],
);
