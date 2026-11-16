/**
 * The 12-entry event the FAQ-bot evals run over (spec 15.5): no database, so the evals don't wait for the demo seed
 * (15.6). F3 is the parking entry and carries the demo ids, so demo mode has something to match. Doors are 6:30 PM
 * (E1); no entry mentions pets.
 */
import { DEMO_FAQ_PARKING_ID } from "@/lib/demo/ids";
import type { FaqContext, FaqEntryFacts } from "@/lib/ai/event-faq";

export const CONTACT_EMAIL = "hello@austinproductmeetup.example";

const entry = (refNo: number, question: string, answer: string, id = `0de30000-0015-4000-8000-${String(refNo).padStart(12, "0")}`): FaqEntryFacts => ({
  id,
  refNo,
  question,
  answer,
});

export const FAQ_ENTRIES: FaqEntryFacts[] = [
  entry(1, "What is this event?", "Austin Product Meetup is an evening of three short demos and open networking for people who build software products."),
  entry(2, "Does it cost anything?", "No. Tickets are free, but you need one to get in."),
  entry(3, "Where do I park?", "Lamar Street garage next to the venue, $10 for the evening.", DEMO_FAQ_PARKING_ID),
  entry(4, "Is the venue wheelchair accessible?", "Yes. The main entrance and the second floor are step-free, and an elevator is by the front desk."),
  entry(5, "Will there be food and drinks?", "Pizza and soft drinks are provided while they last. Tell us about allergies in advance by email."),
  entry(6, "Can I bring a guest?", "Each registration can hold up to 4 tickets. Register your guests on the same registration."),
  entry(7, "Is there Wi-Fi?", "Yes. The network name and password are on the screen by the front desk."),
  entry(8, "Will the talks be recorded?", "The talks are recorded and posted a week after the event. Questions from the audience are not recorded."),
  entry(9, "What should I bring?", "Your ticket on your phone or printed. A photo ID helps if your name is hard to find on the list."),
  entry(10, "Is there a dress code?", "No. Come as you are."),
  entry(11, "How do I cancel my registration?", "Open My tickets and choose Cancel registration. Cancelling before the event frees your seat for someone else."),
  entry(12, "Who do I contact with other questions?", `Email ${CONTACT_EMAIL}. We reply within two working days.`),
];

export const FAQ_EVENT: FaqContext = {
  event: {
    title: "Austin Product Meetup",
    description: "An evening of demos and conversation about building software products.",
    venueName: "Capital Factory",
    address: "701 Brazos St, Austin, TX 78701",
    timeZone: "America/Chicago",
    // 7:00 PM CST on Dec 3, 2026; doors 6:30 PM; ends 9:00 PM.
    startsAt: new Date("2026-12-04T01:00:00Z"),
    endsAt: new Date("2026-12-04T03:00:00Z"),
    doorsAt: new Date("2026-12-04T00:30:00Z"),
    registrationClosesAt: new Date("2026-12-04T01:00:00Z"),
    contactEmail: CONTACT_EMAIL,
  },
  ticketTypeNames: ["General", "Speaker"],
  entries: FAQ_ENTRIES,
};
