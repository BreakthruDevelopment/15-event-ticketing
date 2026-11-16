import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { type Browser, type BrowserContext, chromium, devices, type Page, type Worker } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppServer, startBuiltApp, TOKEN, TOKEN_MATRIX, until, writeQrY4m } from "./helpers";

/**
 * The scanner in a real browser: a production build, a real Chromium, the real `Worker`, a fake camera that plays a
 * clip of the ticket QR. Nothing here substitutes a Node `MessageChannel` for the worker. Each of findings 1-5 from
 * review 5923130892 is one or more tests below; they fail on head 938334f.
 */

const ROOT = path.resolve(__dirname, "..");
const PATH = "/door/scanner-selftest";
let app: AppServer;
let browser: Browser;
let y4m: string;

beforeAll(async () => {
  app = await startBuiltApp(ROOT);
  y4m = writeQrY4m();
  browser = await chromium.launch({
    executablePath: process.env.SCANNER_E2E_CHROME || undefined,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-video-capture=${y4m}`,
    ],
  });
});

afterAll(async () => {
  await browser?.close();
  await app?.stop();
});

/** An iPhone-sized, touch, mobile-UA context. The engine is Chromium: WebKit is not installed here. */
async function iphone(): Promise<{ context: BrowserContext; page: Page; workers: Worker[]; pageErrors: string[] }> {
  const { defaultBrowserType: _ignored, ...iphoneProfile } = devices["iPhone 13"];
  void _ignored;
  const context = await browser.newContext({
    ...iphoneProfile,
    viewport: { width: 375, height: 812 },
    permissions: ["camera"],
  });
  // iOS Safari has no BarcodeDetector; make Chromium look the same so nothing can take the native path.
  await context.addInitScript(() => {
    delete (window as unknown as { BarcodeDetector?: unknown }).BarcodeDetector;
  });
  const page = await context.newPage();
  const workers: Worker[] = [];
  const pageErrors: string[] = [];
  page.on("worker", (w) => workers.push(w));
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  const res = await page.goto(`${app.url}${PATH}`);
  expect(res?.status()).toBe(200);
  await page.waitForFunction(() => Boolean(window.__selfTest));
  return { context, page, workers, pageErrors };
}

async function tracksEnded(page: Page): Promise<{ streams: number; live: number }> {
  return page.evaluate(() => {
    const streams = window.__selfTest!.streams;
    return {
      streams: streams.length,
      live: streams.flatMap((s) => s.getTracks()).filter((t) => t.readyState === "live").length,
    };
  });
}

type Scenario = NonNullable<Parameters<NonNullable<Window["__selfTest"]>["start"]>[0]>;
const start = (page: Page, scenario: Scenario) =>
  page.evaluate((s) => window.__selfTest!.start(s), scenario);
const status = (page: Page) => page.getByTestId("status").innerText();
const log = (page: Page) => page.evaluate(() => window.__selfTest!.log);

describe("finding 1: the worker handles messages in a real browser", () => {
  it("a real Worker answers a frame with the decoded ticket text", async () => {
    const { page, context } = await iphone();
    const r = await page.evaluate((m) => window.__selfTest!.workerRoundTrip(m, 4_000), TOKEN_MATRIX);
    await context.close();
    expect(r.errors).toBe(0);
    expect(r.ok).toBe(true);
    expect(r.text).toBe(TOKEN);
  });

  it("the emitted worker chunk registers the message handler, and no raw .ts asset ships", async () => {
    const { page, workers, context } = await iphone();
    await page.evaluate((m) => window.__selfTest!.workerRoundTrip(m, 4_000), TOKEN_MATRIX);
    expect(workers.length).toBeGreaterThan(0);
    const url = new URL(workers[0].url());
    expect(url.pathname).toMatch(/^\/_next\/static\//);
    const body = await (await page.request.get(url.toString())).text();
    // The jsQR payload lives in this chunk or one it loads; the handler registration must be in the entry chunk.
    expect(body).toMatch(/addEventListener\(\s*["']message["']|onmessage\s*=/);
    const media = readdirSync(path.join(ROOT, ".next", "static", "media"));
    expect(media.filter((f) => /jsqr\.worker.*\.ts$/.test(f))).toEqual([]);
    await context.close();
  });

  it("decodes the ticket from a fake camera through the whole pipeline, and reports time-to-decode", async () => {
    const { page, context } = await iphone();
    const { started } = await start(page, {});
    expect(started).toBe(true);
    const got = await until(async () => (await log(page)).scanAttempts.length > 0, 10_000);
    const l = await log(page);
    await context.close();
    expect(got).toBe(true);
    expect(l.scanTokens[0]).toBe(TOKEN);
    // eslint-disable-next-line no-console
    console.log(`time-to-decode (start() to onScan, fake camera, emulated iPhone 13, Chromium): ${l.scanAttempts[0]} ms`);
  });
});

describe("finding 2: a dropped worker reply does not wedge the loop", () => {
  it("recovers when the first reply never arrives, and still decodes", async () => {
    const { page, context } = await iphone();
    await start(page, { worker: "drop-first", dropCount: 1, decodeTimeoutMs: 400 });
    const got = await until(async () => (await log(page)).scanAttempts.length > 0, 10_000);
    const l = await log(page);
    await context.close();
    expect(got).toBe(true);
    expect(l.posts).toBeGreaterThan(1);
  });

  it("gives up visibly when no reply ever arrives: camera off, a message on screen", async () => {
    const { page, context } = await iphone();
    await start(page, { worker: "drop-all", decodeTimeoutMs: 300 });
    const stopped = await until(async () => (await status(page)) === "error", 8_000);
    const live = await tracksEnded(page);
    const text = stopped ? await page.getByTestId("camera-error").innerText() : "";
    const l = await log(page);
    await context.close();
    expect(stopped).toBeTruthy();
    expect(live.live).toBe(0);
    expect(l.workerTerminated).toBe(true);
    expect(text).toMatch(/manual/i);
  });
});

describe("finding 3: the camera stream does not outlive a failed start", () => {
  it("stops every track and names the decoder, not the camera, when the worker cannot be created", async () => {
    const { page, context } = await iphone();
    const r = await start(page, { worker: "throw" });
    const live = await tracksEnded(page);
    const text = await page.getByTestId("camera-error").innerText();
    await context.close();
    expect(r.started).toBe(false);
    expect(live.streams).toBeGreaterThan(0);
    expect(live.live).toBe(0);
    expect(text).not.toMatch(/could not start the camera/i);
    expect(text).toMatch(/scanner|decoder/i);
  });
});

describe("finding 4: a null 2d context fails visibly", () => {
  it("reports an error, stops the camera and terminates the worker", async () => {
    const { page, context } = await iphone();
    const r = await start(page, { canvas: "null-ctx" });
    const live = await tracksEnded(page);
    const s = await status(page);
    const text = await page.getByTestId("camera-error").innerText().catch(() => "");
    const l = await log(page);
    await context.close();
    expect(r.started).toBe(false);
    expect(s).toBe("error");
    expect(text).toMatch(/scanner|decoder/i);
    expect(live.live).toBe(0);
    expect(l.workerTerminated).toBe(true);
  });
});

describe("finding 5: a failing check-in request is not silent, and the retry is not swallowed", () => {
  it("shows an error banner, raises no unhandled rejection, and accepts the same ticket again", async () => {
    const { page, context } = await iphone();
    await start(page, { onScan: "throw-first" });
    await until(async () => (await log(page)).scanAttempts.length > 0, 10_000);
    const banner = await until(async () => page.getByTestId("banner").isVisible(), 3_000);
    const tone = banner ? await page.getByTestId("banner").getAttribute("data-tone") : null;
    // The ticket is still in front of the camera: it must be tried again well inside the 3 s dedupe window.
    const retried = await until(async () => (await log(page)).scanAttempts.length >= 2, 2_800);
    const l = await log(page);
    await context.close();
    expect(banner).toBeTruthy();
    expect(tone).toBe("error");
    expect(l.unhandled).toEqual([]);
    expect(retried).toBeTruthy();
    const [first, second] = l.scanAttempts;
    expect(second - first).toBeLessThan(2_900);
  });

  it("does not keep the ticket token in the exposed state after the scan", async () => {
    const { page, context } = await iphone();
    await start(page, {});
    await until(async () => (await log(page)).scanAttempts.length > 0, 10_000);
    await page.waitForTimeout(300);
    const dump = await page.getByTestId("state-dump").innerText();
    await context.close();
    expect(dump).not.toContain("ET1:");
  });
});

describe("375px wide", () => {
  it("renders the error states without horizontal overflow", async () => {
    const { page, context } = await iphone();
    await start(page, { worker: "throw" });
    await page.getByTestId("camera-error").waitFor();
    const m = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    await context.close();
    expect(m.client).toBe(375);
    expect(m.scroll).toBeLessThanOrEqual(m.client);
  });
});

describe("what the module must not do", () => {
  it("makes no network request of its own while scanning (the token is only handed to a callback)", async () => {
    const { page, context } = await iphone();
    const requests: string[] = [];
    page.on("request", (r) => requests.push(r.url()));
    await start(page, {});
    await until(async () => (await log(page)).scanAttempts.length > 0, 10_000);
    await page.waitForTimeout(300);
    await context.close();
    const leaked = requests.filter((u) => u.includes("ET1") || u.includes(encodeURIComponent(TOKEN)));
    expect(leaked).toEqual([]);
    expect(requests.filter((u) => /\/api\//.test(u))).toEqual([]);
  });

  it("serves camera=(self) on /door/* and camera=() elsewhere from the production build", async () => {
    const door = await fetch(`${app.url}${PATH}`);
    const home = await fetch(`${app.url}/`);
    expect(door.headers.get("permissions-policy")).toBe("camera=(self)");
    expect(home.headers.get("permissions-policy")).toBe("camera=()");
    expect(readFileSync(path.join(ROOT, "package.json"), "utf8")).toContain('"jsqr": "1.4.0"');
  });
});
