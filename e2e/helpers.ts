import { type ChildProcess, spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { qrMatrix } from "../src/lib/tickets/qr";

/** A well-formed ticket token (`ET1:` + 56 Crockford base32 characters). It is a fixture, not a signed ticket. */
export const TOKEN = `ET1:${"0123456789ABCDEFGHJKMNPQRSTVWXYZ".repeat(2).slice(0, 56)}`;
export const TOKEN_MATRIX = qrMatrix(TOKEN);

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

export interface AppServer {
  url: string;
  stop(): Promise<void>;
}

/** Starts the production standalone build (what deploys) with the self-test page switched on. */
export async function startBuiltApp(root: string): Promise<AppServer> {
  const standalone = path.join(root, ".next", "standalone");
  if (!existsSync(path.join(standalone, "server.js"))) {
    throw new Error("No production build: run `pnpm build` before the scanner browser tests.");
  }
  cpSync(path.join(root, "public"), path.join(standalone, "public"), { recursive: true });
  cpSync(path.join(root, ".next", "static"), path.join(standalone, ".next", "static"), { recursive: true });
  const port = await freePort();
  const child: ChildProcess = spawn("node", [path.join(standalone, "server.js")], {
    cwd: standalone,
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
      SCANNER_SELFTEST: "1",
      BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? "e2e-only-secret-0123456789-0123456789",
      APP_URL: `http://127.0.0.1:${port}`,
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: "ignore",
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${url}/door/scanner-selftest`);
      if (res.ok) break;
    } catch {
      // not up yet
    }
    if (i === 59) {
      child.kill();
      throw new Error("The built app did not come up");
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return {
    url,
    async stop() {
      child.kill("SIGTERM");
    },
  };
}

/**
 * A short y4m clip of the ticket QR on a white 1280x720 frame. Chromium plays it as the fake camera
 * (`--use-file-for-fake-video-capture`), so `getUserMedia`, `<video>`, canvas and the worker all run for real.
 */
export function writeQrY4m(matrix: boolean[][] = TOKEN_MATRIX): string {
  const w = 1280;
  const h = 720;
  const quiet = 4;
  const cell = 12;
  const modules = matrix.length + quiet * 2;
  const x0 = Math.floor((w - modules * cell) / 2) + quiet * cell;
  const y0 = Math.floor((h - modules * cell) / 2) + quiet * cell;
  const y = Buffer.alloc(w * h, 255);
  matrix.forEach((row, my) =>
    row.forEach((on, mx) => {
      if (!on) return;
      for (let dy = 0; dy < cell; dy++) {
        y.fill(0, (y0 + my * cell + dy) * w + x0 + mx * cell, (y0 + my * cell + dy) * w + x0 + (mx + 1) * cell);
      }
    }),
  );
  const chroma = Buffer.alloc((w / 2) * (h / 2), 128);
  const frame = Buffer.concat([Buffer.from("FRAME\n"), y, chroma, chroma]);
  const header = Buffer.from(`YUV4MPEG2 W${w} H${h} F10:1 Ip A1:1 C420jpeg\n`);
  const file = path.join(mkdtempSync(path.join(tmpdir(), "et194-y4m-")), "qr.y4m");
  writeFileSync(file, Buffer.concat([header, ...Array.from({ length: 5 }, () => frame)]));
  return file;
}

/** Polls `fn` until it returns a truthy value or `ms` passes. */
export async function until<T>(fn: () => Promise<T>, ms: number, step = 50): Promise<T | null> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await new Promise((r) => setTimeout(r, step));
  }
}
