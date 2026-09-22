CREATE TABLE "stripe_subscription_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscription_id" uuid NOT NULL,
	"stripe_id" text NOT NULL,
	"price_id" text NOT NULL,
	"product_id" text,
	"quantity" integer,
	"unit_amount" integer,
	"currency" text NOT NULL,
	"interval" text,
	"interval_count" integer,
	"current_period_start" timestamp (3) with time zone,
	"current_period_end" timestamp (3) with time zone,
	CONSTRAINT "stripe_subscription_items_subscriptionId_stripeId_unique" UNIQUE("subscription_id","stripe_id")
);
--> statement-breakpoint
CREATE TABLE "stripe_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"stripe_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"status" text NOT NULL,
	"currency" text NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	"start_date" timestamp (3) with time zone NOT NULL,
	"cancel_at" timestamp (3) with time zone,
	"cancel_at_period_end" boolean NOT NULL,
	"canceled_at" timestamp (3) with time zone,
	"ended_at" timestamp (3) with time zone,
	"trial_start" timestamp (3) with time zone,
	"trial_end" timestamp (3) with time zone,
	"collection_method" text NOT NULL,
	"livemode" boolean NOT NULL,
	"observed_at" timestamp (3) with time zone NOT NULL,
	"projected_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stripe_subscriptions_projectId_stripeId_unique" UNIQUE("project_id","stripe_id")
);
--> statement-breakpoint
ALTER TABLE "stripe_subscription_items" ADD CONSTRAINT "stripe_subscription_items_subscription_id_stripe_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."stripe_subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_subscriptions" ADD CONSTRAINT "stripe_subscriptions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stripe_subscriptions_project_customer_idx" ON "stripe_subscriptions" USING btree ("project_id","customer_id");