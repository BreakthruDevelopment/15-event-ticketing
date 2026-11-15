/** The Postgres error code (`23505` unique violation, `40P01` deadlock, ...) of a thrown database error, looking through `cause` wrappers. */
export function dbErrorCode(err: unknown): string | undefined {
  let current: unknown = err;
  for (let i = 0; i < 5 && current && typeof current === "object"; i++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}
