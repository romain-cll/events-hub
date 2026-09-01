CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"version" integer NOT NULL,
	"occurred_at" timestamp (3) with time zone NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"properties" jsonb DEFAULT '{}'::jsonb NOT NULL
);
