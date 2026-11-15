/** Shared fixtures for the integration tests (events, access, staff). Not a test file. */
import type postgres from "postgres";

export type TestActor = { id: string; role: "user" | "organizer" | "admin" };

export async function makeUser(sql: postgres.Sql, prefix: string, name: string, role: TestActor["role"]): Promise<TestActor> {
  const id = `${prefix}-${name}`;
  await sql`insert into "user" (id, name, email, role) values (${id}, ${name}, ${id + "@test.local"}, ${role})`;
  return { id, role };
}

/** Delete everything the test created. Foreign keys to user are `restrict`, so children go first. */
export async function cleanup(sql: postgres.Sql, prefix: string) {
  const like = `${prefix}-%`;
  await sql`delete from checkin_event where actor_id like ${like}`;
  await sql`delete from ticket where holder_user_id like ${like} or event_id in (select id from event where organizer_id like ${like})`;
  await sql`delete from registration where user_id like ${like}`;
  await sql`delete from event_staff where user_id like ${like}`;
  await sql`delete from event where organizer_id like ${like}`;
  await sql`delete from op_ledger where actor_id like ${like}`;
  await sql`delete from "user" where id like ${like}`;
}

const HOUR = 3_600_000;

/** A valid `POST /api/organizer/events` body: starts tomorrow, lasts two hours. */
export function eventInput(overrides: Record<string, unknown> = {}) {
  const start = Date.now() + 24 * HOUR;
  return {
    title: "Austin Product Meetup",
    venueName: "Capital Factory",
    address: "701 Brazos St, Austin, TX",
    description: "An evening of demos.",
    timeZone: "America/Chicago",
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(start + 2 * HOUR).toISOString(),
    clientOpId: crypto.randomUUID(),
    ...overrides,
  };
}

/** An event whose door is open now: starts in one hour, check-in opened two hours ago. */
export function openDoorInput(overrides: Record<string, unknown> = {}) {
  const start = Date.now() + HOUR;
  return eventInput({
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(start + 2 * HOUR).toISOString(),
    ...overrides,
  });
}

/** A fresh `{ clientOpId }` body for `createInvite`. */
export const op = () => ({ clientOpId: crypto.randomUUID() });

/** Fill `kind` rate allowance for `userId` so the next attempt is over the limit (or `n` short of it). */
export async function fillRate(sql: postgres.Sql, userId: string, n: number, kind = "api_write") {
  await sql`delete from rate_event where user_id = ${userId} and kind = ${kind}`;
  await sql`insert into rate_event (user_id, kind) select ${userId}, ${kind} from generate_series(1, ${n}::int)`;
}
