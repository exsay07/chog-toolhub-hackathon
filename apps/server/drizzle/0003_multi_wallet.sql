DROP INDEX "trading_wallets_user_kind_uq";--> statement-breakpoint
ALTER TABLE "trading_wallets" ADD COLUMN "role" text DEFAULT 'primary' NOT NULL;--> statement-breakpoint
ALTER TABLE "trading_wallets" ADD COLUMN "label" text;--> statement-breakpoint
CREATE UNIQUE INDEX "trading_wallets_user_kind_primary_uq" ON "trading_wallets" USING btree ("user_id","kind") WHERE "trading_wallets"."role" = 'primary';--> statement-breakpoint
CREATE UNIQUE INDEX "trading_wallets_user_address_uq" ON "trading_wallets" USING btree ("user_id","kind","address");