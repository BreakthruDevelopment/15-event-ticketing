ALTER TABLE "faq_ask" ADD COLUMN "day" date DEFAULT (now() at time zone 'utc')::date NOT NULL;--> statement-breakpoint
CREATE INDEX "faq_ask_event_day_idx" ON "faq_ask" USING btree ("event_id","day");--> statement-breakpoint
CREATE INDEX "op_ledger_kind_created_idx" ON "op_ledger" USING btree ("kind","created_at");--> statement-breakpoint
UPDATE "faq_ask" SET "day" = ("created_at" at time zone 'utc')::date;
