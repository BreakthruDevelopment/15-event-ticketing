import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Auth tables (shape required by Better Auth with the admin plugin).
// ---------------------------------------------------------------------------

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  role: text("role").notNull().default("user"),
  banned: boolean("banned").default(false),
  banReason: text("ban_reason"),
  banExpires: timestamp("ban_expires", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    impersonatedBy: text("impersonated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("session_user_id_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("account_user_id_idx").on(t.userId)],
);

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Example domain table. Each app replaces this with its own entities, keeping
// the ownerId pattern so per-user access control stays enforceable in SQL.
// ---------------------------------------------------------------------------

export const item = pgTable(
  "item",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    /** Set by clients that retry (see src/lib/client-op.ts); unique per owner, so a replay returns the first row. */
    clientOpId: uuid("client_op_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("item_owner_id_idx").on(t.ownerId), uniqueIndex("item_owner_client_op_uidx").on(t.ownerId, t.clientOpId)],
);

// ---------------------------------------------------------------------------
// Usage limits (src/lib/usage.ts). Each app lists its own kinds here; changing a list
// needs a migration, because the CHECK constraints below are part of the schema.
// ---------------------------------------------------------------------------

/**
 * `upload` is unused by this app but kept: the template's test/usage.integration.test.ts consumes and releases it.
 * `register`, `checkin`, `checkin_miss` and `door_read` are spent by 15.2 and 15.3; they are listed here because the
 * CHECK constraint is part of the schema and only the foundation slice may change it.
 */
export const RATE_KINDS = ["api_write", "ai", "upload", "register", "checkin", "checkin_miss", "door_read"] as const;
export const DAILY_USAGE_KINDS = ["ai", "demo_load"] as const;

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));

/** App-wide daily counters (one row per UTC day and kind) for free-tier caps. */
export const dailyUsage = pgTable(
  "daily_usage",
  {
    day: date("day", { mode: "string" }).notNull(),
    kind: text("kind", { enum: DAILY_USAGE_KINDS }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.day, t.kind] }),
    check("daily_usage_kind_chk", sql`${t.kind} in (${list(DAILY_USAGE_KINDS)})`),
    check("daily_usage_count_chk", sql`${t.count} >= 0`),
  ],
);

/** Per-user rate-limit ledger: one row per attempt, counted over a sliding window. */
export const rateEvent = pgTable(
  "rate_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: RATE_KINDS }).notNull(),
    at: timestamp("at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    index("rate_event_user_kind_at_idx").on(t.userId, t.kind, t.at),
    check("rate_event_kind_chk", sql`${t.kind} in (${list(RATE_KINDS)})`),
  ],
);

export const JOB_STATUSES = ["queued", "running", "done", "failed"] as const;

/**
 * Background job queue (see src/lib/jobs). `key` makes enqueue idempotent: only one queued or running job per
 * (kind, key). `payload` holds ids and small parameters, never personal data or secrets. `last_error` is a short
 * code, never a message.
 */
export const job = pgTable(
  "job",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    key: text("key"),
    ownerId: text("owner_id").references(() => user.id, { onDelete: "cascade" }),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status", { enum: JOB_STATUSES }).notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(4),
    /** Times a handler asked to try again later without using an attempt; capped so a job can't defer forever. */
    deferrals: integer("deferrals").notNull().default(0),
    /** A floor, not a deadline: the job runs at the first claim after this time. */
    runAfter: timestamp("run_after", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    /** While running: the lease. After it passes, any worker may reclaim the job. */
    lockedUntil: timestamp("locked_until", { withTimezone: true, precision: 3 }),
    /** Fencing token of the current claim: a worker whose lease was reclaimed can no longer complete or fail the job. */
    lockToken: uuid("lock_token"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true, precision: 3 }),
  },
  (t) => [
    uniqueIndex("job_active_key_uidx").on(t.kind, t.key).where(sql`${t.status} in ('queued', 'running') and ${t.key} is not null`),
    index("job_due_idx").on(t.runAfter).where(sql`${t.status} = 'queued'`),
    index("job_lease_idx").on(t.lockedUntil).where(sql`${t.status} = 'running'`),
    index("job_kind_key_idx").on(t.kind, t.key, t.createdAt),
    index("job_owner_idx").on(t.ownerId),
    check("job_status_chk", sql`${t.status} in (${list(JOB_STATUSES)})`),
    check("job_attempts_chk", sql`${t.attempts} >= 0 and ${t.maxAttempts} >= 1 and ${t.deferrals} >= 0`),
  ],
);

// ---------------------------------------------------------------------------
// Event ticketing (spec 15, "Data model"). Foundation slice 15.1 owns every table here; later slices never edit this file.
// ---------------------------------------------------------------------------

export const EVENT_STATUSES = ["draft", "published", "cancelled"] as const;
export const REGISTRATION_STATUSES = ["active", "cancelled"] as const;
export const TICKET_SOURCES = ["registration", "guest_list"] as const;
export const TICKET_STATUSES = ["valid", "cancelled"] as const;
export const CHECKIN_METHODS = ["qr", "code", "list", "undo"] as const;
export const CHECKIN_OUTCOMES = ["checked_in", "already", "invalid", "cancelled", "undone"] as const;
export const FAQ_ASK_STATUSES = ["answered", "not_in_faq", "off_topic"] as const;
export const FAQ_ASK_MODES = ["model", "quoted", "lookup", "cached"] as const;

/** Postgres `bytea` as a Node Buffer. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

export const event = pgTable(
  "event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Owner. `restrict`: nothing deletes users (Better Auth's remove-user is disabled), so events never orphan. */
    organizerId: text("organizer_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    slug: text("slug").notNull().unique(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    venueName: text("venue_name").notNull(),
    address: text("address").notNull().default(""),
    /** IANA name, checked against `Intl.supportedValuesOf("timeZone")` in src/lib/event-schema.ts. */
    timeZone: text("time_zone").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    doorsAt: timestamp("doors_at", { withTimezone: true }),
    registrationClosesAt: timestamp("registration_closes_at", { withTimezone: true }).notNull(),
    checkinOpensAt: timestamp("checkin_opens_at", { withTimezone: true }).notNull(),
    maxPerRegistration: integer("max_per_registration").notNull().default(4),
    /** Public. */
    contactEmail: text("contact_email"),
    status: text("status", { enum: EVENT_STATUSES }).notNull().default("draft"),
    hiddenAt: timestamp("hidden_at", { withTimezone: true }),
    hiddenReason: text("hidden_reason"),
    /** Bumped by every FAQ write and every edit to E1-E5 (title, times, venue, address, description, ticket type names, registration close, contact). The FAQ answer cache keys on it. */
    faqVersion: integer("faq_version").notNull().default(1),
    /** Next `faq_entry.ref_no` for this event. Only ever increases, so a deleted entry's `F<n>` is never reused (15.5). */
    faqNextRef: integer("faq_next_ref").notNull().default(1),
    /** One id per user intent (src/lib/client-op.ts); unique per organiser, so a replayed create returns the first event. */
    clientOpId: uuid("client_op_id").notNull(),
    /** Optimistic locking: a PATCH carries the version it loaded; a stale one is a 409. */
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("event_organizer_client_op_uidx").on(t.organizerId, t.clientOpId),
    index("event_status_starts_idx").on(t.status, t.startsAt),
    index("event_organizer_idx").on(t.organizerId, t.createdAt),
    check("event_status_chk", sql`${t.status} in (${list(EVENT_STATUSES)})`),
    check("event_slug_chk", sql`${t.slug} ~ '^[a-z0-9-]{3,60}$'`),
    check("event_lengths_chk", sql`char_length(${t.title}) between 1 and 120 and char_length(${t.description}) <= 1500 and char_length(${t.venueName}) between 1 and 120 and char_length(${t.address}) <= 300 and (${t.contactEmail} is null or char_length(${t.contactEmail}) <= 200)`),
    check("event_times_chk", sql`${t.endsAt} > ${t.startsAt} and ${t.endsAt} <= ${t.startsAt} + interval '7 days'`),
    check("event_max_per_reg_chk", sql`${t.maxPerRegistration} between 1 and 10`),
    check("event_hidden_chk", sql`(${t.hiddenAt} is null) = (${t.hiddenReason} is null) and (${t.hiddenReason} is null or char_length(${t.hiddenReason}) <= 200)`),
    check("event_versions_chk", sql`${t.version} >= 1 and ${t.faqVersion} >= 1 and ${t.faqNextRef} between 1 and 10000`),
  ],
);

export const ticketType = pgTable(
  "ticket_type",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => event.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    capacity: integer("capacity").notNull(),
    /** Seats taken. Changed only by conditional updates inside the registration, cancel and void transactions (15.2). */
    issued: integer("issued").notNull().default(0),
    position: integer("position").notNull().default(0),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("ticket_type_event_name_uidx").on(t.eventId, t.name),
    check("ticket_type_capacity_chk", sql`${t.capacity} between 1 and 5000`),
    check("ticket_type_issued_chk", sql`${t.issued} >= 0 and ${t.issued} <= ${t.capacity}`),
    check("ticket_type_name_chk", sql`char_length(${t.name}) between 1 and 60`),
    check("ticket_type_version_chk", sql`${t.version} >= 1`),
  ],
);

export const registration = pgTable(
  "registration",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => event.id, { onDelete: "cascade" }),
    ticketTypeId: uuid("ticket_type_id")
      .notNull()
      .references(() => ticketType.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    quantity: integer("quantity").notNull(),
    status: text("status", { enum: REGISTRATION_STATUSES }).notNull().default("active"),
    clientOpId: uuid("client_op_id").notNull(),
    /** sha256 of the request payload: the same op id with a different payload is a 409 `op_id_reused` (15.2). */
    payloadHash: text("payload_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("registration_user_client_op_uidx").on(t.userId, t.clientOpId),
    uniqueIndex("registration_event_user_active_uidx").on(t.eventId, t.userId).where(sql`${t.status} = 'active'`),
    index("registration_user_idx").on(t.userId, t.createdAt),
    index("registration_ticket_type_idx").on(t.ticketTypeId),
    check("registration_status_chk", sql`${t.status} in (${list(REGISTRATION_STATUSES)})`),
    check("registration_quantity_chk", sql`${t.quantity} between 1 and 10`),
  ],
);

export const ticket = pgTable(
  "ticket",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => event.id, { onDelete: "cascade" }),
    ticketTypeId: uuid("ticket_type_id")
      .notNull()
      .references(() => ticketType.id, { onDelete: "cascade" }),
    registrationId: uuid("registration_id").references(() => registration.id, { onDelete: "cascade" }),
    /** The attendee who holds it; null for guest-list tickets, which the organiser sees. */
    holderUserId: text("holder_user_id").references(() => user.id, { onDelete: "restrict" }),
    holderName: text("holder_name").notNull(),
    guestLabel: text("guest_label"),
    source: text("source", { enum: TICKET_SOURCES }).notNull(),
    status: text("status", { enum: TICKET_STATUSES }).notNull().default("valid"),
    /** Part of the QR text and the door code; reissue bumps it, so the old QR and code answer `invalid` (15.2). */
    qrEpoch: smallint("qr_epoch").notNull().default(1),
    reissuesToday: smallint("reissues_today").notNull().default(0),
    reissueDay: date("reissue_day", { mode: "string" }),
    /** HMAC-SHA256(kDoorIdx, door code): keyed, so a database dump alone can't be brute-forced (15.2). */
    doorCodeDigest: bytea("door_code_digest").notNull(),
    checkedInAt: timestamp("checked_in_at", { withTimezone: true }),
    checkedInBy: text("checked_in_by").references(() => user.id, { onDelete: "set null" }),
    checkinOpId: uuid("checkin_op_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("ticket_event_door_digest_uidx").on(t.eventId, t.doorCodeDigest),
    index("ticket_event_status_idx").on(t.eventId, t.status),
    index("ticket_event_name_idx").on(t.eventId, sql`lower(${t.holderName}) text_pattern_ops`),
    index("ticket_holder_idx").on(t.holderUserId),
    index("ticket_registration_idx").on(t.registrationId),
    index("ticket_type_idx").on(t.ticketTypeId),
    check("ticket_source_chk", sql`${t.source} in (${list(TICKET_SOURCES)})`),
    check("ticket_status_chk", sql`${t.status} in (${list(TICKET_STATUSES)})`),
    check("ticket_epoch_chk", sql`${t.qrEpoch} between 1 and 20`),
    check("ticket_reissues_chk", sql`${t.reissuesToday} >= 0`),
    check("ticket_names_chk", sql`char_length(${t.holderName}) between 1 and 80 and (${t.guestLabel} is null or char_length(${t.guestLabel}) <= 40)`),
  ],
);

/** Door staff: one row per (event, user), created when the user accepts the organiser's invite and checked on every door request. */
export const eventStaff = pgTable(
  "event_staff",
  {
    eventId: uuid("event_id")
      .notNull()
      .references(() => event.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    invitedBy: text("invited_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.eventId, t.userId] }), index("event_staff_user_idx").on(t.userId)],
);

/** Single-use invite links. Only the sha256 of the random token is stored; the link shows the token once. */
export const staffInvite = pgTable(
  "staff_invite",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => event.id, { onDelete: "cascade" }),
    tokenDigest: bytea("token_digest").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedBy: text("used_by").references(() => user.id, { onDelete: "set null" }),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("staff_invite_digest_uidx").on(t.tokenDigest), index("staff_invite_event_idx").on(t.eventId)],
);

/** The check-in audit log and replay ledger (15.3): unique (actor, op id). */
export const checkinEvent = pgTable(
  "checkin_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => event.id, { onDelete: "cascade" }),
    /** Null for `invalid` outcomes: the scan didn't match a ticket of this event. */
    ticketId: uuid("ticket_id"),
    actorId: text("actor_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    opId: uuid("op_id").notNull(),
    /** sha256 (hex) of the method and the qr / code / ticketId value: the same op id with another payload is a 409 `op_id_reused`. */
    payloadHash: text("payload_hash").notNull(),
    method: text("method", { enum: CHECKIN_METHODS }).notNull(),
    outcome: text("outcome", { enum: CHECKIN_OUTCOMES }).notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("checkin_event_actor_op_uidx").on(t.actorId, t.opId),
    index("checkin_event_event_at_idx").on(t.eventId, t.at),
    index("checkin_event_ticket_idx").on(t.ticketId),
    check("checkin_event_method_chk", sql`${t.method} in (${list(CHECKIN_METHODS)})`),
    check("checkin_event_outcome_chk", sql`${t.outcome} in (${list(CHECKIN_OUTCOMES)})`),
  ],
);

export const faqEntry = pgTable(
  "faq_entry",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => event.id, { onDelete: "cascade" }),
    /** Per event, never reused; cited as `F<ref_no>`. */
    refNo: integer("ref_no").notNull(),
    question: text("question").notNull(),
    answer: text("answer").notNull(),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("faq_entry_event_ref_uidx").on(t.eventId, t.refNo),
    check("faq_entry_ref_chk", sql`${t.refNo} between 1 and 9999`),
    check("faq_entry_lengths_chk", sql`char_length(${t.question}) between 1 and 200 and char_length(${t.answer}) between 1 and 800`),
  ],
);

/** Questions put to the FAQ bot. No user id, by design: anonymous to the organiser; created_at is stored to the hour; pruned at 30 days (15.5). */
export const faqAsk = pgTable(
  "faq_ask",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => event.id, { onDelete: "cascade" }),
    question: text("question").notNull(),
    /** sha256 (hex) of the normalised question. */
    qHash: text("q_hash").notNull(),
    faqVersion: integer("faq_version").notNull(),
    status: text("status", { enum: FAQ_ASK_STATUSES }).notNull(),
    /** The model's text in `model` mode; null in `quoted`, `lookup` and `not_in_faq`, which render from `citations`. */
    answer: text("answer"),
    citations: text("citations").array().notNull().default(sql`'{}'::text[]`),
    mode: text("mode", { enum: FAQ_ASK_MODES }).notNull(),
    flags: text("flags").array().notNull().default(sql`'{}'::text[]`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`date_trunc('hour', now())`),
  },
  (t) => [
    index("faq_ask_event_hash_idx").on(t.eventId, t.qHash, t.faqVersion),
    index("faq_ask_created_idx").on(t.createdAt),
    check("faq_ask_status_chk", sql`${t.status} in (${list(FAQ_ASK_STATUSES)})`),
    check("faq_ask_mode_chk", sql`${t.mode} in (${list(FAQ_ASK_MODES)})`),
    check("faq_ask_lengths_chk", sql`char_length(${t.question}) <= 300 and (${t.answer} is null or char_length(${t.answer}) <= 600)`),
  ],
);

/** Replay ledger for POST /api/admin/roles: a retry with the same `client_op_id` returns the first result and changes nothing. */
export const roleChangeOp = pgTable(
  "role_change_op",
  {
    adminId: text("admin_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    clientOpId: uuid("client_op_id").notNull(),
    /** sha256 (hex) of the request (user, role, from): the same op id with another request is a 409. */
    payloadHash: text("payload_hash").notNull(),
    result: jsonb("result").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.adminId, t.clientOpId] })],
);

export type User = typeof user.$inferSelect;
export type Event = typeof event.$inferSelect;
export type TicketType = typeof ticketType.$inferSelect;
export type Ticket = typeof ticket.$inferSelect;
export type Item = typeof item.$inferSelect;
export type Job = typeof job.$inferSelect;
