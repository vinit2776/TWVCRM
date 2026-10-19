"use client";

import { useState } from "react";
import { Check, UserCheck, X, ClipboardPen, History, Ban, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useEnquiryNotifications } from "@/providers/enquiry-notifications-provider";
import type { ResolutionOutcome } from "@/providers/enquiry-notifications-provider";
import {
  ENQUIRY_UPDATE_KINDS,
  ENQUIRY_UPDATE_LABEL,
  followUpInputValue,
  followUpState,
  type EnquiryUpdateKind,
} from "@/lib/enquiries";
import { formatDate } from "@/lib/utils";

interface TimelineEvent {
  at: string;
  text: string;
  by: string | null;
  auto: boolean;
  nextStep?: string | null;
  followUpAt?: string | null;
}

const OUTCOMES: { value: ResolutionOutcome; label: string; dot: string }[] = [
  { value: "converted", label: "Converted to lead", dot: "bg-emerald-500" },
  { value: "not_interested", label: "Not interested / no fit", dot: "bg-slate-400" },
  { value: "no_response", label: "Followed up — no response", dot: "bg-amber-500" },
];

const STAGE_TONE: Record<string, string> = {
  new: "bg-slate-100 text-slate-700",
  contacted: "bg-blue-100 text-blue-800",
  proposal_sent: "bg-indigo-100 text-indigo-800",
  deposit_paid: "bg-violet-100 text-violet-800",
  contract_sent: "bg-amber-100 text-amber-800",
  contract_signed: "bg-teal-100 text-teal-800",
  active: "bg-emerald-100 text-emerald-800",
};

/** How far the enquiry has got, read from the lead's proposals and contracts (nobody types
 *  this). Renders nothing when the stage isn't known. */
export function StageChip({ stage }: { stage?: { key: string; label: string } | null }) {
  if (!stage) return null;
  return (
    <span
      title="Worked out from this lead's proposals and contracts"
      className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold ${STAGE_TONE[stage.key] ?? STAGE_TONE.new}`}
    >
      {stage.label}
    </span>
  );
}

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
  /** True when the enquiry is stashed as spam: shows Restore instead of the working actions. */
  isSpam?: boolean;
  nextStep: string | null;
  followUpAt: string | null;
  /** Called after any change so the host view refetches its own copy. */
  onChanged: () => void;
}

/** Claim / next step / resolve for one enquiry. Claim and resolve go through the shared
 *  notifications context so the header bell and the Leads tracker stay in step. */
export function EnquiryActions({ enquiryId, claimedAt, claimerName, resolvedAt, isSpam = false, nextStep, followUpAt, onChanged }: Props) {
  const { claim, unclaim, resolve } = useEnquiryNotifications();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<EnquiryUpdateKind | null>(null);
  const [note, setNote] = useState("");
  const [text, setText] = useState("");
  const [date, setDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const [events, setEvents] = useState<TimelineEvent[] | null>(null);

  async function loadHistory() {
    const res = await fetch(`/api/enquiries/${enquiryId}/updates`);
    if (res.ok) setEvents(((await res.json()).data ?? []) as TimelineEvent[]);
  }

  function toggleHistory() {
    const next = !showHistory;
    setShowHistory(next);
    if (next) void loadHistory();
  }

  function openEditor(next: boolean) {
    if (next) {
      setKind(null);
      setNote("");
      // Prefilled so a plan that still stands can be kept with one click; blank clears it.
      setText(nextStep ?? "");
      setDate(followUpInputValue(followUpAt));
      setError("");
    }
    setOpen(next);
  }

  async function saveUpdate() {
    if (!kind) { setError("Choose what happened first"); return; }
    if (!text.trim() && date) { setError("Add a next step to go with the date"); return; }
    setSaving(true);
    const res = await fetch(`/api/enquiries/${enquiryId}/updates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, note: note.trim() || null, next_step: text.trim() || null, follow_up_date: date || null }),
    });
    setSaving(false);
    if (!res.ok) {
      const json = await res.json().catch(() => null);
      setError(json?.error ?? "Could not save the update");
      return;
    }
    toast.success("Update saved");
    setOpen(false);
    if (showHistory) void loadHistory();
    onChanged();
  }

  async function setSpam(spam: boolean) {
    const res = await fetch(`/api/enquiries/${enquiryId}/spam`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spam }),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => null);
      toast.error(json?.error ?? "Could not update the enquiry");
      return;
    }
    if (spam) {
      toast.success("Marked as spam. It's in the Spam section of the Enquiry Log.", {
        action: { label: "Undo", onClick: () => void setSpam(false) },
      });
    } else {
      toast.success("Restored to the queue");
    }
    onChanged();
  }

  async function run(action: () => Promise<void>) {
    await action();
    onChanged();
  }

  const historyButton = (
    <button
      onClick={toggleHistory}
      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-slate-100"
    >
      <History className="h-3 w-3" />
      {showHistory ? "Hide history" : "History"}
    </button>
  );

  const timeline = showHistory && (
    <ol className="mt-1.5 space-y-1 border-l pl-3 text-xs">
      {events === null && <li className="text-muted-foreground">Loading…</li>}
      {events?.map((ev, i) => (
        <li key={i}>
          <span className="text-muted-foreground">{formatDate(ev.at)} · </span>
          {ev.text}
          {ev.by && <span className="text-muted-foreground"> · {ev.by}</span>}
          {ev.nextStep && (
            <span className="block text-muted-foreground">
              Next: {ev.nextStep}
              {ev.followUpAt && <> · due {formatDate(ev.followUpAt)}</>}
            </span>
          )}
        </li>
      ))}
    </ol>
  );

  if (isSpam) {
    return (
      <div>
        <button
          onClick={() => setSpam(false)}
          className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-100"
        >
          <Undo2 className="h-3 w-3" />
          Not spam, restore
        </button>
        {historyButton}
        {timeline}
      </div>
    );
  }

  if (resolvedAt) {
    return (
      <div>
        {historyButton}
        {timeline}
      </div>
    );
  }

  return (
    <div>
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
            <ClipboardPen className="h-3 w-3" />
            Log update
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 space-y-2">
          <label className="text-xs font-medium text-muted-foreground">What happened?</label>
          <div className="flex flex-wrap gap-1.5">
            {ENQUIRY_UPDATE_KINDS.map((k) => (
              <button
                key={k}
                onClick={() => { setKind(k); setError(""); }}
                className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                  kind === k ? "border-blue-300 bg-blue-100 text-blue-800" : "text-slate-700 hover:bg-slate-100"
                }`}
              >
                {ENQUIRY_UPDATE_LABEL[k]}
              </button>
            ))}
          </div>
          <Textarea
            value={note}
            maxLength={1000}
            rows={2}
            placeholder="Note (optional): wants a corner cabin, will confirm with partner"
            onChange={(e) => setNote(e.target.value)}
          />
          <label className="text-xs font-medium text-muted-foreground">Next step</label>
          <Input
            value={text}
            maxLength={500}
            placeholder="Visit on Thursday 4pm"
            onChange={(e) => { setText(e.target.value); setError(""); }}
          />
          <label className="text-xs font-medium text-muted-foreground">Follow up on</label>
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          {error && <p className="text-xs text-red-600">{error}</p>}
          <p className="text-[11px] text-muted-foreground">
            Leave the next step blank if nothing is planned. This replaces the current plan, and also marks you as on it if no one has taken this yet.
          </p>
          <Button size="sm" className="w-full" disabled={saving} onClick={saveUpdate}>
            {saving ? "Saving…" : "Save update"}
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
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setSpam(true)}>
            <Ban className="mr-2 h-3 w-3 text-red-600" />
            Spam / not an enquiry
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {historyButton}
    </div>
    {timeline}
    </div>
  );
}
