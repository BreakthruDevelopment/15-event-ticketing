import { describe, expect, it } from "vitest";
import {
  LIMITS,
  checkTimes,
  defaultTimes,
  hideInput,
  inviteTokenInput,
  newEventInput,
  newTicketTypeInput,
  roleInput,
  slugStem,
  timeZoneSchema,
  updateEventInput,
  updateTicketTypeInput,
} from "@/lib/event-schema";

const base = () => ({
  title: "Meetup",
  venueName: "Hall",
  timeZone: "America/Chicago",
  startsAt: "2026-12-01T19:00:00-06:00",
  endsAt: "2026-12-01T21:00:00-06:00",
  clientOpId: crypto.randomUUID(),
});

describe("event schemas", () => {
  it("fills the defaults the spec names", () => {
    const e = newEventInput.parse(base());
    expect(e.maxPerRegistration).toBe(LIMITS.defaultMaxPerRegistration);
    expect(e.description).toBe("");
    expect(e.doorsAt).toBeNull();
    const d = defaultTimes(e.startsAt);
    expect(d.registrationClosesAt.getTime()).toBe(e.startsAt.getTime());
    expect(e.startsAt.getTime() - d.checkinOpensAt.getTime()).toBe(3 * 3_600_000);
  });

  it("checks the time zone against the IANA list (UTC included)", () => {
    expect(timeZoneSchema.safeParse("America/Chicago").success).toBe(true);
    expect(timeZoneSchema.safeParse("UTC").success).toBe(true);
    for (const bad of ["Mars/Olympus", "chicago", "", "America/Chicago\0"]) expect(timeZoneSchema.safeParse(bad).success, bad).toBe(false);
  });

  it("rejects unknown keys, NUL bytes, offsets-less dates and out-of-range dates", () => {
    expect(newEventInput.safeParse({ ...base(), organizerId: "x" }).success).toBe(false);
    expect(newEventInput.safeParse({ ...base(), title: "a\0b" }).success).toBe(false);
    expect(newEventInput.safeParse({ ...base(), startsAt: "2026-12-01T19:00:00" }).success).toBe(false);
    expect(newEventInput.safeParse({ ...base(), startsAt: "1999-12-31T23:00:00Z" }).success).toBe(false);
    expect(newEventInput.safeParse({ ...base(), slug: "Bad Slug" }).success).toBe(false);
    expect(newEventInput.safeParse({ ...base(), contactEmail: "nope" }).success).toBe(false);
    expect(newEventInput.safeParse({ ...base(), maxPerRegistration: 11 }).success).toBe(false);
  });

  it("an update needs a version and something to change", () => {
    expect(updateEventInput.safeParse({ version: 1 }).success).toBe(false);
    expect(updateEventInput.safeParse({ title: "x" }).success).toBe(false);
    expect(updateEventInput.safeParse({ version: 1, title: "x" }).success).toBe(true);
    expect(updateEventInput.safeParse({ version: 1, status: "draft" }).success).toBe(false);
    expect(updateEventInput.safeParse({ version: 1, organizerId: "x" }).success).toBe(false);
  });

  it("checkTimes enforces order, the 7-day cap, doors and the closing times", () => {
    const t = (o = {}) => {
      const e = newEventInput.parse(base());
      return { startsAt: e.startsAt, endsAt: e.endsAt, doorsAt: null, ...defaultTimes(e.startsAt), ...o };
    };
    expect(() => checkTimes(t())).not.toThrow();
    expect(() => checkTimes(t({ endsAt: new Date("2026-12-01T19:00:00-06:00") }))).toThrow(/end after/);
    expect(() => checkTimes(t({ endsAt: new Date("2026-12-09T19:00:00-06:00") }))).toThrow(/7 days/);
    expect(() => checkTimes(t({ doorsAt: new Date("2026-12-01T19:30:00-06:00") }))).toThrow(/Doors/);
    expect(() => checkTimes(t({ registrationClosesAt: new Date("2026-12-02T00:00:00-06:00") }))).toThrow(/Registration/);
    expect(() => checkTimes(t({ checkinOpensAt: new Date("2026-12-02T00:00:00-06:00") }))).toThrow(/Check-in/);
    expect(() => checkTimes(t({ checkinOpensAt: new Date("2026-11-30T17:59:00-06:00") }))).toThrow(/24 hours/);
  });

  it("slugStem makes a valid stem", () => {
    expect(slugStem("Austin Product Meetup!")).toBe("austin-product-meetup");
    expect(slugStem("Ünï cödé")).toMatch(/^[a-z0-9-]{3,}$/);
    expect(slugStem("!!")).toBe("event");
    expect(slugStem("x".repeat(200)).length).toBeLessThanOrEqual(50);
  });

  it("ticket type, invite, hide and role inputs", () => {
    const typeOp = crypto.randomUUID();
    expect(newTicketTypeInput.safeParse({ name: "GA", capacity: 5000, clientOpId: typeOp }).success).toBe(true);
    expect(newTicketTypeInput.safeParse({ name: "GA", capacity: 5000 }).success).toBe(false); // the op id is required
    expect(newTicketTypeInput.safeParse({ name: "GA", capacity: 5001, clientOpId: typeOp }).success).toBe(false);
    expect(newTicketTypeInput.safeParse({ name: "G\0A", capacity: 5, clientOpId: typeOp }).success).toBe(false);
    expect(updateTicketTypeInput.safeParse({ version: 1 }).success).toBe(false);
    expect(inviteTokenInput.safeParse({ token: "anything" }).success).toBe(true);
    expect(inviteTokenInput.safeParse({ token: "a\0" }).success).toBe(false);
    const opId = crypto.randomUUID();
    expect(hideInput.safeParse({ hidden: true, clientOpId: opId }).success).toBe(false);
    expect(hideInput.safeParse({ hidden: true, reason: "organizer_revoked", clientOpId: opId }).success).toBe(false);
    expect(hideInput.safeParse({ hidden: true, reason: "spam", clientOpId: opId }).success).toBe(true);
    expect(hideInput.safeParse({ hidden: false, clientOpId: opId }).success).toBe(true);
    expect(hideInput.safeParse({ hidden: false }).success).toBe(false); // the op id is required
    const r = { userId: "u", role: "organizer", from: "user", clientOpId: crypto.randomUUID() };
    expect(roleInput.safeParse(r).success).toBe(true);
    expect(roleInput.safeParse({ userId: "u", role: "organizer", clientOpId: r.clientOpId }).success).toBe(false); // `from` is required
    expect(roleInput.safeParse({ userId: "u", role: "organizer", from: "user" }).success).toBe(false); // so is `clientOpId`
    expect(roleInput.safeParse({ ...r, role: "admin" }).success).toBe(false);
    expect(roleInput.safeParse({ ...r, clientOpId: "nope" }).success).toBe(false);
  });
});
