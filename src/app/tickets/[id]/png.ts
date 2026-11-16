import { layoutTicket, prefersShareSheet, svgModuleRuns, svgViewBoxSize, ticketFont, type DrawText, type TicketPngFields } from "./png-layout";

/**
 * Draw the on-screen SVG onto a canvas and encode a PNG. No server and no extra library: iOS Safari and Android
 * Chrome both allow canvas plus `blob:` images under the ticket page's CSP. The PNG is built before the tap so
 * `navigator.share` still counts as the user's gesture (iOS drops the share sheet if the tap awaited a decode).
 */

const SCALE = 2;
const INK = "#000000";
const PAPER = "#ffffff";

function loadSvgImage(markup: string, size: number): Promise<HTMLImageElement> {
  const parsed = new DOMParser().parseFromString(markup, "image/svg+xml");
  const svg = parsed.documentElement;
  svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  const xml = new XMLSerializer().serializeToString(svg);
  const url = URL.createObjectURL(new Blob([xml], { type: "image/svg+xml;charset=utf-8" }));
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("svg"));
    };
    img.src = url;
  });
}

/** Draw the SVG on its own canvas. A tainted or blank result is discarded so the ticket canvas stays usable. */
async function rasterizeSvg(markup: string, size: number): Promise<HTMLCanvasElement | null> {
  try {
    const img = await loadSvgImage(markup, size);
    const scratch = document.createElement("canvas");
    scratch.width = size;
    scratch.height = size;
    const ctx = scratch.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(img, 0, 0, size, size);
    // Finder pattern, just inside the 4-module quiet zone. White means the SVG did not paint.
    const probe = Math.floor((size * 4.5) / svgViewBoxSize(markup));
    const pixel = ctx.getImageData(probe, probe, 1, 1).data;
    if (pixel[0] > 128 || pixel[1] > 128 || pixel[2] > 128) return null;
    return scratch;
  } catch {
    return null;
  }
}

function drawRuns(ctx: CanvasRenderingContext2D, markup: string, x: number, y: number, size: number) {
  const box = svgViewBoxSize(markup);
  const scale = size / box;
  ctx.fillStyle = PAPER;
  ctx.fillRect(x, y, size, size);
  ctx.fillStyle = INK;
  for (const run of svgModuleRuns(markup)) {
    ctx.fillRect(x + run.x * scale, y + run.y * scale, run.w * scale, 1 * scale);
  }
}

function drawText(ctx: CanvasRenderingContext2D, op: DrawText) {
  ctx.fillStyle = INK;
  ctx.font = ticketFont(op.size, op.weight, op.font);
  ctx.textBaseline = "alphabetic";
  ctx.fillText(op.text, op.x, op.y);
}

export async function renderTicketPng(svg: SVGSVGElement, fields: TicketPngFields): Promise<Blob> {
  const markup = new XMLSerializer().serializeToString(svg);
  const measure = (sample: string, font: string) => {
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return sample.length * 10;
    ctx.font = font;
    return ctx.measureText(sample).width;
  };
  const layout = layoutTicket(fields, measure);
  const qr = layout.ops.find((op): op is { op: "qr"; x: number; y: number; size: number } => op.op === "qr");
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(layout.width * SCALE);
  canvas.height = Math.ceil(layout.height * SCALE);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas");
  ctx.scale(SCALE, SCALE);
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, layout.width, layout.height);
  const raster = qr ? await rasterizeSvg(markup, qr.size * SCALE) : null;
  for (const op of layout.ops) {
    if (op.op === "text") {
      drawText(ctx, op);
      continue;
    }
    if (raster) {
      ctx.drawImage(raster, op.x, op.y, op.size, op.size);
    } else {
      drawRuns(ctx, markup, op.x, op.y, op.size);
    }
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("png");
  return blob;
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/** iOS opens the share sheet. Everywhere else saves the file. A cancelled share is not an error. */
export function deliverTicketPng(blob: Blob, filename: string): Promise<void> {
  const file = new File([blob], filename, { type: "image/png" });
  const nav = navigator;
  if (prefersShareSheet(nav) && typeof nav.canShare === "function" && nav.canShare({ files: [file] })) {
    return nav.share({ files: [file], title: "Ticket" }).catch((err: unknown) => {
      if (err instanceof DOMException && err.name === "AbortError") return;
      downloadBlob(blob, filename);
    });
  }
  downloadBlob(blob, filename);
  return Promise.resolve();
}
