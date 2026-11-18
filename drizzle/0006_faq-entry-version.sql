ALTER TABLE "faq_entry" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "faq_entry" ADD CONSTRAINT "faq_entry_version_chk" CHECK ("faq_entry"."version" >= 1);