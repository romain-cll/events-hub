ALTER TABLE "sessions" ADD COLUMN "country_code" char(2);--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "region" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "city" text;