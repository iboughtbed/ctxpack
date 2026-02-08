CREATE TABLE IF NOT EXISTS "research_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text,
	"query" text NOT NULL,
	"resource_ids" jsonb DEFAULT '[]'::jsonb,
	"options" jsonb DEFAULT '{}'::jsonb,
	"status" text DEFAULT 'queued' NOT NULL,
	"result" jsonb,
	"error" text,
	"started_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now()
);
