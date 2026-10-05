CREATE TABLE "audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"deal_id" text NOT NULL,
	"seq" integer NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"actor" text NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"detail" text,
	"data" jsonb,
	"prev_hash" text NOT NULL,
	"hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contracts" (
	"id" text PRIMARY KEY NOT NULL,
	"deal_id" text NOT NULL,
	"terms_hash" text NOT NULL,
	"document" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deals" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"owner" text NOT NULL,
	"scenario_id" text,
	"status" text NOT NULL,
	"intent" text NOT NULL,
	"mandate" jsonb,
	"category" text,
	"seller_id" text,
	"negotiation_status" text DEFAULT 'open' NOT NULL,
	"agreed_terms" jsonb,
	"negotiation_failure" text,
	"policy_evaluation" jsonb,
	"human_decision" jsonb,
	"price_minor" integer,
	"deadline" timestamp with time zone,
	"revision_limit" integer,
	"revisions_used" integer DEFAULT 0 NOT NULL,
	"ai_degraded" boolean DEFAULT false NOT NULL,
	"last_error" text,
	"version" integer DEFAULT 0 NOT NULL,
	"lock_id" text,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "negotiation_moves" (
	"deal_id" text NOT NULL,
	"seq" integer NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"terms" jsonb,
	"message" text NOT NULL,
	"guardrails" jsonb NOT NULL,
	"source" text NOT NULL,
	"model" text,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "negotiation_moves_deal_id_seq_pk" PRIMARY KEY("deal_id","seq")
);
--> statement-breakpoint
CREATE TABLE "payment_operations" (
	"key" text PRIMARY KEY NOT NULL,
	"deal_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"request" jsonb,
	"response" jsonb,
	"error" jsonb,
	"attempts" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"deal_id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"mode" text NOT NULL,
	"status" text NOT NULL,
	"order_id" text,
	"authorization_id" text,
	"capture_id" text,
	"amount_minor" integer NOT NULL,
	"authorized_minor" integer DEFAULT 0 NOT NULL,
	"captured_minor" integer DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"approve_url" text,
	"authorization_expires_at" timestamp with time zone,
	"payer_email_masked" text,
	"last_error" jsonb,
	"webhook_confirmed" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policies" (
	"owner" text PRIMARY KEY NOT NULL,
	"document" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "simulated_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"document" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "submissions" (
	"id" text PRIMARY KEY NOT NULL,
	"deal_id" text NOT NULL,
	"round" integer NOT NULL,
	"artifacts" jsonb NOT NULL,
	"note" text NOT NULL,
	"source" text NOT NULL,
	"model" text,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"deal_id" text NOT NULL,
	"submission_id" text NOT NULL,
	"round" integer NOT NULL,
	"contract_hash" text NOT NULL,
	"checks" jsonb NOT NULL,
	"decision" text NOT NULL,
	"confidence" real NOT NULL,
	"summary" text NOT NULL,
	"failed_rule_ids" jsonb NOT NULL,
	"degraded" boolean DEFAULT false NOT NULL,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"owner" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"status" text NOT NULL,
	"setup_token_id" text,
	"vault_id" text,
	"payer_email_masked" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"resource_id" text,
	"deal_id" text,
	"verified" boolean NOT NULL,
	"verification_method" text NOT NULL,
	"processed" boolean DEFAULT false NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "negotiation_moves" ADD CONSTRAINT "negotiation_moves_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_operations" ADD CONSTRAINT "payment_operations_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_reports" ADD CONSTRAINT "verification_reports_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "audit_deal_seq_idx" ON "audit_events" USING btree ("deal_id","seq");--> statement-breakpoint
CREATE INDEX "audit_at_idx" ON "audit_events" USING btree ("at");--> statement-breakpoint
CREATE UNIQUE INDEX "contracts_deal_idx" ON "contracts" USING btree ("deal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deals_code_idx" ON "deals" USING btree ("code");--> statement-breakpoint
CREATE INDEX "deals_owner_idx" ON "deals" USING btree ("owner","created_at");--> statement-breakpoint
CREATE INDEX "deals_status_idx" ON "deals" USING btree ("status");--> statement-breakpoint
CREATE INDEX "payment_ops_deal_idx" ON "payment_operations" USING btree ("deal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_order_idx" ON "payments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "payments_auth_idx" ON "payments" USING btree ("authorization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "submissions_deal_round_idx" ON "submissions" USING btree ("deal_id","round");--> statement-breakpoint
CREATE UNIQUE INDEX "verification_deal_round_idx" ON "verification_reports" USING btree ("deal_id","round");--> statement-breakpoint
CREATE INDEX "webhook_deal_idx" ON "webhook_events" USING btree ("deal_id");