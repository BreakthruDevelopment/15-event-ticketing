import path from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

/**
 * The brand guard is a lint rule, not a grep: these run the REAL project config over source text at paths in src/, test/ and
 * scripts/, so a cast that defeats the view types (`as never`, `<NumericText>s`, `as unknown as WrittenText`) fails `pnpm lint`
 * wherever it is written.
 */
const root = path.resolve(__dirname, "..");
const eslint = new ESLint({ cwd: root });
async function brandMessages(code: string, filePath: string) {
  const [res] = await eslint.lintText(code, { filePath: path.join(root, filePath) });
  return res.messages.filter((m) => m.ruleId === "brand/no-brand-cast");
}

const CASTS: [string, string][] = [
  ["as never", "export const f = (s: string) => { return s as never; };"],
  ["as NumericText", "export const f = (s: string) => s as NumericText;"],
  ["as WrittenText", "export const f = (s: string) => s as WrittenText;"],
  ["angle-bracket NumericText", "export const f = (s: string) => <NumericText>s;"],
  ["angle-bracket never", "export const f = (s: string) => <never>s;"],
  ["through unknown", "export const f = (s: string) => s as unknown as NumericText;"],
  ["in a union", "export const f = (s: string) => s as NumericText | undefined;"],
  ["in parentheses", "export const f = (s: string) => s as (WrittenText);"],
  ["qualified name", "export const f = (s: string) => s as Faq.NumericText;"],
];

describe("brand/no-brand-cast", () => {
  for (const file of ["src/lib/other.ts", "test/other.test.ts", "scripts/other.mts", "src/app/x.ts"]) {
    for (const [name, code] of CASTS) {
      it(`${name} is an error in ${file}`, async () => {
        expect((await brandMessages(code, file)).length).toBeGreaterThan(0);
      }, 60_000);
    }
  }

  it("is an error in faq-checks.ts outside the two minting functions", async () => {
    const code = "export function other(s: string) { return s as NumericText; }\nexport function numericView(s: string) { return s as NumericText; }";
    const messages = await brandMessages(code, "src/lib/faq-checks.ts");
    expect(messages).toHaveLength(1);
    expect(messages[0].line).toBe(1);
  }, 60_000);

  it("allows the casts that mint a view, and ordinary casts", async () => {
    expect(await brandMessages("export function numericView(s: string) { return s as NumericText; }\nexport function asWritten(s: string) { return s as WrittenText; }", "src/lib/faq-checks.ts")).toEqual([]);
    expect(await brandMessages("export const f = (s: unknown) => s as string;\nexport const g = (s: string) => s as const;", "src/lib/other.ts")).toEqual([]);
  }, 60_000);

  it("the real faq-checks.ts is clean", async () => {
    const { readFileSync } = await import("node:fs");
    const file = "src/lib/faq-checks.ts";
    expect(await brandMessages(readFileSync(path.join(root, file), "utf8"), file)).toEqual([]);
  }, 60_000);
});
