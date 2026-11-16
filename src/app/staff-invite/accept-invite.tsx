"use client";

import { useSyncExternalStore, useState } from "react";
import { buttonPrimary } from "@/components/ui/styles";
import { useAsyncAction } from "@/lib/use-async-action";
import { acceptInviteAction } from "./actions";
import { hrefWithoutHash, tokenFromHash, type FragmentToken } from "./token";

type Accepted = { title: string; replayed: boolean; token: string };

function subscribeToHash(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

/** Server render has no fragment. The browser snapshot is `location.hash`, which is never sent to the server. */
function hashInBrowser() {
  return window.location.hash;
}

function hashOnServer() {
  return "";
}

/**
 * The token is read from `location.hash` after the page loads. It is posted in the action body, then
 * `replaceState` removes the fragment. It is never copied into a path, a query string, or the rendered text.
 */
export function AcceptInvite() {
  const hash = useSyncExternalStore(subscribeToHash, hashInBrowser, hashOnServer);
  const fragment: FragmentToken = tokenFromHash(hash);
  const [accepted, setAccepted] = useState<Accepted | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const token = fragment.status === "ok" ? fragment.token : null;
  const { run, pending, error: thrown } = useAsyncAction(async () => {
    if (!token) return;
    setFormError(null);
    let result: Awaited<ReturnType<typeof acceptInviteAction>>;
    try {
      result = await acceptInviteAction(token);
    } catch {
      throw new Error("request failed");
    }
    if (!result.ok) {
      setFormError(result.error);
      return;
    }
    window.history.replaceState(null, "", hrefWithoutHash(window.location.href));
    setAccepted({ title: result.title, replayed: result.replayed, token });
  }, "Could not join the door team. Try the link again.");

  const error = thrown ?? formError;
  // replaceState does not emit hashchange, so the snapshot can still hold the token after it leaves the address bar.
  // A different fragment is a new invite and replaces the success message.
  const showingAccepted = accepted && (token === null || token === accepted.token) ? accepted : null;

  if (showingAccepted) {
    return (
      <p className="break-words text-sm" role="status">
        {showingAccepted.replayed ? "You are already on the door team for " : "You are on the door team for "}
        <span className="font-semibold">{showingAccepted.title}</span>.
      </p>
    );
  }

  if (fragment.status === "invalid") {
    return (
      <p className="text-sm font-medium text-danger" role="alert">
        This invite is not valid.
      </p>
    );
  }

  if (!token) {
    return (
      <p className="text-sm text-muted">
        Open the invite link from the organiser. The code stays after the # in that link, and this page reads it in your browser.
      </p>
    );
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void run();
      }}
    >
      <h2 className="font-display text-2xl font-semibold">Join the door team?</h2>
      <p className="text-sm text-muted">You will be able to check people in at the door for this event.</p>
      {error && (
        <p className="text-sm font-medium text-danger" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className={`${buttonPrimary} w-full sm:w-auto`} disabled={pending}>
        {pending ? "Joining…" : "Join the door team"}
      </button>
    </form>
  );
}
