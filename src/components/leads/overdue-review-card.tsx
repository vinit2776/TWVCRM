"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Eye, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PersonName } from "@/components/shared/person-name";
import { OVERDUE_REVIEW_DAYS, SNOOZE_DAYS, type ReviewAction, type ReviewMode } from "@/lib/lead-overdue-review";

interface PileItem {
  lead_id: string;
  name: string;
  status: string | null;
  owner_id: string | null;
  owner_name: string | null;
  due_at: string;
  days_overdue: number;
  next_step: string | null;
  can_act: boolean;
}

interface Planned {
  lead_id: string;
  name: string;
  from: string;
  to: string | null;
}

const ACTION_TEXT: Record<ReviewAction, string> = {
  snooze: `move the next step ${SNOOZE_DAYS} days out`,
  new_date: "move the next step to the new date",
  close_no_response: "mark the lead lost, reason “No response”",
};

/**
 * The overdue review: leads whose next step is 14 or more days past due, to clear in one go. Snooze,
 * set a new date, or close as no response. While the switch is in preview the actions change
 * nothing and show what they would do; live, each one asks first and then applies. Never contacts a
 * customer. Hidden when the review is off or there is nothing to review.
 */
export function OverdueReviewCard({ ownerId }: { ownerId: string }) {
  const [mode, setMode] = useState<ReviewMode | null>(null);
  const [rows, setRows] = useState<PileItem[] | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<null | "date" | ReviewAction>(null);
  const [date, setDate] = useState("");
  const [preview, setPreview] = useState<{ action: ReviewAction; planned: Planned[]; skipped: number } | null>(null);
  const [clearedSome, setClearedSome] = useState(false);

  const load = useCallback(() => {
    fetch(`/api/leads/overdue-review?assigned_to=${ownerId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!j) return;
        setMode(j.mode as ReviewMode);
        setRows(j.rows as PileItem[]);
      })
      .catch(() => {});
  }, [ownerId]);
  useEffect(() => {
    setSel(new Set());
    setPreview(null);
    load();
  }, [load]);

  if (!mode || mode === "off" || !rows) return null;
  if (rows.length === 0 && !clearedSome) return null;

  const mine = rows.filter((r) => r.can_act);
  const picked = rows.filter((r) => sel.has(r.lead_id));
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allMine = mine.length > 0 && picked.length === mine.length;

  const run = async (action: ReviewAction, dateValue?: string) => {
    setBusy(true);
    const res = await fetch("/api/leads/overdue-review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, lead_ids: picked.map((p) => p.lead_id), ...(dateValue ? { date: dateValue } : {}) }),
    });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    setDialog(null);
    if (!res.ok) return void toast.error(json.error ?? "Could not do that");
    if (json.dry_run) {
      setPreview({ action, planned: json.planned as Planned[], skipped: (json.skipped as unknown[]).length });
      return;
    }
    const done = (json.done as string[]).length;
    const bad = (json.failed as unknown[]).length + (json.skipped as unknown[]).length;
    toast.success(`${done} lead${done === 1 ? "" : "s"} done. Nothing was sent to any customer.${bad ? ` ${bad} could not be changed.` : ""}`);
    setClearedSome(true);
    setSel(new Set());
    load();
  };

  const chooseAction = (a: ReviewAction) => {
    setPreview(null);
    if (a === "snooze" && mode === "dry_run") void run("snooze");
    else if (a === "snooze") setDialog("snooze");
    else if (a === "new_date") setDialog("date");
    else setDialog("close_no_response");
  };

  const dateOk = date !== "" && date > new Date().toISOString().slice(0, 10);

  return (
    <section className="overflow-hidden rounded-lg border">
      <div className="flex flex-wrap items-center gap-2 border-b bg-muted/30 px-4 py-3">
        <h2 className="text-base font-semibold">Overdue review</h2>
        {rows.length > 0 && <span className="rounded-full border border-red-200 bg-red-50 px-2.5 py-0.5 text-xs font-bold text-red-700">{rows.length} to review</span>}
        <p className="min-w-0 flex-1 basis-64 text-sm text-muted-foreground">
          Leads whose next step is {OVERDUE_REVIEW_DAYS} or more days past due. Decide for each: push the date out, set a new one, or close it as no response.
        </p>
      </div>
      {mode === "dry_run" ? (
        <div className="flex items-start gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
          <Eye className="mt-0.5 h-4 w-4 shrink-0" />
          <span><b>Preview only.</b> Nothing will change yet. Choose an action to see exactly what it would do.</span>
        </div>
      ) : (
        <div className="flex items-start gap-2 border-b border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-800">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <span><b>Live.</b> Actions change the leads and are written to the audit trail.</span>
        </div>
      )}

      {rows.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
          <Button size="sm" variant="outline" className="h-9" disabled={mine.length === 0} onClick={() => setSel(allMine ? new Set() : new Set(mine.map((r) => r.lead_id)))}>
            {allMine ? "Clear" : `Select all mine (${mine.length})`}
          </Button>
          <span className="text-sm text-muted-foreground">{picked.length} selected</span>
          <span className="flex-1" />
          <Button size="sm" variant="outline" className="h-9" disabled={picked.length === 0 || busy} onClick={() => chooseAction("snooze")}>Snooze {SNOOZE_DAYS} days</Button>
          <Button size="sm" variant="outline" className="h-9" disabled={picked.length === 0 || busy} onClick={() => chooseAction("new_date")}>Set a new date…</Button>
          <Button size="sm" variant="outline" className="h-9 border-red-200 text-red-700" disabled={picked.length === 0 || busy} onClick={() => chooseAction("close_no_response")}>Close as no response…</Button>
        </div>
      )}

      {preview && (
        <div className="m-3 rounded-md border border-dashed bg-muted/30 p-3 text-sm">
          <b>Preview: this would {ACTION_TEXT[preview.action]} for {preview.planned.length} lead{preview.planned.length === 1 ? "" : "s"}</b>
          <ul className="mt-1.5 list-disc pl-5">
            {preview.planned.map((p) => (
              <li key={p.lead_id}>{p.name}</li>
            ))}
          </ul>
          {preview.skipped > 0 && <p className="mt-1.5 text-muted-foreground">{preview.skipped} would be skipped (no longer overdue, or not yours).</p>}
          <p className="mt-2 text-muted-foreground">Nothing was written. It switches to real changes when the review is set to live.</p>
          <Button size="sm" variant="outline" className="mt-2 h-9" onClick={() => setPreview(null)}>Close preview</Button>
        </div>
      )}

      {rows.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">Nothing is {OVERDUE_REVIEW_DAYS} or more days overdue. The real overdue number now means something.</p>
      ) : (
        <ul>
          {rows.map((r) => (
            <li key={r.lead_id} className={`grid grid-cols-[1.75rem_1fr_auto] items-center gap-x-3 gap-y-0.5 border-b px-4 py-2.5 last:border-b-0 sm:grid-cols-[1.75rem_1.4fr_7rem_1.6fr_9rem] ${r.can_act ? "" : "opacity-55"}`}>
              <Checkbox checked={sel.has(r.lead_id)} disabled={!r.can_act} onCheckedChange={() => toggle(r.lead_id)} aria-label={`Select ${r.name}`} title={r.can_act ? undefined : "Not your lead"} />
              <div className="min-w-0">
                <Link href={`/leads/${r.lead_id}/activity`} className="font-semibold text-primary hover:underline">{r.name}</Link>
                {r.status && <div className="text-xs capitalize text-muted-foreground">{r.status.replace(/_/g, " ")}</div>}
              </div>
              <div className="font-bold text-red-700">{r.days_overdue} days late</div>
              <div className="col-start-2 col-end-4 text-sm sm:col-auto"><span className="text-xs text-muted-foreground">Next step</span><br />{r.next_step ?? "—"}</div>
              <div className="col-start-2 col-end-4 text-sm sm:col-auto">
                <PersonName id={r.owner_id} name={r.owner_name} />
                {!r.can_act && <span className="ml-1.5 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">Not yours</span>}
              </div>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={dialog === "date"} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Set a new date</DialogTitle>
            <DialogDescription>One new date for the {picked.length} selected lead{picked.length === 1 ? "" : "s"}. It must be after today.</DialogDescription>
          </DialogHeader>
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)}>Cancel</Button>
            <Button disabled={!dateOk || busy} onClick={() => run("new_date", `${date}T09:30:00+05:30`)}>{mode === "dry_run" ? "Preview" : "Move it"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === "close_no_response" || dialog === "snooze"} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {dialog === "snooze" ? `Snooze ${picked.length} lead${picked.length === 1 ? "" : "s"} for ${SNOOZE_DAYS} days?` : `Close ${picked.length} lead${picked.length === 1 ? "" : "s"} as no response?`}
            </DialogTitle>
            <DialogDescription>
              {dialog === "snooze"
                ? "Their next step moves a week out. Nothing is sent to the customers."
                : "They are marked Lost with the reason “No response”. Nothing is sent to the customers, and each can be reopened later."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)}>Cancel</Button>
            <Button variant={dialog === "close_no_response" ? "destructive" : "default"} disabled={busy} onClick={() => dialog && dialog !== "date" && run(dialog)}>
              {mode === "dry_run" ? "Preview" : "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
