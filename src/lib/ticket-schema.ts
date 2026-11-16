/**
 * Input schemas and limits for registration and tickets (spec 15.2). Pure (no database), so the UI can share them.
 * Every id goes through `uuidText` (a NUL byte or a malformed id is a 400, never a database error) and is lower-cased,
 * so the payload hashed into `op_ledger` is the same for `ABC...` and `abc...`.
 */
import { z } from "zod";
import { text, uuidText } from "@/lib/text";

export const TICKET_LIMITS = {
  registersPerHour: 10,
  maxQuantity: 10,
  guestsPerRequest: 20,
  guestsPerEventPerDay: 500,
  reissuesPerDay: 5,
  /** `ticket.qr_epoch` is 1 to 20 in the schema, so a ticket can be reissued 19 times. */
  maxEpoch: 20,
  attendeesPageSize: 50,
  myTicketsLimit: 100,
} as const;

export const idArg = uuidText.transform((s) => s.toLowerCase());

const clientOpId = idArg;

export const registerInput = z.strictObject({
  ticketTypeId: idArg,
  quantity: z.number().int().min(1).max(TICKET_LIMITS.maxQuantity),
  /** One id per user intent (`opFor`): a retry returns the first registration. */
  clientOpId,
});
export type RegisterInput = z.input<typeof registerInput>;

/** Body of cancel, void and reissue: only the op id (the ids are in the path). */
export const opInput = z.strictObject({ clientOpId });

export const guestsInput = z.strictObject({
  ticketTypeId: idArg,
  guests: z
    .array(z.strictObject({ name: text(80, { min: 1, minMessage: "Name is required" }), label: text(40).optional() }))
    .min(1)
    .max(TICKET_LIMITS.guestsPerRequest),
  clientOpId,
});
export type GuestsInput = z.input<typeof guestsInput>;

export const attendeesQuery = z.strictObject({
  page: z.coerce.number().int().min(1).max(500).default(1),
  status: z.enum(["valid", "cancelled"]).optional(),
});
