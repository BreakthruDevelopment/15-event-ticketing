"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { PageIntro, StatusBadge } from "@/components/ui";
import { buttonDanger, buttonOutlineAccent, buttonPrimary, buttonSecondary } from "@/components/ui/styles";
import { type KeyedOp, opFor } from "@/lib/client-op";
import { useAsyncAction } from "@/lib/use-async-action";
import { type TicketModel } from "./model";
import { ticketPngFilename, ticketQrMarkup } from "./png-layout";
import { deliverTicketPng, renderTicketPng } from "./png";
import { cancelRegistrationAction, reissueTicketAction, type TicketActionResult } from "./actions";

type Confirm = "reissue" | "cancel" | null;

export function TicketScreen({ model }: { model: TicketModel }) {
  const router = useRouter();
  const qrRef = useRef<HTMLDivElement>(null);
  const reissueOp = useRef<KeyedOp | null>(null);
  const cancelOp = useRef<KeyedOp | null>(null);
  const svg = model.svg ? ticketQrMarkup(model.svg) : null;
  const [pngSvg, setPngSvg] = useState(svg);
  const [png, setPng] = useState<Blob | null>(null);
  const [preparing, setPreparing] = useState(Boolean(svg));
  const [pngError, setPngError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [prepAttempt, setPrepAttempt] = useState(0);

  if (pngSvg !== svg) {
    setPngSvg(svg);
    setPng(null);
    setPreparing(Boolean(svg));
    setPngError(null);
  }

  useEffect(() => {
    const node = qrRef.current?.querySelector("svg");
    if (!svg || !(node instanceof SVGSVGElement)) {
      setPreparing(false);
      return;
    }
    let cancelled = false;
    setPreparing(true);
    renderTicketPng(node, {
      eventTitle: model.eventTitle,
      when: model.when,
      where: model.where,
      holderName: model.holderName,
      guestLabel: model.guestLabel,
      ticketTypeName: model.ticketTypeName,
      doorCode: model.doorCode,
    })
      .then((blob) => {
        if (!cancelled) setPng(blob);
      })
      .catch(() => {
        if (!cancelled) setPngError("The PNG couldn't be prepared. Try again.");
      })
      .finally(() => {
        if (!cancelled) setPreparing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [svg, prepAttempt, model.eventTitle, model.when, model.where, model.holderName, model.guestLabel, model.ticketTypeName, model.doorCode]);

  async function runMutation(
    op: { current: KeyedOp | null },
    kind: "reissue" | "cancel",
    work: (clientOpId: string) => Promise<TicketActionResult>,
  ) {
    setActionError(null);
    setNotice(null);
    op.current = opFor(op.current, { id: kind === "reissue" ? model.id : model.registrationId, kind });
    const clientOpId = op.current.id;
    let result: TicketActionResult;
    try {
      result = await work(clientOpId);
    } catch {
      throw new Error("request failed");
    }
    op.current = null;
    if (!result.ok) {
      setNotice(null);
      setActionError(result.error);
      return;
    }
    setActionError(null);
    setNotice(result.message);
    setConfirm(null);
    router.refresh();
  }

  const reissue = useAsyncAction(
    () => runMutation(reissueOp, "reissue", (clientOpId) => reissueTicketAction(model.id, clientOpId)),
    "Couldn't reissue this ticket. Try again.",
  );
  const cancel = useAsyncAction(
    () =>
      runMutation(cancelOp, "cancel", (clientOpId) =>
        model.registrationId ? cancelRegistrationAction(model.registrationId, clientOpId) : Promise.resolve({ ok: false, error: "This ticket has no registration to cancel." }),
      ),
    "Couldn't cancel this registration. Try again.",
  );
  const busy = reissue.pending || cancel.pending;
  const error = reissue.error ?? cancel.error ?? actionError ?? pngError;
  const canReissue = model.status === "valid";
  const canCancel = Boolean(model.registrationId && model.registrationActive && !model.eventStarted && !model.checkedIn && model.status === "valid");

  return (
    <article className="ticket-sheet mb-6 min-w-0 rounded-card border border-border bg-surface p-4 sm:p-5">
      <PageIntro section="Tickets" title={model.eventTitle} description={model.when} />
      <div className="mb-4 flex flex-wrap gap-2">
        {model.status === "cancelled" ? (
          <StatusBadge status="blocked" label="Cancelled" />
        ) : model.checkedIn ? (
          <StatusBadge status="passed" label="Checked in" />
        ) : (
          <StatusBadge status="live" label="Valid" />
        )}
        {model.eventStatus === "cancelled" && <StatusBadge status="blocked" label="Event cancelled" />}
      </div>

      {svg ? (
        <div
          ref={qrRef}
          className="ticket-qr mx-auto"
          // qrSvg's own markup: modules only, no ticket text. ticketQrMarkup refused anything else.
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <p className="text-muted">This ticket was cancelled, so the QR code and door code no longer work.</p>
      )}

      <div className="mx-auto mt-4 max-w-md min-w-0 space-y-3 text-center">
        {model.doorCode && (
          <div>
            <p className="text-sm font-medium">Door code</p>
            <p className="font-mono text-2xl tracking-wide wrap-anywhere">{model.doorCode}</p>
            <p className="text-sm text-muted">If the camera cannot read the QR, the door can type this code.</p>
          </div>
        )}
        <p className="wrap-anywhere font-semibold">{model.holderName}</p>
        {model.guestLabel && <p className="wrap-anywhere text-sm text-muted">{model.guestLabel}</p>}
        <p className="wrap-anywhere text-muted">{model.ticketTypeName}</p>
        <p className="wrap-anywhere text-muted">{model.where}</p>
      </div>

      <div className="no-print mt-6 space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
          {svg && (
            <button
              type="button"
              className={`${buttonPrimary} w-full sm:w-auto`}
              disabled={preparing || !png || busy}
              onClick={() => {
                if (!png) return;
                setPngError(null);
                void deliverTicketPng(png, ticketPngFilename(model.eventTitle)).catch(() => {
                  setPngError("The download didn't start. Try again.");
                });
              }}
            >
              Download PNG
            </button>
          )}
          <button type="button" className={`${buttonSecondary} w-full sm:w-auto`} onClick={() => window.print()}>
            Print
          </button>
          {canReissue && confirm !== "reissue" && (
            <button type="button" className={`${buttonOutlineAccent} w-full sm:w-auto`} disabled={busy} onClick={() => setConfirm("reissue")}>
              Reissue
            </button>
          )}
          {canCancel && confirm !== "cancel" && (
            <button type="button" className={`${buttonDanger} w-full sm:w-auto`} disabled={busy} onClick={() => setConfirm("cancel")}>
              Cancel registration
            </button>
          )}
        </div>

        {preparing && svg && (
          <p className="text-sm text-muted" aria-live="polite">
            Preparing the image…
          </p>
        )}

        {confirm === "reissue" && (
          <fieldset className="space-y-3 rounded-card border border-border bg-background p-3" disabled={busy}>
            <legend className="px-1 text-sm font-medium">Reissue this ticket?</legend>
            <p className="text-sm text-muted">This replaces the QR code and door code. The old ones stop working at the door.</p>
            <div className="flex flex-col gap-3 sm:flex-row">
              <button type="button" className={`${buttonPrimary} w-full sm:w-auto`} disabled={reissue.pending} onClick={reissue.run}>
                {reissue.pending ? "Reissuing…" : "Reissue this ticket"}
              </button>
              <button type="button" className={`${buttonSecondary} w-full sm:w-auto`} disabled={busy} onClick={() => setConfirm(null)}>
                Keep this ticket
              </button>
            </div>
          </fieldset>
        )}

        {confirm === "cancel" && (
          <fieldset className="space-y-3 rounded-card border border-border bg-background p-3" disabled={busy}>
            <legend className="px-1 text-sm font-medium">Cancel this registration?</legend>
            <p className="text-sm text-muted">Every ticket in it is cancelled. You can register again if seats are left.</p>
            <div className="flex flex-col gap-3 sm:flex-row">
              <button type="button" className={`${buttonDanger} w-full sm:w-auto`} disabled={cancel.pending} onClick={cancel.run}>
                {cancel.pending ? "Cancelling…" : "Cancel registration"}
              </button>
              <button type="button" className={`${buttonSecondary} w-full sm:w-auto`} disabled={busy} onClick={() => setConfirm(null)}>
                Keep this registration
              </button>
            </div>
          </fieldset>
        )}

        {model.registrationActive && model.eventStarted && model.status === "valid" && (
          <p className="text-sm text-muted">This event has started, so the registration cannot be cancelled.</p>
        )}
        {model.registrationActive && model.checkedIn && model.status === "valid" && !model.eventStarted && (
          <p className="text-sm text-muted">This ticket is already checked in, so the registration cannot be cancelled.</p>
        )}

        {notice && (
          <p className="text-sm font-medium" role="status">
            {notice}
          </p>
        )}
        {error && (
          <div role="alert" className="space-y-2">
            <p className="text-sm font-medium text-danger">{error}</p>
            {pngError && !png && svg && (
              <button type="button" className="min-h-11 font-semibold text-accent underline underline-offset-2" onClick={() => setPrepAttempt((n) => n + 1)}>
                Try again
              </button>
            )}
          </div>
        )}
      </div>
    </article>
  );
}
