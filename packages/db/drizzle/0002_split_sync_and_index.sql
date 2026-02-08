ALTER TABLE "resources" ADD COLUMN IF NOT EXISTS "content_status" text DEFAULT 'missing';
--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN IF NOT EXISTS "vector_status" text DEFAULT 'missing';
--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN IF NOT EXISTS "content_error" text;
--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN IF NOT EXISTS "vector_error" text;
--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN IF NOT EXISTS "last_synced_at" timestamp;
--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN IF NOT EXISTS "last_indexed_at" timestamp;
--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN IF NOT EXISTS "last_local_commit" text;
--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN IF NOT EXISTS "last_remote_commit" text;
--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN IF NOT EXISTS "update_available" boolean DEFAULT false;
--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN IF NOT EXISTS "last_update_check_at" timestamp;
--> statement-breakpoint
ALTER TABLE "index_jobs" ADD COLUMN IF NOT EXISTS "job_type" text DEFAULT 'index';
--> statement-breakpoint
UPDATE "resources"
SET
  "content_status" = CASE
    WHEN "type" = 'local' THEN 'ready'
    WHEN "status" IN ('ready', 'indexing') THEN 'ready'
    WHEN "status" = 'failed' THEN 'failed'
    ELSE 'missing'
  END,
  "vector_status" = CASE
    WHEN "status" = 'ready' THEN 'ready'
    WHEN "status" = 'indexing' THEN 'indexing'
    WHEN "status" = 'failed' THEN 'failed'
    ELSE 'missing'
  END,
  "update_available" = COALESCE("update_available", false)
WHERE "content_status" IS NULL OR "vector_status" IS NULL;
--> statement-breakpoint
UPDATE "index_jobs" SET "job_type" = 'index' WHERE "job_type" IS NULL;
