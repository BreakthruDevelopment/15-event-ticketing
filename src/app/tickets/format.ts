/** Display helpers for the holder's ticket pages. Pure: no database and no browser. */

export type TicketTiming = { event: { endsAt: Date } };

/** Upcoming means the event has not ended yet. Order is preserved. */
export function splitTickets<T extends TicketTiming>(tickets: T[], now: number): { upcoming: T[]; past: T[] } {
  const upcoming: T[] = [];
  const past: T[] = [];
  for (const ticket of tickets) {
    (ticket.event.endsAt.getTime() < now ? past : upcoming).push(ticket);
  }
  return { upcoming, past };
}

/** Request time lives here so the page component stays a pure render of its data. */
export function splitTicketsByNow<T extends TicketTiming>(tickets: T[]): { upcoming: T[]; past: T[] } {
  return splitTickets(tickets, Date.now());
}

export function hasEventStarted(startsAt: Date): boolean {
  return startsAt.getTime() <= Date.now();
}

function format(date: Date, options: Intl.DateTimeFormatOptions, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { ...options, timeZone }).format(date).replace(/\u202f/g, " ");
}

/** When the event happens, in the event's time zone (not the viewer's). */
export function formatEventWhen(startsAt: Date, endsAt: Date, timeZone: string): string {
  const day = (date: Date) =>
    format(date, { weekday: "short", month: "short", day: "numeric", year: "numeric" }, timeZone);
  const time = (date: Date) => format(date, { hour: "numeric", minute: "2-digit" }, timeZone);
  const zone = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" })
    .formatToParts(startsAt)
    .find((part) => part.type === "timeZoneName")?.value;
  const startDay = day(startsAt);
  const endDay = day(endsAt);
  const range = startDay === endDay ? `${startDay}, ${time(startsAt)} – ${time(endsAt)}` : `${startDay}, ${time(startsAt)} – ${endDay}, ${time(endsAt)}`;
  return zone ? `${range} ${zone}` : range;
}

export function formatWhere(venueName: string, address: string): string {
  const place = address.trim();
  return place ? `${venueName}, ${place}` : venueName;
}

/** Break `text` into lines that fit `maxWidth`. A word with no spaces is split so a 60-character title cannot overflow. */
export function wrapText(text: string, maxWidth: number, measure: (sample: string) => number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  const pushWord = (word: string) => {
    if (measure(word) <= maxWidth) {
      const next = line ? `${line} ${word}` : word;
      if (measure(next) <= maxWidth) line = next;
      else {
        if (line) lines.push(line);
        line = word;
      }
      return;
    }
    if (line) {
      lines.push(line);
      line = "";
    }
    let chunk = "";
    for (const ch of word) {
      const next = chunk + ch;
      if (chunk && measure(next) > maxWidth) {
        lines.push(chunk);
        chunk = ch;
      } else {
        chunk = next;
      }
    }
    line = chunk;
  };
  for (const word of words.length > 0 ? words : [text]) pushWord(word);
  if (line) lines.push(line);
  if (lines.length === 0 && text) lines.push(text);
  return lines;
}
