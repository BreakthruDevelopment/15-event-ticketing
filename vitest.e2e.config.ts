import path from "node:path";
import { defineConfig } from "vitest/config";

// Browser tests for the scanner: a production build, a real Chromium, a real Worker. Run `pnpm build` first, then
// `pnpm test:e2e:scanner`. Kept out of the default `pnpm test` (which has no browser and no build).
export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    environment: "node",
    include: ["e2e/**/*.e2e.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
