ALTER TABLE "payments" ADD COLUMN "wallet_owner" text;--> statement-breakpoint
CREATE INDEX "payments_wallet_owner_idx" ON "payments" USING btree ("wallet_owner");