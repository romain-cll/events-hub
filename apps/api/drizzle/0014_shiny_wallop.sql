CREATE TABLE "stripe_webhook_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"received_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
