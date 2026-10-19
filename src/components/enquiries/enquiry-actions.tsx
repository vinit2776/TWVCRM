"use client";

import { useState } from "react";
import { Check, UserCheck, X, CalendarClock } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useEnquiryNotifications } from "@/providers/enquiry-notifications-provider";
import type { ResolutionOutcome } from "@/providers/enquiry-notifications-provider";
import { followUpInputValue, followUpState } from "@/lib/enquiries";
import { formatDate } from "@/lib/utils";

const OUTCOMES: { value: ResolutionOutcome; label: string; dot: string }[] = [
  { value: "converted", label: "Converted to lead", dot: "bg-emerald-500" },
  { value: "not_interested", label: "Not interested / no fit", dot: "bg-slate-400" },
  { value: "no_response", label: "Followed up — no response", dot: "bg-amber-500" },
];

/** What happens next on an enquiry, and when. Renders nothing when neither is set. */
export function NextStepLine({ nextStep, followUpAt }: { nextStep: string | null; followUpAt: string | null }) {
  if (!nextStep) return null;
  const state = followUpState(followUpAt);
  return (
    <p className="text-xs text-muted-foreground">
      <span className="font-medium text-foreground">Next:</span> {nextStep}
      {followUpAt && (
        <span
          className={`ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
            state === "overdue"
              ? "bg-red-100 text-red-800"
              : state === "today"
                ? "bg-amber-100 text-amber-800"
                : "bg-slate-100 text-slate-700"
          }`}
        >
          {state === "overdue" ? "Overdue · " : state === "today" ? "Today · " : ""}
          {formatDate(followUpAt)}
        </span>
      )}
    </p>
  );
}

interface Props {
  enquiryId: string;
  claimedAt: string | null;
  claimerName: string | null;
  resolvedAt: string | null;
  nextStep: string | null;
  followUpAt: string | null;
  /** Called after any change so the host view refetches its own copy. */
  onChanged: () => void;
}

/** Claim / next step / resolve for one enquiry. Claim and resolve go through the shared
 *  notifications context so the header bell and the Leads tracker stay in step. */
export function EnquiryActions({ enquiryId, claimedAt, claimerName, resolvedAt, nextStep, followUpAt, onChanged }: Props) {
  const { claim, unclaim, resolve } = useEnquiryNotifications();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [date, setDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  if (resolvedAt) return null;

  function openEditor(next: boolean) {
    if (next) {
      setText(nextStep ?? "");
      setDate(followUpInputValue(followUpAt));
      setError("");
    }
    setOpen(next);
  }

  async function saveNextStep() {
    if (!text.trim()) { setError("Enter the next step first"); return; }
    setSaving(true);
    const res = await fetch(`/api/enquiries/${enquiryId}/next-step`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ next_step: text.trim(), follow_up_date: date || null }),
    });
    setSaving(false);
    if (!res.ok) {
      const json = await res.json().catch(() => null);
      setError(json?.error ?? "Could not save the next step");
      return;
    }
    toast.success("Next step saved");
    setOpen(false);
    onChanged();
  }

  async function run(action: () => Promise<void>) {
    await action();
    onChanged();
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {claimedAt ? (
        <button
          onClick={() => run(() => unclaim(enquiryId))}
          className="inline-flex items-center gap-1 rounded-md bg-emerald-100 px-2 py-1 text-[11px] font-medium text-emerald-800 hover:bg-emerald-200"
          title="Release this claim"
        >
          <UserCheck className="h-3 w-3" />
          {claimerName ?? "Someone"} is on it
          <X className="ml-0.5 h-2.5 w-2.5 opacity-60" />
        </button>
      ) : (
        <button
          onClick={() => run(() => claim(enquiryId))}
          className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-100"
        >
          <UserCheck className="h-3 w-3" />
          I&apos;ll take this
        </button>
      )}

      <Popover open={open} onOpenChange={openEditor}>
        <PopoverTrigger asChild>
          <button className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-100">
            <CalendarClock className="h-3 w-3" />
            {nextStep ? "Edit next step" : "Next step"}
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 space-y-2">
          <label className="text-xs font-medium text-muted-foreground">What happens next?</label>
          <Textarea
            value={text}
            maxLength={500}
            rows={3}
            placeholder="Call back with cabin pricing"
            onChange={(e) => { setText(e.target.value); setError(""); }}
          />
          <label className="text-xs font-medium text-muted-foreground">Follow up on (optional)</label>
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          {error && <p className="text-xs text-red-600">{error}</p>}
          <p className="text-[11px] text-muted-foreground">
            Saving also marks you as on it if no one has taken this yet.
          </p>
          <Button size="sm" className="w-full" disabled={saving} onClick={saveNextStep}>
            {saving ? "Saving…" : "Save next step"}
          </Button>
        </PopoverContent>
      </Popover>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-100">
            <Check className="h-3 w-3" />
            Resolve
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          {OUTCOMES.map((o) => (
            <DropdownMenuItem key={o.value} onClick={() => run(() => resolve(enquiryId, o.value))}>
              <span className={`mr-2 inline-block h-2 w-2 rounded-full ${o.dot}`} />
              {o.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
