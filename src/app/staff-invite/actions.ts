"use server";

import { requireUser } from "@/lib/auth/session";
import { errorInfo } from "@/lib/http";
import { acceptInvite } from "@/lib/staff";

export type AcceptResult = { ok: true; title: string; replayed: boolean } | { ok: false; error: string };

export async function acceptInviteAction(token: string): Promise<AcceptResult> {
  try {
    const user = await requireUser();
    const out = await acceptInvite(user, { token });
    return { ok: true, title: out.title, replayed: out.replayed };
  } catch (err) {
    const info = errorInfo(err);
    if (info.status >= 500) throw new Error("request failed");
    // Unknown, used, expired and malformed tokens look the same. The token is not repeated.
    if (info.status === 404 || info.status === 400) return { ok: false, error: "This invite isn't valid." };
    return { ok: false, error: info.body.error };
  }
}
