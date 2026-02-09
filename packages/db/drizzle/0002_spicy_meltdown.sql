DROP INDEX IF EXISTS "resources_user_name_idx";--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN IF NOT EXISTS "scope" text DEFAULT 'global' NOT NULL;--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN IF NOT EXISTS "project_key" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN IF NOT EXISTS "content_status" text DEFAULT 'missing';--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN IF NOT EXISTS "vector_status" text DEFAULT 'missing';--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN IF NOT EXISTS "content_error" text;--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN IF NOT EXISTS "vector_error" text;--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN IF NOT EXISTS "last_synced_at" timestamp;--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN IF NOT EXISTS "last_indexed_at" timestamp;--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN IF NOT EXISTS "last_local_commit" text;--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN IF NOT EXISTS "last_remote_commit" text;--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN IF NOT EXISTS "update_available" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN IF NOT EXISTS "last_update_check_at" timestamp;--> statement-breakpoint
ALTER TABLE "index_jobs" ADD COLUMN IF NOT EXISTS "job_type" text DEFAULT 'index';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "resources_user_scope_project_name_idx" ON "resources" USING btree ("user_id","scope","project_key","name");
