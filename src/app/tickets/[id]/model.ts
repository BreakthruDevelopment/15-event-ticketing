export type TicketModel = {
  id: string;
  status: "valid" | "cancelled";
  holderName: string;
  guestLabel: string | null;
  ticketTypeName: string;
  checkedIn: boolean;
  doorCode: string | null;
  /** `qrSvg` output, or null once the ticket is cancelled. Never the QR text. */
  svg: string | null;
  registrationId: string | null;
  registrationActive: boolean;
  eventStarted: boolean;
  eventTitle: string;
  eventStatus: "draft" | "published" | "cancelled";
  when: string;
  where: string;
};
