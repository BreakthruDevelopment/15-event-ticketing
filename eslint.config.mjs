import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import brand from "./eslint-rules/no-brand-cast.mjs";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // No cast into a branded text type (or `never`) anywhere, tests and scripts included. See eslint-rules/no-brand-cast.mjs.
  { files: ["**/*.{ts,tsx,mts,cts}"], plugins: { brand }, rules: { "brand/no-brand-cast": "error" } },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
