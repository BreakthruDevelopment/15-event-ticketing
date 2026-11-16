/**
 * Lint rule `brand/no-brand-cast`: nothing may be asserted into a branded text type except by the two functions that mint
 * them. `NumericText` and `WrittenText` (src/lib/faq-checks.ts) are what make the grounding checks run on the right view of
 * the text; a cast into either one (or into `never`, which is assignable to every type) defeats the check without a type error.
 *
 * Flags, in EVERY file (src, test, scripts, any directory):
 *   x as NumericText        <NumericText>x        x as unknown as WrittenText
 *   x as never              <never>x              x as (NumericText | undefined)
 * Allowed: inside `numericView` / `asWritten` in src/lib/faq-checks.ts, the only places a view is made.
 *
 * Not caught (no type information here): a value typed `any` flowing into a branded parameter. `@typescript-eslint/no-explicit-any`
 * bans writing `any`; `JSON.parse` results must be validated by zod before they are used.
 */
const BRANDS = new Set(["NumericText", "WrittenText"]);
const MINTERS = new Set(["numericView", "asWritten"]);
const HOME = "/src/lib/faq-checks.ts";

function badTarget(t) {
  if (!t) return false;
  switch (t.type) {
    case "TSNeverKeyword":
      return true;
    case "TSTypeReference": {
      const n = t.typeName;
      const name = n.type === "TSQualifiedName" ? n.right.name : n.name;
      return BRANDS.has(name);
    }
    case "TSUnionType":
    case "TSIntersectionType":
      return t.types.some(badTarget);
    case "TSParenthesizedType":
      return badTarget(t.typeAnnotation);
    default:
      return false;
  }
}

const rule = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      cast: "Do not cast into a branded text type or `never`: only numericView() and asWritten() in src/lib/faq-checks.ts make a NumericText or WrittenText.",
    },
  },
  create(context) {
    const file = context.filename.replaceAll("\\", "/");
    const home = file.endsWith(HOME);
    const insideMinter = (node) => {
      for (let n = node.parent; n; n = n.parent) {
        if (n.type === "FunctionDeclaration" && n.id && MINTERS.has(n.id.name)) return true;
      }
      return false;
    };
    const check = (node) => {
      if (!badTarget(node.typeAnnotation)) return;
      if (home && insideMinter(node)) return;
      context.report({ node, messageId: "cast" });
    };
    return { TSAsExpression: check, TSTypeAssertion: check };
  },
};

const plugin = { rules: { "no-brand-cast": rule } };
export default plugin;
