/**
 * Layout for the holder's PNG download. Pure, so it can be tested without a canvas.
 * The image is black on white because a door scanner has to read it in any theme (spec 15.2 / 15.8).
 */

import { wrapText } from "../format";

export const PNG_WIDTH = 640;
export const PNG_QR = 280;
const PAD = 32;

export type TicketPngFields = {
  eventTitle: string;
  when: string;
  where: string;
  holderName: string;
  guestLabel: string | null;
  ticketTypeName: string;
  doorCode: string | null;
};

export type DrawText = {
  op: "text";
  x: number;
  y: number;
  text: string;
  size: number;
  weight: number;
  font: "sans" | "mono";
};

export type DrawQr = { op: "qr"; x: number; y: number; size: number };

export type TicketLayout = {
  width: number;
  height: number;
  ops: (DrawText | DrawQr)[];
};

const RUN = /M(\d+(?:\.\d+)?) (\d+(?:\.\d+)?)h(\d+(?:\.\d+)?)v1h-\d+(?:\.\d+)?z/g;

/** Module runs from `qrSvg` (`M{x} {y}h{w}v1h-{w}z`). Empty when the markup is not that SVG. */
export function svgModuleRuns(markup: string): { x: number; y: number; w: number }[] {
  const runs: { x: number; y: number; w: number }[] = [];
  for (const match of markup.matchAll(RUN)) {
    runs.push({ x: Number(match[1]), y: Number(match[2]), w: Number(match[3]) });
  }
  return runs;
}

export function svgViewBoxSize(markup: string): number {
  const match = markup.match(/viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/);
  return match ? Number(match[1]) : 37;
}

/**
 * `qrSvg` output only: one svg element, no script or handler. Anything else is refused so the page never
 * injects markup it did not just build.
 */
export function ticketQrMarkup(svg: string): string | null {
  if (!svg.startsWith("<svg ") || !svg.endsWith("</svg>")) return null;
  if (svg.includes("<script") || /on[a-z]+\s*=/i.test(svg)) return null;
  if (svgModuleRuns(svg).length === 0) return null;
  return svg;
}

/** A download name from the event title. No holder name: the file can land in a downloads list. */
export function ticketPngFilename(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[^\w\s-]+/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60)
    .replace(/^-|-$/g, "");
  return `${slug || "ticket"}.png`;
}

/**
 * iOS Safari ignores `<a download>` for a PNG and needs the share sheet. iPadOS reports itself as Macintosh,
 * so a touch Mac counts too. Android Chrome takes the download path.
 */
export function prefersShareSheet(nav: { userAgent?: string; platform?: string; maxTouchPoints?: number }): boolean {
  const ua = nav.userAgent ?? "";
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  return nav.platform === "MacIntel" && (nav.maxTouchPoints ?? 0) > 1;
}

export function ticketFont(size: number, weight: number, font: "sans" | "mono"): string {
  const family = font === "mono" ? "ui-monospace, monospace" : "sans-serif";
  return `${weight} ${size}px ${family}`;
}

/** `measure` is the width of `sample` drawn in `font`. */
export function layoutTicket(fields: TicketPngFields, measure: (sample: string, font: string) => number): TicketLayout {
  const width = PNG_WIDTH;
  const content = width - PAD * 2;
  const ops: (DrawText | DrawQr)[] = [];
  let y = PAD;

  const addLines = (text: string, size: number, weight: number, font: "sans" | "mono", gap: number) => {
    const face = ticketFont(size, weight, font);
    const lines = wrapText(text, content, (sample) => measure(sample, face));
    for (const line of lines) {
      y += size;
      ops.push({ op: "text", x: PAD, y, text: line, size, weight, font });
      y += gap;
    }
  };

  addLines(fields.eventTitle, 28, 700, "sans", 8);
  y += 4;
  addLines(fields.when, 18, 400, "sans", 6);
  if (fields.where) addLines(fields.where, 18, 400, "sans", 6);
  y += 16;
  const qrX = Math.round((width - PNG_QR) / 2);
  ops.push({ op: "qr", x: qrX, y, size: PNG_QR });
  y += PNG_QR + 20;
  if (fields.doorCode) {
    addLines("Door code", 14, 600, "sans", 4);
    addLines(fields.doorCode, 28, 500, "mono", 8);
    y += 8;
  }
  addLines(fields.holderName, 20, 600, "sans", 6);
  if (fields.guestLabel) addLines(fields.guestLabel, 16, 400, "sans", 4);
  addLines(fields.ticketTypeName, 18, 400, "sans", 4);
  y += PAD;
  return { width, height: y, ops };
}
