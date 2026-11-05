"use client";

import { useRef, useState } from "react";
import { Phone, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FollowUpDateTimeInput } from "@/components/shared/followup-datetime-input";
import {
  NOT_INTERESTED_REASONS,
  NOT_INTERESTED_REASON_LABELS,
  NO_ANSWER_REASONS,
  LEAD_HANDLER_ROLES,
  type NotInterestedReason,
} from "@/lib/constants";
import { followUpInDays, suggestFollowUp } from "@/lib/followup-hint";
import type { Lead } from "@/types";

type Panel = "spoke" | "no_answer" | "tour" | "quote" | "not_interested";

/** How a call ended. Only "Not continuing" may finish without a next step, because it closes the lead. */
type Outcome = "interested" | "waiting" | "not_continuing";
const OUTCOME_LABELS: Record<Outcome, string> = {
  interested: "Still interested",
  waiting: "Waiting on them",
  not_continuing: "Not continuing",
};

/** The quick picks for a next step: a count of days from today. */
const QUICK_DAYS: [string, number][] = [["Tomorrow", 1], ["In 3 days", 3], ["Next week", 7]];

/** Statuses where recording a quote moves the lead on to Negotiating. Later ones are left alone. */
const BEFORE_NEGOTIATING = ["new", "contacted", "tour_scheduled", "tour_completed", "proposal_sent"];

/** "yyyy-MM-ddTHH:mm" plus an hour, for a tour's end time (the form only asks for the start). */
function plusOneHour(value: string): string {
  const [d, t] = value.split("T");
  const [h, m] = t.split(":").map(Number);
  if (h < 23) return `${d}T${String(h + 1).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  return `${d}T23:59`;
}

/** Today's date in IST as yyyy-MM-dd (the browser's UTC date is a day behind before 5:30am IST). */
function istToday(): string {
  return new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10);
}

/** A tour time that has already passed would be logged as a completed tour, not a booked one. */
function isPast(value: string): boolean {
  return new Date(`${value}:00+05:30`).getTime() <= Date.now();
}

async function postActivity(leadId: string, body: Record<string, unknown>) {
  const res = await fetch(`/api/leads/${leadId}/activities`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // Whatever was pending is dealt with by this contact; the new next step replaces it.
    body: JSON.stringify({ ...body, closes_open_follow_ups: true }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const detail = err.details?.[0]?.message ?? err.error;
    throw new Error(detail || "Could not save");
  }
}

/**
 * The five one-tap actions on a lead in the Leads list. Each opens a small panel under the row that
 * asks only what that action needs, then logs the activity (which also claims the enquiry and moves
 * the status on, exactly as logging from the lead page does).
 */
export function LeadQuickActions({
  lead,
  onChanged,
  users = [],
}: {
  lead: Lead;
  onChanged: () => void;
  /** People who can host a tour. Without them the tour is booked with no host. */
  users?: { id: string; full_name: string; role: string }[];
}) {
  const [panel, setPanel] = useState<Panel | null>(null);
  const [saving, setSaving] = useState(false);

  const [note, setNote] = useState("");
  const [followUp, setFollowUp] = useState("");
  const [followUpNote, setFollowUpNote] = useState("");
  const [reason, setReason] = useState("");
  const [tourAt, setTourAt] = useState("");
  const [tourHost, setTourHost] = useState("");
  const [outcome, setOutcome] = useState<Outcome | "">("");
  // Once the person picks a follow-up themselves, typing in the note stops overwriting it.
  const followUpTouched = useRef(false);

  const open = (p: Panel) => {
    if (panel === p) return setPanel(null);
    setPanel(p);
    setNote("");
    setFollowUpNote("");
    setReason("");
    setTourAt("");
    setTourHost("");
    setOutcome("");
    followUpTouched.current = false;
    setFollowUp(p === "no_answer" ? followUpInDays(2) : p === "quote" ? followUpInDays(3) : "");
    if (p === "no_answer") setFollowUpNote("Call back");
    if (p === "quote") setFollowUpNote("Chase the quote");
  };

  const close = () => setPanel(null);

  const run = async (work: () => Promise<void>, done: string) => {
    setSaving(true);
    try {
      await work();
      toast.success(done);
      close();
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save");
    } finally {
      setSaving(false);
    }
  };

  const followUpFields = (label: string) => (
    <div className="space-y-2">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="flex flex-wrap gap-2">
        {QUICK_DAYS.map(([text, days]) => (
          <button
            key={text}
            type="button"
            onClick={() => {
              followUpTouched.current = true;
              setFollowUp(followUpInDays(days));
            }}
            className={`rounded-full border px-3 py-1 text-sm ${
              followUp === followUpInDays(days) ? "border-primary bg-primary/10 font-medium text-primary" : "hover:bg-muted"
            }`}
          >
            {text}
          </button>
        ))}
      </div>
      <FollowUpDateTimeInput
        value={followUp}
        onChange={(v) => {
          followUpTouched.current = true;
          setFollowUp(v);
        }}
      />
      {followUp && (
        <Input
          placeholder="What needs to happen?"
          value={followUpNote}
          onChange={(e) => setFollowUpNote(e.target.value)}
        />
      )}
    </div>
  );

  const followUpPayload = () =>
    followUp ? { follow_up_date: followUp, follow_up_notes: followUpNote.trim() } : {};

  const followUpReady = !followUp || !!followUpNote.trim();

  const chips = (options: readonly string[], selected: string, onPick: (v: string) => void) => (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => (
        <button
          key={o}
          type="button"
          onClick={() => onPick(o)}
          className={`rounded-full border px-3 py-1 text-sm ${
            selected === o ? "border-primary bg-primary/10 font-medium text-primary" : "hover:bg-muted"
          }`}
        >
          {o}
        </button>
      ))}
    </div>
  );

  const actions: { key: Panel; label: string; danger?: boolean }[] = [
    { key: "spoke", label: "Spoke" },
    { key: "no_answer", label: "No answer" },
    { key: "tour", label: "Tour booked" },
    { key: "quote", label: "Quote sent" },
    { key: "not_interested", label: "Not interested", danger: true },
  ];

  return (
    <div className="space-y-2" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <div className="flex flex-wrap gap-2">
        {actions.map((a) => (
          <Button
            key={a.key}
            type="button"
            size="sm"
            variant="outline"
            aria-pressed={panel === a.key}
            className={`${a.danger ? "text-red-600 hover:text-red-700" : ""} ${panel === a.key ? "border-primary bg-primary/5" : ""}`}
            onClick={() => open(a.key)}
          >
            {a.key === "spoke" && <Phone className="mr-1 h-3.5 w-3.5" />}
            {a.label}
          </Button>
        ))}
      </div>

      {panel && (
        <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
          {panel === "spoke" && (
            <>
              <div className="space-y-1">
                <div className="text-sm font-medium">What did you discuss?</div>
                <Textarea
                  autoFocus
                  rows={2}
                  value={note}
                  onChange={(e) => {
                    const text = e.target.value;
                    setNote(text);
                    // Pre-fill the follow-up from a date in the note, until the person sets their own.
                    const hint = suggestFollowUp(text);
                    if (hint && !followUpTouched.current) setFollowUp(hint);
                  }}
                  placeholder="e.g. Wants 6 seats from January. Call Friday 4pm with pricing"
                />
              </div>
              <div className="space-y-1">
                <div className="text-sm font-medium">How did the call end?</div>
                {chips(
                  Object.values(OUTCOME_LABELS),
                  outcome ? OUTCOME_LABELS[outcome] : "",
                  (label) => {
                    const picked = (Object.keys(OUTCOME_LABELS) as Outcome[]).find((k) => OUTCOME_LABELS[k] === label) as Outcome;
                    setOutcome(picked);
                    if (picked === "waiting" && !followUpTouched.current) {
                      setFollowUp(followUpInDays(7));
                      setFollowUpNote((n) => n || "Check back");
                    }
                  },
                )}
              </div>
              {outcome === "not_continuing" ? (
                <div className="space-y-1">
                  <div className="text-sm font-medium">Why?</div>
                  {chips(
                    NOT_INTERESTED_REASONS.map((r) => NOT_INTERESTED_REASON_LABELS[r]),
                    reason,
                    setReason,
                  )}
                  <div className="text-xs text-muted-foreground">
                    No next step is needed. The lead is closed and archived, and can be restored from its page.
                  </div>
                </div>
              ) : (
                outcome &&
                followUpFields(
                  outcome === "waiting"
                    ? "Check back on (7 days from now unless you change it)"
                    : followUp
                      ? "Next step (filled in from your note, change if needed)"
                      : "Next step (required)",
                )
              )}
            </>
          )}

          {panel === "no_answer" && (
            <>
              <div className="space-y-1">
                <div className="text-sm font-medium">Why no answer?</div>
                {chips(NO_ANSWER_REASONS, reason, setReason)}
              </div>
              {followUpFields("Try again (48 hours from now unless you change it)")}
            </>
          )}

          {panel === "tour" && (
            <div className="space-y-1">
              <div className="text-sm font-medium">When is the tour?</div>
              <FollowUpDateTimeInput value={tourAt} onChange={setTourAt} minDate={istToday()} />
              {users.length > 0 && (
                <label className="mt-2 block space-y-1">
                  <span className="text-sm font-medium">Who will host it? (optional)</span>
                  <select
                    value={tourHost}
                    onChange={(e) => setTourHost(e.target.value)}
                    className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                  >
                    <option value="">No host yet</option>
                    {users
                      .filter((u) => (LEAD_HANDLER_ROLES as readonly string[]).includes(u.role))
                      .map((u) => (
                        <option key={u.id} value={u.id}>{u.full_name}</option>
                      ))}
                  </select>
                </label>
              )}
              <div className="text-xs text-muted-foreground">
                {tourAt && isPast(tourAt)
                  ? "That time has already passed. Pick a later slot."
                  : `Held at ${lead.location?.name ?? "the centre they asked for"}. You and the host are reminded 2 hours before.`}
              </div>
            </div>
          )}

          {panel === "quote" && (
            <>
              <div className="space-y-1">
                <div className="text-sm font-medium">What did you send?</div>
                <Input
                  autoFocus
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="e.g. 4 dedicated desks, ₹12,500 a seat (optional)"
                />
                <div className="text-xs text-muted-foreground">
                  A proposal sent from this lead records itself. This is for a quote sent outside the CRM.
                </div>
              </div>
              {followUpFields("Chase it on (3 days from now unless you change it)")}
            </>
          )}

          {panel === "not_interested" && (
            <>
              <div className="space-y-1">
                <div className="text-sm font-medium">Why not interested?</div>
                {chips(
                  NOT_INTERESTED_REASONS.map((r) => NOT_INTERESTED_REASON_LABELS[r]),
                  reason,
                  setReason,
                )}
              </div>
              <Input
                placeholder="Anything to add? (optional)"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <div className="text-xs text-muted-foreground">The lead moves to the archive. It can be restored from its page.</div>
            </>
          )}

          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              disabled={
                saving ||
                (panel === "spoke" &&
                  (!note.trim() ||
                    !outcome ||
                    (outcome === "not_continuing" ? !reason : !followUp || !followUpReady))) ||
                (panel === "no_answer" && (!reason || !followUp || !followUpReady)) ||
                (panel === "tour" && (!tourAt || isPast(tourAt))) ||
                (panel === "quote" && (!followUp || !followUpReady)) ||
                (panel === "not_interested" && !reason)
              }
              onClick={() => {
                if (panel === "spoke" && outcome === "not_continuing") {
                  const key = NOT_INTERESTED_REASONS.find((r) => NOT_INTERESTED_REASON_LABELS[r] === reason) as NotInterestedReason;
                  void run(async () => {
                    await postActivity(lead.id, {
                      type: "call",
                      subject: "Spoke",
                      description: note.trim(),
                      call_outcome: "connected",
                    });
                    const res = await fetch(`/api/leads/${lead.id}/not-interested`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ reason: key }),
                    });
                    if (!res.ok) {
                      const err = await res.json().catch(() => ({}));
                      // The call is already logged; say so rather than let a retry log it twice.
                      throw new Error(`Call logged, but the lead could not be closed: ${err.error || "try Not interested"}`);
                    }
                  }, "Call logged and lead closed");
                } else if (panel === "spoke") {
                  void run(
                    () =>
                      postActivity(lead.id, {
                        type: "call",
                        subject: "Spoke",
                        description: note.trim(),
                        call_outcome: "connected",
                        ...followUpPayload(),
                      }),
                    "Call logged",
                  );
                } else if (panel === "no_answer") {
                  void run(
                    () =>
                      postActivity(lead.id, {
                        type: "call",
                        subject: "No answer",
                        description: reason,
                        call_outcome: "no_answer",
                        ...followUpPayload(),
                      }),
                    "No answer logged",
                  );
                } else if (panel === "tour") {
                  void run(
                    () =>
                      postActivity(lead.id, {
                        type: "tour",
                        subject: "Tour booked",
                        meeting_start_at: tourAt,
                        meeting_end_at: plusOneHour(tourAt),
                        meeting_location: lead.location?.name,
                        tour_host_id: tourHost || undefined,
                        // The tour is the lead's next step: it shows in the list and on the calendar.
                        follow_up_date: tourAt,
                        follow_up_notes: `Tour at ${lead.location?.name ?? "the centre"}`,
                      }),
                    "Tour booked",
                  );
                } else if (panel === "quote") {
                  void run(async () => {
                    await postActivity(lead.id, {
                      type: "email",
                      subject: "Quote sent",
                      description: note.trim() || "Quote sent outside the CRM",
                      ...followUpPayload(),
                    });
                    if (BEFORE_NEGOTIATING.includes(lead.status)) {
                      const res = await fetch(`/api/leads/${lead.id}`, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ status: "negotiating" }),
                      });
                      // The quote is already logged; don't fail the tap (a retry would log it twice).
                      if (!res.ok) toast.warning("Quote logged, but the status could not be updated");
                    }
                  }, "Quote logged");
                } else if (panel === "not_interested") {
                  const key = NOT_INTERESTED_REASONS.find((r) => NOT_INTERESTED_REASON_LABELS[r] === reason) as NotInterestedReason;
                  void run(async () => {
                    const res = await fetch(`/api/leads/${lead.id}/not-interested`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ reason: key, note: note.trim() || undefined }),
                    });
                    if (!res.ok) {
                      const err = await res.json().catch(() => ({}));
                      throw new Error(err.error || "Could not close the lead");
                    }
                  }, "Lead closed and archived");
                }
              }}
            >
              {saving && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
              {panel === "not_interested"
                ? "Close and archive"
                : panel === "spoke" && outcome === "not_continuing"
                  ? "Save and close lead"
                  : panel === "tour"
                    ? "Book tour"
                    : "Save"}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={close}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
