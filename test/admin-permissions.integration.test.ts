/**
 * Proves admins cannot impersonate users or set their passwords, and that roles change ONLY through
 * `setUserRole` (the logic behind `POST /api/admin/roles`): Better Auth's set-role, create-user, update-user and
 * remove-user answer 403/404 even for an admin and change nothing. List, ban and unban still work.
 * Runs against a real Postgres when TEST_DATABASE_URL is set.
 * Better Auth's origin check is off under NODE_ENV=test, so requests need no Origin header.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const PASSWORD = "correct-horse-battery";

describe.skipIf(!url)("admin permissions (Better Auth + Postgres)", () => {
  let sql: postgres.Sql;
  let handler: (req: Request) => Promise<Response>;
  let authApi: Record<string, (args: unknown) => Promise<unknown>>;
  let adminCookie: string;
  let userCookie: string;
  let victimId: string;
  let adminUserId: string;
  let plainId: string;
  const email = (n: string) => `ap-${n}@test.local`;

  async function call(path: string, body: unknown, cookie?: string) {
    return handler(
      new Request(`http://localhost:3000/api/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
        body: JSON.stringify(body),
      }),
    );
  }

  async function signUp(name: string) {
    const res = await call("/sign-up/email", { name, email: email(name), password: PASSWORD });
    expect(res.status).toBe(200);
    const { user } = (await res.json()) as { user: { id: string } };
    return user.id;
  }

  async function signIn(name: string, password = PASSWORD) {
    const res = await call("/sign-in/email", { email: email(name), password });
    if (res.status !== 200) return null;
    return res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
  }

  async function cleanup() {
    await sql`delete from "user" where email like 'ap-%@test.local'`;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    sql = postgres(url!, { max: 1 });
    await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
    await cleanup();

    const { auth } = await import("@/lib/auth");
    handler = auth().handler;
    authApi = auth().api as unknown as typeof authApi;

    const adminId = await signUp("admin");
    adminUserId = adminId;
    victimId = await signUp("victim");
    plainId = await signUp("plain");
    await sql`update "user" set role = 'admin' where id = ${adminId}`;

    adminCookie = (await signIn("admin"))!;
    userCookie = (await signIn("plain"))!;
    expect(adminCookie && userCookie).toBeTruthy();
  });

  afterAll(async () => {
    await cleanup();
    await sql.end();
  });

  const victimSessions = async () =>
    (await sql`select count(*)::int as n from session where user_id = ${victimId}`)[0].n as number;
  const impersonationSessions = async () =>
    (await sql`select count(*)::int as n from session where impersonated_by is not null`)[0]
      .n as number;

  it("refuses impersonate-user over HTTP and creates no session", async () => {
    const before = await victimSessions();
    const res = await call("/admin/impersonate-user", { userId: victimId }, adminCookie);
    expect([403, 404]).toContain(res.status);
    expect(res.headers.getSetCookie().join(";")).not.toContain("session_token");
    expect(await victimSessions()).toBe(before);
    expect(await impersonationSessions()).toBe(0);
  });

  it("refuses impersonation even if the HTTP block were bypassed (role has no permission)", async () => {
    await expect(
      authApi.impersonateUser({
        headers: new Headers({ cookie: adminCookie }),
        body: { userId: victimId },
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(await impersonationSessions()).toBe(0);
  });

  it("refuses set-user-password over HTTP and by role, and the password is unchanged", async () => {
    const res = await call(
      "/admin/set-user-password",
      { userId: victimId, newPassword: "attacker-chosen-pass" },
      adminCookie,
    );
    expect([403, 404]).toContain(res.status);
    await expect(
      authApi.setUserPassword({
        headers: new Headers({ cookie: adminCookie }),
        body: { userId: victimId, newPassword: "attacker-chosen-pass" },
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(await signIn("victim", "attacker-chosen-pass")).toBeNull();
    expect(await signIn("victim")).toBeTruthy();
  });

  it("refuses stop-impersonating and admin email changes (account-takeover via reset)", async () => {
    const res = await call("/admin/stop-impersonating", {}, adminCookie);
    expect([403, 404]).toContain(res.status);
    await expect(
      authApi.adminUpdateUser({
        headers: new Headers({ cookie: adminCookie }),
        body: { userId: victimId, data: { email: "hijack@test.local" } },
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect((await sql`select email from "user" where id = ${victimId}`)[0].email).toBe(
      email("victim"),
    );
  });

  it("refuses list-user-sessions (raw tokens, IPs, user agents) over HTTP and by role", async () => {
    const res = await handler(
      new Request(`http://localhost:3000/api/auth/admin/list-user-sessions`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: adminCookie },
        body: JSON.stringify({ userId: victimId }),
      }),
    );
    expect([403, 404]).toContain(res.status);
    await expect(
      authApi.listUserSessions({
        headers: new Headers({ cookie: adminCookie }),
        body: { userId: victimId },
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("reports impersonate as not permitted for admins via has-permission", async () => {
    const res = await call("/admin/has-permission", { permissions: { user: ["impersonate"] } }, adminCookie);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { success: boolean }).success).toBe(false);
  });

  it("does not let a plain user use admin endpoints", async () => {
    // (set-role is disabled outright now, so a 404 would prove nothing: ban-user is still enabled and must be 403.)
    const res = await call("/admin/ban-user", { userId: victimId }, userCookie);
    expect(res.status).toBe(403);
    const [row] = await sql`select banned from "user" where id = ${victimId}`;
    expect(row.banned).not.toBe(true);
  });

  const roleOf = async (id: string) => (await sql`select role from "user" where id = ${id}`)[0].role as string;

  it("refuses set-role, create-user, update-user and remove-user over HTTP for an admin, and changes nothing", async () => {
    const users = async () => (await sql`select count(*)::int as n from "user" where email like 'ap-%@test.local'`)[0].n as number;
    const before = await users();
    const attempts: [string, unknown][] = [
      ["/admin/set-role", { userId: victimId, role: "organizer" }],
      ["/admin/set-role", { userId: victimId, role: "admin" }],
      ["/admin/create-user", { email: email("created"), password: PASSWORD, name: "Created", role: "admin" }],
      ["/admin/update-user", { userId: victimId, data: { role: "organizer", name: "Renamed" } }],
      ["/admin/remove-user", { userId: victimId }],
    ];
    for (const [path, body] of attempts) {
      const res = await call(path, body, adminCookie);
      expect([403, 404], path).toContain(res.status);
    }
    expect(await roleOf(victimId)).toBe("user");
    expect((await sql`select name from "user" where id = ${victimId}`)[0].name).toBe("victim");
    expect(await users()).toBe(before);
  });

  it("refuses the same four calls even if the HTTP block were bypassed (the admin role has no permission)", async () => {
    const headers = new Headers({ cookie: adminCookie });
    const calls: (() => Promise<unknown>)[] = [
      () => authApi.setRole({ headers, body: { userId: victimId, role: "organizer" } }),
      () => authApi.createUser({ headers, body: { email: email("created2"), password: PASSWORD, name: "C", role: "admin" } }),
      () => authApi.adminUpdateUser({ headers, body: { userId: victimId, data: { role: "organizer" } } }),
      () => authApi.removeUser({ headers, body: { userId: victimId } }),
    ];
    for (const c of calls) await expect(c()).rejects.toMatchObject({ statusCode: 403 });
    expect(await roleOf(victimId)).toBe("user");
    expect(await sql`select id from "user" where id = ${victimId}`).toHaveLength(1);
  });

  it("promotes and demotes through setUserRole (POST /api/admin/roles), for admins only", async () => {
    const { setUserRole } = await import("@/lib/auth/roles");
    const admin = { id: adminUserId, role: "admin" as const };
    await expect(setUserRole(admin, { userId: victimId, role: "organizer", from: "user" })).resolves.toMatchObject({ changed: true, role: "organizer", previous: "user" });
    expect(await roleOf(victimId)).toBe("organizer");
    await expect(setUserRole(admin, { userId: victimId, role: "organizer", from: "organizer" })).resolves.toMatchObject({ changed: false });
    await expect(setUserRole(admin, { userId: victimId, role: "user", from: "organizer" })).resolves.toMatchObject({ changed: true, role: "user" });
    expect(await roleOf(victimId)).toBe("user");
    // Not for attendees, organisers or signed-out callers; not to `admin`; not for an admin target; not from a stale view.
    const grant = { userId: victimId, role: "organizer", from: "user" };
    await expect(setUserRole({ id: victimId, role: "user" }, grant)).rejects.toMatchObject({ status: 403 });
    await expect(setUserRole({ id: victimId, role: "organizer" }, grant)).rejects.toMatchObject({ status: 403 });
    await expect(setUserRole(null, grant)).rejects.toMatchObject({ status: 401 });
    await expect(setUserRole(admin, { ...grant, role: "admin" })).rejects.toMatchObject({ name: "ZodError" });
    await expect(setUserRole(admin, { userId: adminUserId, role: "user", from: "admin" })).rejects.toMatchObject({ status: 409 });
    await expect(setUserRole(admin, { userId: "ap-nobody", role: "organizer", from: "user" })).rejects.toMatchObject({ status: 404 });
    await expect(setUserRole(admin, { userId: victimId, role: "organizer", from: "organizer" })).rejects.toMatchObject({ status: 409, current: { userId: victimId, role: "user" } });
    expect(await roleOf(victimId)).toBe("user");
    expect(await roleOf(adminUserId)).toBe("admin");
  });

  it("sign-up can't set a role: posting `role` still makes an attendee", async () => {
    for (const [name, role] of [["escalate1", "admin"], ["escalate2", "organizer"]]) {
      const res = await call("/sign-up/email", { name, email: email(name), password: PASSWORD, role });
      const [row] = await sql`select role from "user" where email = ${email(name)}`;
      if (res.status === 200) expect(row.role).toBe("user");
      else expect(row).toBeUndefined();
    }
  });

  it("a signed-in user can't give themselves a role through /update-user", async () => {
    const res = await call("/update-user", { name: "Plain", role: "organizer" }, userCookie);
    expect(res.status).not.toBe(200);
    expect(await roleOf(plainId)).toBe("user");
    // ... while a harmless profile change still works.
    expect((await call("/update-user", { name: "Plain Renamed" }, userCookie)).status).toBe(200);
  });

  it("still lets an admin list users, ban and unban", async () => {
    const list = await handler(
      new Request("http://localhost:3000/api/auth/admin/list-users?limit=50", {
        headers: { cookie: adminCookie },
      }),
    );
    expect(list.status).toBe(200);
    let res = await call("/admin/ban-user", { userId: victimId }, adminCookie);
    expect(res.status).toBe(200);
    expect((await sql`select banned from "user" where id = ${victimId}`)[0].banned).toBe(true);
    res = await call("/admin/unban-user", { userId: victimId }, adminCookie);
    expect(res.status).toBe(200);
  });

  it("no longer lets an admin remove a user (account deletion is out of scope)", async () => {
    const res = await call("/admin/remove-user", { userId: victimId }, adminCookie);
    expect([403, 404]).toContain(res.status);
    expect(await sql`select id from "user" where id = ${victimId}`).toHaveLength(1);
  });
});
