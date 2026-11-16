/**
 * Better Auth admin-plugin permissions.
 *
 * Our apps promise that admins see counts, never other users' private data.
 * Better Auth's default `admin` role includes `impersonate` and `set-password`
 * (and the statement list has `impersonate-admins` and `set-email`), which would
 * let an admin become any user or reset their password. This role leaves those out.
 *
 * Deliberately NOT granted to admins: user `impersonate`, `impersonate-admins`,
 * `set-password`, `set-email`, and session `list` (it returns other users' raw session
 * tokens, IP addresses and user agents). Do not add them back.
 *
 * Also not granted, and disabled over HTTP: user `create`, `set-role`, `update` and `delete`. Roles change only
 * through `POST /api/admin/roles` (src/lib/auth/roles.ts), which hides or unhides the organiser's events in the same
 * transaction; Better Auth's own set-role would skip that. Account deletion is out of scope (user foreign keys restrict).
 */
import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements } from "better-auth/plugins/admin/access";

export const ac = createAccessControl(defaultStatements);

export const roles = {
  admin: ac.newRole({
    user: ["list", "ban", "get"],
    session: ["revoke", "delete"],
  }),
  // `organizer` holds no auth-admin permissions; what an organiser may do is decided in src/lib/access.ts.
  organizer: ac.newRole({ user: [], session: [] }),
  user: ac.newRole({ user: [], session: [] }),
};

/** Blocked at the HTTP layer as well, in case a role is ever widened by mistake. */
export const DISABLED_AUTH_PATHS = [
  "/admin/impersonate-user",
  "/admin/stop-impersonating",
  "/admin/set-user-password",
  "/admin/list-user-sessions",
  // Role changes and account writes go through POST /api/admin/roles only (see the header comment).
  "/admin/set-role",
  "/admin/create-user",
  "/admin/update-user",
  "/admin/remove-user",
];
