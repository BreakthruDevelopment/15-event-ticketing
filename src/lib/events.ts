import "server-only";
import { randomBytes } from "node:crypto";
import { type SQL, and, asc, count, desc, eq, gte, lt, sql } from "drizzle-orm";
import { assertCan, publicEvent, publicEventPage } from "@/lib/access";
import type { Actor } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import { dbErrorCode } from "@/lib/db-errors";
import { CodedConflictError, NotFoundError, VersionConflictError } from "@/lib/errors";
import {
  LIMITS,
  type UpdateEventInput,
  checkTimes,
  defaultTimes,
  idParam,
  listQuery,
  newEventInput,
  slugParam,
  slugStem,
  updateEventInput,
} from "@/lib/event-schema";
import { log } from "@/lib/log";
import { withOp } from "@/lib/op-ledger";
import { type Tx } from "@/lib/usage";
import { spendRead, writeTx } from "@/lib/write-tx";

/**
 * Event data layer (organiser side and the public reads). Every function takes the acting user (public reads take
 * none) and checks permissions itself. Which columns leave this module is decided here and nowhere else: public
 * shapes leave out `organizer_id`, the hidden fields, `client_op_id`, versions and check-in settings.
 */

const E = schema.event;
const T = schema.ticketType;

/** Columns every viewer may see (a published, not hidden event; a cancelled one's page too). */
const publicColumns = {
  id: E.id,
  slug: E.slug,
  title: E.title,
  description: E.description,
  venueName: E.venueName,
  address: E.address,
  timeZone: E.timeZone,
  startsAt: E.startsAt,
  endsAt: E.endsAt,
  doorsAt: E.doorsAt,
  registrationClosesAt: E.registrationClosesAt,
  maxPerRegistration: E.maxPerRegistration,
  contactEmail: E.contactEmail,
  status: E.status,
};
const PUBLIC_KEYS = Object.keys(publicColumns) as (keyof typeof publicColumns)[];

/** Copy only the public columns, so nothing added to `ownerColumns` later can leak into a public response. */
function toPublic<T_ extends Record<keyof typeof publicColumns, unknown>>(row: T_): Pick<T_, keyof typeof publicColumns> {
  return Object.fromEntries(PUBLIC_KEYS.map((k) => [k, row[k]])) as Pick<T_, keyof typeof publicColumns>;
}

/** What the owning organiser sees on top: check-in settings, hidden state, versions. Never `client_op_id`. */
const ownerColumns = {
  ...publicColumns,
  checkinOpensAt: E.checkinOpensAt,
  hiddenAt: E.hiddenAt,
  hiddenReason: E.hiddenReason,
  faqVersion: E.faqVersion,
  version: E.version,
  createdAt: E.createdAt,
  updatedAt: E.updatedAt,
};

// Drizzle renders a single-table select's columns unqualified, which inside a subquery would resolve to the subquery's own
// `id`; the event id is therefore written out in full.
const EVENT_ID = sql.raw('"event"."id"');
const seatsLeftSql = sql<number>`coalesce((select sum(t.capacity - t.issued) from ticket_type t where t.event_id = ${EVENT_ID}), 0)::int`;

export type PublicTicketType = { id: string; name: string; seatsLeft: number; soldOut: boolean };
export type OwnerTicketType = { id: string; name: string; capacity: number; issued: number; seatsLeft: number; position: number; version: number };

const ownerType = (r: { id: string; name: string; capacity: number; issued: number; position: number; version: number }): OwnerTicketType => ({
  id: r.id,
  name: r.name,
  capacity: r.capacity,
  issued: r.issued,
  seatsLeft: r.capacity - r.issued,
  position: r.position,
  version: r.version,
});

const registrationOpen = (e: { status: string; registrationClosesAt: Date; endsAt: Date }, now = new Date()) =>
  e.status === "published" && now.getTime() < e.registrationClosesAt.getTime() && now.getTime() < e.endsAt.getTime();

/**
 * GET /api/events: published, not hidden events, upcoming first (`past=1` for past ones, newest first). At most
 * `limit` (1 to 100, default 50). Each card carries the seats left across all ticket types.
 */
export async function listPublicEvents(input: unknown = {}) {
  const { limit, past } = listQuery.parse(input);
  const now = new Date();
  const rows = await db()
    .select({ ...publicColumns, seatsLeft: seatsLeftSql })
    .from(E)
    .where(and(publicEvent(), past ? lt(E.endsAt, now) : gte(E.endsAt, now)))
    .orderBy(past ? desc(E.startsAt) : asc(E.startsAt))
    .limit(limit);
  return { events: rows.map((r) => ({ ...r, registrationOpen: registrationOpen(r, now), soldOut: r.seatsLeft <= 0 })) };
}

/** GET /api/events/by-slug/[slug]: one event with its ticket types and seats left, or 404 (a draft, a hidden event and a missing slug look the same). */
export async function getPublicEventBySlug(rawSlug: string) {
  const slug = slugParam.parse(rawSlug);
  const [row] = await db().select(publicColumns).from(E).where(and(eq(E.slug, slug), publicEventPage()));
  if (!row) throw new NotFoundError();
  const types = await db()
    .select({ id: T.id, name: T.name, capacity: T.capacity, issued: T.issued })
    .from(T)
    .where(eq(T.eventId, row.id))
    .orderBy(asc(T.position), asc(T.name));
  const ticketTypes: PublicTicketType[] = types.map((t) => ({ id: t.id, name: t.name, seatsLeft: t.capacity - t.issued, soldOut: t.capacity <= t.issued }));
  return { event: { ...toPublic(row), registrationOpen: registrationOpen(row) }, ticketTypes };
}

async function ownerTypes(reader: Pick<ReturnType<typeof db>, "select">, eventId: string): Promise<OwnerTicketType[]> {
  const rows = await reader.select().from(T).where(eq(T.eventId, eventId)).orderBy(asc(T.position), asc(T.name));
  return rows.map(ownerType);
}

const selectOwner = (where: SQL | undefined) => db().select(ownerColumns).from(E).where(where);
export type OwnerEvent = Awaited<ReturnType<typeof selectOwner>>[number] & { ticketTypes: OwnerTicketType[] };

/** An event the actor owns, with its ticket types, or 404. Used by every organiser read and write. */
export async function getMyEvent(actor: Actor | null, rawId: string): Promise<OwnerEvent> {
  assertCan(actor, "event:manage");
  await spendRead(actor);
  return loadMyEvent(actor, rawId);
}

/** `getMyEvent` without spending the read allowance: for the read-back after a write, which already spent a write. */
async function loadMyEvent(actor: Actor, rawId: string): Promise<OwnerEvent> {
  const id = idParam.parse(rawId);
  const [row] = await selectOwner(and(eq(E.id, id), eq(E.organizerId, actor.id)));
  if (!row) throw new NotFoundError();
  return { ...row, ticketTypes: await ownerTypes(db(), id) };
}

/** The organiser's own events, newest first, with capacity totals. At most 20 (the per-organiser cap). */
export async function listMyEvents(actor: Actor | null) {
  assertCan(actor, "event:manage");
  await spendRead(actor);
  return db()
    .select({
      ...ownerColumns,
      ticketTypeCount: sql<number>`(select count(*)::int from ticket_type t where t.event_id = ${EVENT_ID})`,
      capacityTotal: sql<number>`coalesce((select sum(t.capacity) from ticket_type t where t.event_id = ${EVENT_ID}), 0)::int`,
      issuedTotal: sql<number>`coalesce((select sum(t.issued) from ticket_type t where t.event_id = ${EVENT_ID}), 0)::int`,
    })
    .from(E)
    .where(eq(E.organizerId, actor.id))
    .orderBy(desc(E.createdAt))
    .limit(LIMITS.eventsPerOrganizer);
}

/**
 * The organiser's event row, locked FOR UPDATE, or 404 (foreign and missing ids look the same). Used by every write
 * on an event or on anything it owns (ticket types, staff, invites), so they all take the event lock after the user
 * and allowance locks (see `lockActor`).
 */
export async function lockOwnEvent(tx: Tx, actor: Actor, rawId: string) {
  const id = idParam.parse(rawId);
  const [row] = await tx
    .select({
      id: E.id,
      slug: E.slug,
      title: E.title,
      description: E.description,
      venueName: E.venueName,
      address: E.address,
      timeZone: E.timeZone,
      startsAt: E.startsAt,
      endsAt: E.endsAt,
      doorsAt: E.doorsAt,
      registrationClosesAt: E.registrationClosesAt,
      checkinOpensAt: E.checkinOpensAt,
      maxPerRegistration: E.maxPerRegistration,
      contactEmail: E.contactEmail,
      status: E.status,
      version: E.version,
      faqVersion: E.faqVersion,
    })
    .from(E)
    .where(and(eq(E.id, id), eq(E.organizerId, actor.id)))
    .for("update");
  if (!row) throw new NotFoundError();
  return row;
}

const randomSuffix = () => {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from(randomBytes(5), (b) => alphabet[b % alphabet.length]).join("");
};

/**
 * Create a draft. Idempotent per (organiser, `clientOpId`): a retry returns the first event with `created: false`,
 * parallel duplicates included (every organiser write takes the organiser's allowance lock, so they run one at a time
 * and the second sees the first). At most 20 events per organiser (cancelled included until deleted), counted under
 * that same lock, so the cap is exact. `slug` is optional: without it one is made from the title plus a random suffix.
 */
export async function createEvent(actor: Actor | null, input: unknown): Promise<{ event: OwnerEvent; created: boolean }> {
  assertCan(actor, "event:manage");
  const data = newEventInput.parse(input);
  const defaults = defaultTimes(data.startsAt);
  const times = {
    startsAt: data.startsAt,
    endsAt: data.endsAt,
    doorsAt: data.doorsAt,
    registrationClosesAt: data.registrationClosesAt ?? defaults.registrationClosesAt,
    checkinOpensAt: data.checkinOpensAt ?? defaults.checkinOpensAt,
  };
  checkTimes(times);
  // The op ledger outlives the event: a late retry of a create whose event was deleted since returns 409 `event_deleted`
  // instead of making a new draft.
  const out = await writeTx(actor, "event:manage", (tx) =>
    withOp(tx, actor.id, { kind: "event-create", clientOpId: data.clientOpId, payload: JSON.stringify(data) }, async () => {
      const [{ mine }] = await tx.select({ mine: count() }).from(E).where(eq(E.organizerId, actor.id));
      if (mine >= LIMITS.eventsPerOrganizer) {
        throw new CodedConflictError("event_limit", `You can have at most ${LIMITS.eventsPerOrganizer} events. Delete a draft or a cancelled event first.`);
      }

      const values = {
        organizerId: actor.id,
        title: data.title,
        description: data.description,
        venueName: data.venueName,
        address: data.address,
        timeZone: data.timeZone,
        ...times,
        maxPerRegistration: data.maxPerRegistration,
        contactEmail: data.contactEmail,
        clientOpId: data.clientOpId,
      };
      // `on conflict (slug) do nothing` keeps the transaction alive on a taken slug, so an auto-generated one can retry.
      const attempts = data.slug ? 1 : 5;
      for (let i = 0; i < attempts; i++) {
        const slug = data.slug ?? `${slugStem(data.title)}-${randomSuffix()}`;
        const [row] = await tx.insert(E).values({ ...values, slug }).onConflictDoNothing({ target: E.slug }).returning({ id: E.id });
        if (row) return { id: row.id };
      }
      throw new CodedConflictError("slug_taken", data.slug ? "That address is taken. Pick another." : "Couldn't make an address for this event. Try again.");
    }),
  );
  const created = !out.replayed;
  const id = out.result.id;
  if (!created) {
    const [still] = await db().select({ id: E.id }).from(E).where(and(eq(E.id, id), eq(E.organizerId, actor.id)));
    if (!still) throw new CodedConflictError("event_deleted", "That event was deleted. Create it again with a new request.");
  }
  return { event: await loadMyEvent(actor, id), created };
}

/** The facts whose change bumps `faq_version` (E1-E5: when, where, about, registration close, contact; ticket type names bump it in ticket-types.ts). */
const FAQ_FACTS = ["title", "description", "venueName", "address", "timeZone", "startsAt", "endsAt", "doorsAt", "registrationClosesAt", "contactEmail"] as const;

const sameValue = (a: unknown, b: unknown) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b);

/**
 * Edit an event and/or move it along: `draft -> published` (needs at least one ticket type) and
 * `published -> cancelled`. Any other status request is a 409, and a cancelled event can't be edited (only deleted).
 * A stale `version` is a 409 with the current row. Editing a published event's title, times, venue, address,
 * description, time zone, registration close or contact bumps `faq_version`, so the FAQ bot never answers a changed
 * time from its cache. The slug can change only while the event is a draft (published links must not break).
 */
export async function updateEvent(actor: Actor | null, rawId: string, input: unknown): Promise<OwnerEvent> {
  assertCan(actor, "event:manage");
  const data = updateEventInput.parse(input);
  await writeTx(actor, "event:manage", async (tx) => {
    const cur = await lockOwnEvent(tx, actor, rawId);
    if (cur.version !== data.version) throw new VersionConflictError(await currentOwnerView(tx, cur.id));
    if (cur.status === "cancelled") throw new CodedConflictError("event_cancelled", "A cancelled event can't be edited. Delete it instead.");

    const next = {
      title: data.title ?? cur.title,
      slug: data.slug ?? cur.slug,
      description: data.description ?? cur.description,
      venueName: data.venueName ?? cur.venueName,
      address: data.address ?? cur.address,
      timeZone: data.timeZone ?? cur.timeZone,
      startsAt: data.startsAt ?? cur.startsAt,
      endsAt: data.endsAt ?? cur.endsAt,
      doorsAt: data.doorsAt === undefined ? cur.doorsAt : data.doorsAt,
      registrationClosesAt: data.registrationClosesAt ?? cur.registrationClosesAt,
      // Left at its default (3 h before the old start) and the start moves: it follows the start.
      checkinOpensAt:
        data.checkinOpensAt ??
        (data.startsAt && cur.checkinOpensAt.getTime() === defaultTimes(cur.startsAt).checkinOpensAt.getTime() ? defaultTimes(data.startsAt).checkinOpensAt : cur.checkinOpensAt),
      maxPerRegistration: data.maxPerRegistration ?? cur.maxPerRegistration,
      contactEmail: data.contactEmail === undefined ? cur.contactEmail : data.contactEmail,
    };
    checkTimes(next);
    if (next.slug !== cur.slug && cur.status !== "draft") throw new CodedConflictError("slug_locked", "The address of a published event can't change.");

    let status: (typeof schema.EVENT_STATUSES)[number] = cur.status;
    if (data.status && data.status !== cur.status) {
      if (data.status === "published") {
        // cur.status is draft here: a cancelled event was refused above and published equals the request.
        const [{ n }] = await tx.select({ n: count() }).from(T).where(eq(T.eventId, cur.id));
        if (n < 1) throw new CodedConflictError("no_ticket_types", "Add at least one ticket type before publishing.");
        status = "published";
      } else {
        if (cur.status !== "published") throw new CodedConflictError("not_published", "Only a published event can be cancelled.");
        status = "cancelled";
      }
    }

    const bump = FAQ_FACTS.some((k) => !sameValue(next[k], cur[k]));
    if (next.slug !== cur.slug) {
      const [taken] = await tx.select({ id: E.id }).from(E).where(eq(E.slug, next.slug));
      if (taken) throw new CodedConflictError("slug_taken", "That address is taken. Pick another.");
    }
    try {
      await tx
        .update(E)
        .set({
          ...next,
          status,
          version: sql`${E.version} + 1`,
          faqVersion: bump ? sql`${E.faqVersion} + 1` : E.faqVersion,
          updatedAt: new Date(),
        })
        .where(eq(E.id, cur.id));
    } catch (err) {
      // Another organiser took the slug between the check above and now (the only unique index this update can hit).
      if (dbErrorCode(err) === "23505") throw new CodedConflictError("slug_taken", "That address is taken. Pick another.");
      throw err;
    }
  });
  return loadMyEvent(actor, rawId);
}

async function currentOwnerView(tx: Tx, id: string) {
  const [row] = await tx.select(ownerColumns).from(E).where(eq(E.id, id));
  return { ...row, ticketTypes: await ownerTypes(tx, id) };
}

/** Delete a draft or a cancelled event; everything about it goes with it by cascade. A published event is a 409: cancel it first. */
export async function deleteEvent(actor: Actor | null, rawId: string): Promise<{ deleted: true }> {
  assertCan(actor, "event:manage");
  await writeTx(actor, "event:manage", async (tx) => {
    const cur = await lockOwnEvent(tx, actor, rawId);
    if (cur.status === "published") throw new CodedConflictError("not_deletable", "Cancel a published event before deleting it.");
    await tx.delete(E).where(eq(E.id, cur.id));
  });
  log.info("event.deleted", { actorId: actor.id, eventId: idParam.parse(rawId) });
  return { deleted: true };
}

export type { UpdateEventInput };
