CREATE TABLE "checkin_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"ticket_id" uuid,
	"actor_id" text NOT NULL,
	"op_id" uuid NOT NULL,
	"payload_hash" text NOT NULL,
	"method" text NOT NULL,
	"outcome" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "checkin_event_method_chk" CHECK ("checkin_event"."method" in ('qr', 'code', 'list', 'undo')),
	CONSTRAINT "checkin_event_outcome_chk" CHECK ("checkin_event"."outcome" in ('checked_in', 'already', 'invalid', 'cancelled', 'undone'))
);
--> statement-breakpoint
CREATE TABLE "event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organizer_id" text NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"venue_name" text NOT NULL,
	"address" text DEFAULT '' NOT NULL,
	"time_zone" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"doors_at" timestamp with time zone,
	"registration_closes_at" timestamp with time zone NOT NULL,
	"checkin_opens_at" timestamp with time zone NOT NULL,
	"max_per_registration" integer DEFAULT 4 NOT NULL,
	"contact_email" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"hidden_at" timestamp with time zone,
	"hidden_reason" text,
	"faq_version" integer DEFAULT 1 NOT NULL,
	"faq_next_ref" integer DEFAULT 1 NOT NULL,
	"client_op_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_slug_unique" UNIQUE("slug"),
	CONSTRAINT "event_status_chk" CHECK ("event"."status" in ('draft', 'published', 'cancelled')),
	CONSTRAINT "event_slug_chk" CHECK ("event"."slug" ~ '^[a-z0-9-]{3,60}$'),
	CONSTRAINT "event_lengths_chk" CHECK (char_length("event"."title") between 1 and 120 and char_length("event"."description") <= 1500 and char_length("event"."venue_name") between 1 and 120 and char_length("event"."address") <= 300 and ("event"."contact_email" is null or char_length("event"."contact_email") <= 200)),
	CONSTRAINT "event_times_chk" CHECK ("event"."ends_at" > "event"."starts_at" and "event"."ends_at" <= "event"."starts_at" + interval '7 days'),
	CONSTRAINT "event_max_per_reg_chk" CHECK ("event"."max_per_registration" between 1 and 10),
	CONSTRAINT "event_hidden_chk" CHECK (("event"."hidden_at" is null) = ("event"."hidden_reason" is null) and ("event"."hidden_reason" is null or char_length("event"."hidden_reason") <= 200)),
	CONSTRAINT "event_versions_chk" CHECK ("event"."version" >= 1 and "event"."faq_version" >= 1 and "event"."faq_next_ref" between 1 and 10000)
);
--> statement-breakpoint
CREATE TABLE "event_staff" (
	"event_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"invited_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_staff_event_id_user_id_pk" PRIMARY KEY("event_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "faq_ask" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"question" text NOT NULL,
	"q_hash" text NOT NULL,
	"faq_version" integer NOT NULL,
	"status" text NOT NULL,
	"answer" text,
	"citations" text[] DEFAULT '{}'::text[] NOT NULL,
	"mode" text NOT NULL,
	"flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('hour', now()) NOT NULL,
	CONSTRAINT "faq_ask_status_chk" CHECK ("faq_ask"."status" in ('answered', 'not_in_faq', 'off_topic')),
	CONSTRAINT "faq_ask_mode_chk" CHECK ("faq_ask"."mode" in ('model', 'quoted', 'lookup', 'cached')),
	CONSTRAINT "faq_ask_lengths_chk" CHECK (char_length("faq_ask"."question") <= 300 and ("faq_ask"."answer" is null or char_length("faq_ask"."answer") <= 600))
);
--> statement-breakpoint
CREATE TABLE "faq_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"ref_no" integer NOT NULL,
	"question" text NOT NULL,
	"answer" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "faq_entry_ref_chk" CHECK ("faq_entry"."ref_no" between 1 and 9999),
	CONSTRAINT "faq_entry_lengths_chk" CHECK (char_length("faq_entry"."question") between 1 and 200 and char_length("faq_entry"."answer") between 1 and 800)
);
--> statement-breakpoint
CREATE TABLE "op_ledger" (
	"actor_id" text NOT NULL,
	"client_op_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"payload_hash" text NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "op_ledger_actor_id_client_op_id_pk" PRIMARY KEY("actor_id","client_op_id")
);
--> statement-breakpoint
CREATE TABLE "registration" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"ticket_type_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"quantity" integer NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"client_op_id" uuid NOT NULL,
	"payload_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "registration_status_chk" CHECK ("registration"."status" in ('active', 'cancelled')),
	CONSTRAINT "registration_quantity_chk" CHECK ("registration"."quantity" between 1 and 10)
);
--> statement-breakpoint
CREATE TABLE "staff_invite" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"token_digest" "bytea" NOT NULL,
	"client_op_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"used_by" text,
	"used_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"ticket_type_id" uuid NOT NULL,
	"registration_id" uuid,
	"holder_user_id" text,
	"holder_name" text NOT NULL,
	"guest_label" text,
	"source" text NOT NULL,
	"status" text DEFAULT 'valid' NOT NULL,
	"qr_epoch" smallint DEFAULT 1 NOT NULL,
	"reissues_today" smallint DEFAULT 0 NOT NULL,
	"reissue_day" date,
	"door_code_digest" "bytea" NOT NULL,
	"checked_in_at" timestamp with time zone,
	"checked_in_by" text,
	"checkin_op_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_source_chk" CHECK ("ticket"."source" in ('registration', 'guest_list')),
	CONSTRAINT "ticket_status_chk" CHECK ("ticket"."status" in ('valid', 'cancelled')),
	CONSTRAINT "ticket_epoch_chk" CHECK ("ticket"."qr_epoch" between 1 and 20),
	CONSTRAINT "ticket_reissues_chk" CHECK ("ticket"."reissues_today" >= 0),
	CONSTRAINT "ticket_names_chk" CHECK (char_length("ticket"."holder_name") between 1 and 80 and ("ticket"."guest_label" is null or char_length("ticket"."guest_label") <= 40))
);
--> statement-breakpoint
CREATE TABLE "ticket_type" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"name" text NOT NULL,
	"capacity" integer NOT NULL,
	"issued" integer DEFAULT 0 NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_type_capacity_chk" CHECK ("ticket_type"."capacity" between 1 and 5000),
	CONSTRAINT "ticket_type_issued_chk" CHECK ("ticket_type"."issued" >= 0 and "ticket_type"."issued" <= "ticket_type"."capacity"),
	CONSTRAINT "ticket_type_name_chk" CHECK (char_length("ticket_type"."name") between 1 and 60),
	CONSTRAINT "ticket_type_version_chk" CHECK ("ticket_type"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "rate_event" DROP CONSTRAINT "rate_event_kind_chk";--> statement-breakpoint
ALTER TABLE "checkin_event" ADD CONSTRAINT "checkin_event_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkin_event" ADD CONSTRAINT "checkin_event_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_organizer_id_user_id_fk" FOREIGN KEY ("organizer_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_staff" ADD CONSTRAINT "event_staff_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_staff" ADD CONSTRAINT "event_staff_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_staff" ADD CONSTRAINT "event_staff_invited_by_user_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "faq_ask" ADD CONSTRAINT "faq_ask_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "faq_entry" ADD CONSTRAINT "faq_entry_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "op_ledger" ADD CONSTRAINT "op_ledger_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registration" ADD CONSTRAINT "registration_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registration" ADD CONSTRAINT "registration_ticket_type_id_ticket_type_id_fk" FOREIGN KEY ("ticket_type_id") REFERENCES "public"."ticket_type"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registration" ADD CONSTRAINT "registration_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_invite" ADD CONSTRAINT "staff_invite_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_invite" ADD CONSTRAINT "staff_invite_used_by_user_id_fk" FOREIGN KEY ("used_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_invite" ADD CONSTRAINT "staff_invite_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket" ADD CONSTRAINT "ticket_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket" ADD CONSTRAINT "ticket_ticket_type_id_ticket_type_id_fk" FOREIGN KEY ("ticket_type_id") REFERENCES "public"."ticket_type"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket" ADD CONSTRAINT "ticket_registration_id_registration_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."registration"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket" ADD CONSTRAINT "ticket_holder_user_id_user_id_fk" FOREIGN KEY ("holder_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket" ADD CONSTRAINT "ticket_checked_in_by_user_id_fk" FOREIGN KEY ("checked_in_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_type" ADD CONSTRAINT "ticket_type_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "checkin_event_actor_op_uidx" ON "checkin_event" USING btree ("actor_id","op_id");--> statement-breakpoint
CREATE INDEX "checkin_event_event_at_idx" ON "checkin_event" USING btree ("event_id","at");--> statement-breakpoint
CREATE INDEX "checkin_event_ticket_idx" ON "checkin_event" USING btree ("ticket_id");--> statement-breakpoint
CREATE UNIQUE INDEX "event_organizer_client_op_uidx" ON "event" USING btree ("organizer_id","client_op_id");--> statement-breakpoint
CREATE INDEX "event_status_starts_idx" ON "event" USING btree ("status","starts_at");--> statement-breakpoint
CREATE INDEX "event_organizer_idx" ON "event" USING btree ("organizer_id","created_at");--> statement-breakpoint
CREATE INDEX "event_staff_user_idx" ON "event_staff" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "faq_ask_event_hash_idx" ON "faq_ask" USING btree ("event_id","q_hash","faq_version");--> statement-breakpoint
CREATE INDEX "faq_ask_created_idx" ON "faq_ask" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "faq_entry_event_ref_uidx" ON "faq_entry" USING btree ("event_id","ref_no");--> statement-breakpoint
CREATE UNIQUE INDEX "registration_user_client_op_uidx" ON "registration" USING btree ("user_id","client_op_id");--> statement-breakpoint
CREATE UNIQUE INDEX "registration_event_user_active_uidx" ON "registration" USING btree ("event_id","user_id") WHERE "registration"."status" = 'active';--> statement-breakpoint
CREATE INDEX "registration_user_idx" ON "registration" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "registration_ticket_type_idx" ON "registration" USING btree ("ticket_type_id");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_invite_digest_uidx" ON "staff_invite" USING btree ("token_digest");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_invite_event_client_op_uidx" ON "staff_invite" USING btree ("event_id","client_op_id");--> statement-breakpoint
CREATE INDEX "staff_invite_event_idx" ON "staff_invite" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_event_door_digest_uidx" ON "ticket" USING btree ("event_id","door_code_digest");--> statement-breakpoint
CREATE INDEX "ticket_event_status_idx" ON "ticket" USING btree ("event_id","status");--> statement-breakpoint
CREATE INDEX "ticket_event_name_idx" ON "ticket" USING btree ("event_id",lower("holder_name") text_pattern_ops);--> statement-breakpoint
CREATE INDEX "ticket_holder_idx" ON "ticket" USING btree ("holder_user_id");--> statement-breakpoint
CREATE INDEX "ticket_registration_idx" ON "ticket" USING btree ("registration_id");--> statement-breakpoint
CREATE INDEX "ticket_type_idx" ON "ticket" USING btree ("ticket_type_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_type_event_name_uidx" ON "ticket_type" USING btree ("event_id","name");--> statement-breakpoint
ALTER TABLE "rate_event" ADD CONSTRAINT "rate_event_kind_chk" CHECK ("rate_event"."kind" in ('api_write', 'ai', 'upload', 'register', 'checkin', 'checkin_miss', 'door_read'));