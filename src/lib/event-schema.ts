/**
 * Event constants and zod schemas. Pure (no database, no `server-only`), so the editor forms can reuse the same
 * limits as the data layer. The data layer parses every input with these; the CHECK constraints in
 * `src/lib/db/schema.ts` are the second layer.
 */
import { z } from "zod";
import { BadRequestError } from "@/lib/errors";
import { idText, text, uuidText } from "@/lib/text";

export const LIMITS = {
  eventsPerOrganizer: 20,
  typesPerEvent: 5,
  capacityPerType: 5_000,
  capacityPerEvent: 10_000,
  writesPerHour: 300,
  staffPerEvent: 20,
  openInvitesPerEvent: 10,
  inviteTtlHours: 72,
  maxDurationDays: 7,
  defaultMaxPerRegistration: 4,
  /** Default check-in opens this long before the start (spec: 3 h). */
  defaultCheckinLeadHours: 3,
  /** Check-in stays open this long after `ends_at` (spec: 6 h). */
  checkinTailHours: 6,
} as const;

export const TOO_MANY_WRITES = "Too many changes this hour. Try again later.";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A valid IANA zone as the runtime knows it (`Intl.supportedValuesOf` leaves out `UTC`, so it is added). */
const ZONES = new Set<string>([...Intl.supportedValuesOf("timeZone"), "UTC"]);
export const timeZoneSchema = idText.refine((z_) => ZONES.has(z_), "Unknown time zone: use an IANA name such as America/Chicago");

const MIN_TIME = Date.parse("2000-01-01T00:00:00Z");
const MAX_TIME = Date.parse("2100-01-01T00:00:00Z");
/** An ISO 8601 date-time with an offset ("2026-12-01T19:00:00-06:00" or "...Z"), kept inside 2000-2100. */
export const instant = z.iso
  .datetime({ offset: true })
  .transform((s) => new Date(s))
  .refine((d) => d.getTime() >= MIN_TIME && d.getTime() < MAX_TIME, "Date out of range");

export const slugSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9-]{3,60}$/, "Use 3 to 60 lowercase letters, digits or hyphens");

const clientOpId = z.string().uuid();

/** Every editable fact. No defaults here: `.partial()` of a defaulted field would overwrite stored values on update. */
const facts = {
  title: text(120, { min: 1, minMessage: "Title is required" }),
  slug: slugSchema,
  description: text(1500),
  venueName: text(120, { min: 1, minMessage: "Venue is required" }),
  address: text(300),
  timeZone: timeZoneSchema,
  startsAt: instant,
  endsAt: instant,
  doorsAt: instant.nullable(),
  registrationClosesAt: instant,
  checkinOpensAt: instant,
  maxPerRegistration: z.number().int().min(1).max(10),
  contactEmail: z.string().trim().email().max(200).nullable(),
};

export const newEventInput = z.strictObject({
  title: facts.title,
  slug: facts.slug.optional(),
  description: facts.description.optional().transform((v) => v ?? ""),
  venueName: facts.venueName,
  address: facts.address.optional().transform((v) => v ?? ""),
  timeZone: facts.timeZone,
  startsAt: facts.startsAt,
  endsAt: facts.endsAt,
  doorsAt: facts.doorsAt.optional().transform((v) => v ?? null),
  registrationClosesAt: facts.registrationClosesAt.optional(),
  checkinOpensAt: facts.checkinOpensAt.optional(),
  maxPerRegistration: facts.maxPerRegistration.optional().transform((v) => v ?? LIMITS.defaultMaxPerRegistration),
  contactEmail: facts.contactEmail.optional().transform((v) => v ?? null),
  /** One id per user intent (see src/lib/client-op.ts); a retry with the same id returns the first event. */
  clientOpId,
});
export type NewEventInput = z.input<typeof newEventInput>;

/** The statuses an organiser may ask for; the server decides which transition is allowed from the current one. */
export const REQUESTABLE_STATUSES = ["published", "cancelled"] as const;

export const updateEventInput = z
  .strictObject(facts)
  .partial()
  .extend({
    /** The version the editor loaded. A stale one is a 409. */
    version: z.number().int().min(1),
    status: z.enum(REQUESTABLE_STATUSES).optional(),
  })
  .refine((v) => Object.entries(v).some(([k, val]) => k !== "version" && val !== undefined), "Nothing to change");
export type UpdateEventInput = z.input<typeof updateEventInput>;

type Times = { startsAt: Date; endsAt: Date; doorsAt: Date | null; registrationClosesAt: Date; checkinOpensAt: Date };

/** Cross-field rules on the final values (create, or an update merged over the stored row). Throws a 400. */
export function checkTimes(t: Times): void {
  const span = t.endsAt.getTime() - t.startsAt.getTime();
  if (span <= 0) throw new BadRequestError("The event must end after it starts.");
  if (span > LIMITS.maxDurationDays * DAY) throw new BadRequestError(`An event can last at most ${LIMITS.maxDurationDays} days.`);
  if (t.doorsAt && t.doorsAt.getTime() > t.startsAt.getTime()) throw new BadRequestError("Doors must open at or before the start.");
  if (t.registrationClosesAt.getTime() > t.endsAt.getTime()) throw new BadRequestError("Registration must close before the event ends.");
  if (t.checkinOpensAt.getTime() > t.endsAt.getTime()) throw new BadRequestError("Check-in must open before the event ends.");
}

/** Defaults the spec names: registration closes at the start, check-in opens 3 hours before it. */
export function defaultTimes(startsAt: Date): { registrationClosesAt: Date; checkinOpensAt: Date } {
  return { registrationClosesAt: startsAt, checkinOpensAt: new Date(startsAt.getTime() - LIMITS.defaultCheckinLeadHours * HOUR) };
}

/** `Some Title!` -> `some-title`: the stem of an auto-generated slug (a random suffix keeps it unique). */
export function slugStem(title: string): string {
  const stem = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/g, "");
  return stem.length >= 3 ? stem : "event";
}

export const newTicketTypeInput = z.strictObject({
  name: text(60, { min: 1, minMessage: "Name is required" }),
  capacity: z.number().int().min(1).max(LIMITS.capacityPerType),
  position: z.number().int().min(0).max(99).optional(),
});
export type NewTicketTypeInput = z.input<typeof newTicketTypeInput>;

export const updateTicketTypeInput = z
  .strictObject({
    name: text(60, { min: 1, minMessage: "Name is required" }).optional(),
    capacity: z.number().int().min(1).max(LIMITS.capacityPerType).optional(),
    position: z.number().int().min(0).max(99).optional(),
    version: z.number().int().min(1),
  })
  .refine((v) => v.name !== undefined || v.capacity !== undefined || v.position !== undefined, "Nothing to change");
export type UpdateTicketTypeInput = z.input<typeof updateTicketTypeInput>;

/** One id per click on "Create invite" (src/lib/client-op.ts); a retry with the same id returns the same link. */
export const newInviteInput = z.strictObject({ clientOpId });

/** Staff-invite token in a body: any non-NUL text, so unknown, used and expired tokens (and nonsense) all answer the same 404. */
export const inviteTokenInput = z.strictObject({ token: idText });

/** The `hidden_reason` that `setUserRole` stamps when it hides an organiser's published events; an admin can't use it as a reason. */
export const ORGANIZER_REVOKED = "organizer_revoked";

export const hideInput = z
  .strictObject({
    hidden: z.boolean(),
    reason: text(200).optional(),
    /** One id per click (`opFor`), required: a late retry of an unhide must not clear a newer hide by another admin. */
    clientOpId,
  })
  .refine((v) => !v.hidden || (v.reason && v.reason.length > 0), "A reason is required to hide an event")
  .refine((v) => v.reason?.toLowerCase() !== ORGANIZER_REVOKED, "That reason is reserved");

export const roleInput = z.strictObject({
  userId: idText,
  /** The role to set. */
  role: z.enum(["user", "organizer"]),
  /** The role the admin saw when they decided. Applied only if the user still has it; otherwise 409 with the current role. */
  from: z.enum(["user", "organizer", "admin"]),
  /**
   * One id per click (`opFor`), required: an exact retry returns the first result, even after someone else changed the
   * role since. Without it a delayed retry of "grant" after a later "revoke" would pass the `from` check again.
   */
  clientOpId,
});

/** Body of the staff-removal DELETE: a late retry must not remove a membership the organiser granted again in between. */
export const removeStaffInput = z.strictObject({ clientOpId });

export const idParam = uuidText;
export const slugParam = idText;
export const listQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  past: z
    .enum(["0", "1"])
    .default("0")
    .transform((v) => v === "1"),
});
