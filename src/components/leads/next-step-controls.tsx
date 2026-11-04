"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Check, CalendarClock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FollowUpDateTimeInput, type FollowUpDateTimeStatus } from "@/components/shared/followup-datetime-input";

/** Today's date in IST as yyyy-MM-dd (the browser's UTC date is a day behind before 5:30am IST). */
function istToday(): string {
  return new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10);
}

/** A follow-up time that has already passed is not a reschedule. */
function isPast(value: string): boolean {
  return new Date(`${value}:00+05:30`).getTime() <= Date.now();
}

async function patchActivity(id: string, body: Record<string, unknown>): Promise<string | null> {
  const res = await fetch(`/api/activities/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.ok) return null;
  const err = await res.json().catch(() => ({}));
  return (err as { error?: string }).error ?? "Could not save";
}

/**
 * Mark done / Reschedule for a lead's next step (its earliest pending follow-up). Marking done
 * leaves the lead with no next step, so the next one is asked for on the lead itself; rescheduling
 * moves the same follow-up to a new IST slot and keeps what it was for.
 */
export function NextStepControls({
  activityId,
  hasNote,
  onChanged,
}: {
  activityId: string;
  /** Whether the follow-up already says what it is for; if not, rescheduling asks. */
  hasNote: boolean;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [when, setWhen] = useState("");
  const [status, setStatus] = useState<FollowUpDateTimeStatus>("empty");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const done = async () => {
    setBusy(true);
    const error = await patchActivity(activityId, { action: "close" });
    setBusy(false);
    if (error) return toast.error(error);
    toast.success("Marked done. Set the next step when you are ready.");
    onChanged();
  };

  const reschedule = async () => {
    if (status !== "valid") return toast.error("Pick both a date and a time");
    if (isPast(when)) return toast.error("Pick a time that has not passed");
    if (!hasNote && !note.trim()) return toast.error("Say what needs to happen");
    setBusy(true);
    const error = await patchActivity(activityId, {
      action: "reschedule",
      follow_up_date: when,
      ...(note.trim() ? { follow_up_notes: note.trim() } : {}),
    });
    setBusy(false);
    if (error) return toast.error(error);
    toast.success("Follow-up rescheduled");
    setOpen(false);
    setWhen("");
    setNote("");
    onChanged();
  };

  return (
    <div className="space-y-2" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <div className="flex flex-wrap gap-1.5">
        <Button type="button" size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs" disabled={busy} onClick={done}>
          <Check className="h-3.5 w-3.5" /> Mark done
        </Button>
        <Button type="button" size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs" disabled={busy} onClick={() => setOpen((o) => !o)}>
          <CalendarClock className="h-3.5 w-3.5" /> Reschedule
        </Button>
      </div>
      {open && (
        <div className="space-y-2 rounded-md border bg-background p-2">
          <FollowUpDateTimeInput value={when} onChange={setWhen} onStatusChange={setStatus} minDate={istToday()} />
          {!hasNote && (
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What needs to happen?" className="h-8 text-sm" />
          )}
          <div className="flex gap-2">
            <Button type="button" size="sm" className="h-7 px-3 text-xs" disabled={busy} onClick={reschedule}>
              Save
            </Button>
            <Button type="button" size="sm" variant="ghost" className="h-7 px-3 text-xs" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
