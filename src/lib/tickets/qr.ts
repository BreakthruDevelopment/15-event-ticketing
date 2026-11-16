import { encode } from "uqr";

/**
 * Ticket QR rendering. `uqr` 0.1.3 (MIT, zero dependencies, no install scripts, 79 KB) is pinned exactly. It picks the
 * densest mode for the text, and the ticket text (`ET1:` + Crockford base32, 60 characters, all in the alphanumeric
 * set `0-9 A-Z space $ % * + - . / :`) therefore encodes in ALPHANUMERIC mode. Version 3 at level M holds 61
 * alphanumeric characters, so `minVersion = maxVersion = 3` with `boostEcc` off pins the symbol to 29 x 29 modules,
 * level M: big modules that scan off a dim phone screen. Text that doesn't fit (byte mode needs a bigger version) makes
 * the encoder throw rather than silently grow.
 */
export const QR_VERSION = 3;
export const QR_QUIET_ZONE = 4;
export const QR_SIZE = 29;
/** What `qrSvg` accepts: the QR alphanumeric alphabet, at most 61 characters (version 3-M). */
const ALNUM_RE = /^[0-9A-Z $%*+\-./:]{1,61}$/;

/** The module matrix for `text`: version 3, level M, no border. Throws when the text isn't alphanumeric or doesn't fit version 3-M. */
export function qrMatrix(text: string): boolean[][] {
  if (!ALNUM_RE.test(text)) throw new Error("QR text must be 1-61 characters of the QR alphanumeric alphabet");
  const r = encode(text, { ecc: "M", boostEcc: false, minVersion: QR_VERSION, maxVersion: QR_VERSION, border: 0 });
  if (r.version !== QR_VERSION || r.size !== QR_SIZE) throw new Error("unexpected QR size");
  return r.data;
}

/**
 * Inline SVG for `text`: black modules on a white square with a 4-module quiet zone, whatever the theme. One path
 * (horizontal runs), `shape-rendering="crispEdges"`, scaled by CSS (`width` and `height` are left to the caller;
 * the `viewBox` is 37 x 37). Contains the text only as drawn modules, never as text.
 */
export function qrSvg(text: string): string {
  const m = qrMatrix(text);
  const total = QR_SIZE + 2 * QR_QUIET_ZONE;
  let d = "";
  for (let y = 0; y < m.length; y++) {
    let x = 0;
    while (x < m[y].length) {
      if (!m[y][x]) {
        x++;
        continue;
      }
      let run = 1;
      while (x + run < m[y].length && m[y][x + run]) run++;
      d += `M${x + QR_QUIET_ZONE} ${y + QR_QUIET_ZONE}h${run}v1h-${run}z`;
      x += run;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" role="img" aria-label="Ticket QR code">` +
    `<rect width="${total}" height="${total}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`
  );
}
