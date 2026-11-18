/**
 * Fixed ids of the demo workspace (spec 15.5 / 15.6). The demo seed writes the demo event and its parking FAQ entry with
 * exactly these ids, so the recorded FAQ-bot fixture (`src/lib/ai/demo.ts`) can be tied to a real entry: demo mode shows
 * the recorded parking answer only when a question word-matches the entry with `DEMO_FAQ_PARKING_ID` (`matchFaq`).
 * Reloading the demo deletes and recreates rows with these ids and nothing else. Valid RFC 4122 v4 uuids, since every id
 * schema in this app parses with `z.uuid()`.
 */
export const DEMO_EVENT_ID = "0de30000-0015-4000-8000-000000000001";
export const DEMO_FAQ_PARKING_ID = "0de30000-0015-4000-8000-0000000000f3";
