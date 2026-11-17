"use client";

import { useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FollowUpDateTimeInput, type FollowUpDateTimeStatus } from "@/components/shared/followup-datetime-input";
import { nextStepChip, type NextStepState } from "@/lib/next-step-chip";

const STYLES: Record<NextStepState, { box: string; big: string; side: string }> = {
  overdue: { box: "border-red-200", big: "bg-red-600 text-white", side: "border-red-200 text-red-700" },
  today: { box: "border-amber-200", big: "bg-amber-600 text-white", side: "border-amber-200 text-amber-700" },
  soon: { box: "border-emerald-200", big: "bg-emerald-600 text-white", side: "border-emerald-200 text-emerald-700" },
  far: { box: "border-slate-200", big: "bg-slate-600 text-white", side: "border-slate-200 text-slate-600" },
};

/** Today's date in IST as yyyy-MM-dd (the browser's UTC date is a day behind before 5:30am IST). */
function istToday(): string {
  return new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10);
}

/** A follow-up time that has already passed is not a reschedule. */
function isPast(value: string): boolean {
  return new Date(`${value}:00+05:30`).getTime() <= Date.now();
}

async function send(url: string, method: string, body: Record<string, unknown>): Promise<string | null> {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (res.ok) return null;
  const err = await res.json().catch(() => ({}));
  const e = err as { error?: string; details?: { message?: string }[] };
  return e.details?.[0]?.message ?? e.error ?? "Could not save";
}

/** The "no next step" state: a dashed chip that says so, instead of an empty line. */
export function NoNextStepChip() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-lg border-[1.5px] border-dashed border-amber-600 bg-amber-50 px-2.5 py-0.5 text-sm font-extrabold text-amber-700">
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
      No next step
    </span>
  );
}

/**
 * A lead's next step as one clear block: the day count first, the exact date beside it, and a
 * "change" menu for the three things you can do with it. Reschedule moves the same follow-up;
 * Mark done closes it and leaves the lead with no next step; "Mark done and set next step" closes
 * it and books the next one in one go. The lead always ends with either one next step or none, never two.
 */
export function NextStepChip({
  leadId,
  next,
  onChanged,
}: {
  leadId: string;
  next: { activity_id: string; due_at: string; notes: string | null; subject: string | null };
  onChanged: () => void;
}) {
  const chip = nextStepChip(next.due_at);
  const s = STYLES[chip.state];
  const hasNote = !!next.notes?.trim();

  const [mode, setMode] = useState<"reschedule" | "set_next" | null>(null);
  const [when, setWhen] = useState("");
  const [status, setStatus] = useState<FollowUpDateTimeStatus>("empty");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setMode(null);
    setWhen("");
    setNote("");
  };

  const done = async () => {
    setBusy(true);
    const error = await send(`/api/activities/${next.activity_id}`, "PATCH", { action: "close" });
    setBusy(false);
    if (error) return toast.error(error);
    toast.success("Marked done. Set the next step when you are ready.");
    onChanged();
  };

  const save = async () => {
    if (status !== "valid") return toast.error("Pick both a date and a time");
    if (isPast(when)) return toast.error("Pick a time that has not passed");
    const needsNote = mode === "set_next" || !hasNote;
    if (needsNote && !note.trim()) return toast.error("Say what needs to happen");
    setBusy(true);
    const error =
      mode === "reschedule"
        ? await send(`/api/activities/${next.activity_id}`, "PATCH", {
            action: "reschedule",
            follow_up_date: when,
            ...(note.trim() ? { follow_up_notes: note.trim() } : {}),
          })
        : await send(`/api/leads/${leadId}/activities`, "POST", {
            type: "note",
            subject: "Next step",
            description: note.trim(),
            follow_up_date: when,
            follow_up_notes: note.trim(),
            closes_open_follow_ups: true,
          });
    setBusy(false);
    if (error) return toast.error(error);
    toast.success(mode === "reschedule" ? "Follow-up rescheduled" : "Next step set");
    reset();
    onChanged();
  };

  return (
    <div className="w-full space-y-2" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <span className={`inline-flex items-stretch overflow-hidden rounded-lg border text-sm ${s.box}`}>
          <span className={`flex items-center gap-1 px-2.5 py-0.5 font-extrabold ${s.big}`}>
            {chip.state === "overdue" && <AlertTriangle className="h-3.5 w-3.5 shrink-0" />}
            {chip.big}
          </span>
          <span className={`flex items-center border-l bg-background px-2.5 py-0.5 font-semibold ${s.side}`}>{chip.when}</span>
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={busy}
              className={`flex items-center gap-0.5 border-l bg-background px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted ${s.side}`}
              aria-label="Change this next step"
            >
              change <ChevronDown className="h-3 w-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-60">
              <DropdownMenuItem onSelect={() => setMode("reschedule")}>
                <div>
                  <div className="font-medium">Reschedule…</div>
                  <div className="text-xs text-muted-foreground">Pick a new date, keep the same task</div>
                </div>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void done()}>
                <div>
                  <div className="font-medium">Mark done</div>
                  <div className="text-xs text-muted-foreground">Done, and leave no next step</div>
                </div>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setMode("set_next")}>
                <div>
                  <div className="font-medium">Mark done and set next step…</div>
                  <div className="text-xs text-muted-foreground">Done, and pick what is next</div>
                </div>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
        <span className="min-w-0 truncate text-foreground">{next.notes || next.subject || "Follow up"}</span>
      </div>

      {mode && (
        <div className="space-y-2 rounded-md border bg-background p-2">
          <div className="text-xs font-medium text-muted-foreground">
            {mode === "reschedule" ? "New date and time" : "What happens next, and when"}
          </div>
          <FollowUpDateTimeInput value={when} onChange={setWhen} onStatusChange={setStatus} minDate={istToday()} />
          {(mode === "set_next" || !hasNote) && (
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What needs to happen?" className="h-8 text-sm" />
          )}
          <div className="flex gap-2">
            <Button type="button" size="sm" className="h-7 px-3 text-xs" disabled={busy} onClick={save}>
              Save
            </Button>
            <Button type="button" size="sm" variant="ghost" className="h-7 px-3 text-xs" onClick={reset}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
