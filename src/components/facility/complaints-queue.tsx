"use client";

/**
 * Complaints tab on Facility > Issues. Customer WhatsApp messages the inbound triage recognised
 * as a problem land here, matched to the customer and contract. A person assesses each one:
 * qualify it (work order, task, or reply only), ask for more information, or reject it.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SCOPE_LABEL, STATUS_STYLES, timeAgo } from "@/lib/facility-ui";
import {
  COMPLAINT_OUTCOME_LABEL,
  COMPLAINT_OUTCOMES,
  COMPLAINT_STATUS_LABEL,
  type ComplaintOutcome,
  type ComplaintStatus,
} from "@/lib/complaints";
import type { FacilityScope, FacilityIssueStatus } from "@/types";

export interface Complaint {
  id: string;
  reference: string;
  status: ComplaintStatus;
  outcome: ComplaintOutcome | null;
  customer_name: string | null;
  customer_phone: string | null;
  messages: { at?: string; text?: string }[];
  suggested_scope: FacilityScope | null;
  suggested_priority: string | null;
  repeat_count: number;
  created_at: string;
  contract: { id: string; contract_number: string; location_id: string | null; location: { id: string; name: string } | null } | null;
  issue: { id: string; issue_number: string; status: FacilityIssueStatus; assignee: { full_name: string } | null } | null;
  assessor: { full_name: string } | null;
}

const SELECT_CLASS = "h-9 w-full rounded-md border bg-background px-2 text-sm";
const STATUS_TONE: Record<ComplaintStatus, string> = {
  new: "bg-red-100 text-red-800",
  needs_info: "bg-blue-100 text-blue-800",
  qualified: "bg-emerald-100 text-emerald-800",
  not_a_complaint: "bg-slate-100 text-slate-600",
  closed: "bg-slate-100 text-slate-600",
};

export function ComplaintsQueue({ onChanged }: { onChanged?: () => void }) {
  const [view, setView] = useState<"open" | "done">("open");
  const [rows, setRows] = useState<Complaint[]>([]);
  const [loading, setLoading] = useState(true);
  const [assessing, setAssessing] = useState<Complaint | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/complaints?view=${view}`);
    if (res.ok) setRows(((await res.json()).data ?? []) as Complaint[]);
    setLoading(false);
  }, [view]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1">
        {(["open", "done"] as const).map((v) => (
          <button
            key={v}
            onClick={() => setView(v)}
            className={`rounded-full border px-3 py-1 text-xs font-medium ${
              view === v ? "border-foreground bg-foreground text-background" : "text-muted-foreground hover:bg-muted"
            }`}
          >
            {v === "open" ? "Open" : "Done"}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="py-6 text-center text-sm text-muted-foreground">Loading complaints…</p>
      ) : rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          {view === "open" ? "No open complaints. Customer problems sent on WhatsApp will appear here." : "Nothing here yet."}
        </p>
      ) : (
        <div className="grid gap-2">
          {rows.map((c) => (
            <ComplaintCard key={c.id} c={c} onAssess={() => setAssessing(c)} />
          ))}
        </div>
      )}

      {assessing && (
        <AssessDialog
          complaint={assessing}
          onClose={() => setAssessing(null)}
          onDone={() => {
            setAssessing(null);
            void load();
            onChanged?.();
          }}
        />
      )}
    </div>
  );
}

function ComplaintCard({ c, onAssess }: { c: Complaint; onAssess: () => void }) {
  const canAssess = c.status === "new" || c.status === "needs_info";
  return (
    <div className="rounded-lg border bg-background px-3 py-2.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <span className="font-mono text-xs">{c.reference}</span>{" "}
          <span className="text-sm font-medium">{c.customer_name ?? "Customer"}</span>
          <p className="text-xs text-muted-foreground">
            {c.contract?.contract_number ?? "No active contract"}
            {c.contract?.location?.name ? ` · ${c.contract.location.name}` : ""} · WhatsApp · {timeAgo(c.created_at)}
          </p>
        </div>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${STATUS_TONE[c.status]}`}>
          {COMPLAINT_STATUS_LABEL[c.status]}
        </span>
      </div>
      <ul className="mt-1.5 space-y-0.5 text-sm">
        {c.messages.slice(-3).map((m, i) => (
          <li key={i}>“{m.text}”</li>
        ))}
      </ul>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {c.suggested_scope && (
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-700">
            Suggested: {SCOPE_LABEL[c.suggested_scope]}
          </span>
        )}
        {c.repeat_count > 0 && (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800">
            Repeat: {c.repeat_count} earlier in 30 days
          </span>
        )}
        {c.issue && (
          <Link
            href={`/facility/issues/${c.issue.id}`}
            className={`rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ${STATUS_STYLES[c.issue.status]?.chip ?? ""}`}
          >
            {c.issue.issue_number} · {STATUS_STYLES[c.issue.status]?.label ?? c.issue.status}
            {c.issue.assignee ? ` · ${c.issue.assignee.full_name}` : ""}
          </Link>
        )}
        {c.outcome === "reply_only" && <span className="text-[10px] text-muted-foreground">Closed: reply only</span>}
        {canAssess && (
          <Button size="sm" className="ml-auto h-7" onClick={onAssess}>
            Assess
          </Button>
        )}
      </div>
    </div>
  );
}

interface Location { id: string; name: string }
interface Assignee { id: string; full_name: string }

function AssessDialog({ complaint, onClose, onDone }: { complaint: Complaint; onClose: () => void; onDone: () => void }) {
  const [decision, setDecision] = useState<"qualify" | "needs_info" | "not_a_complaint">("qualify");
  const [outcome, setOutcome] = useState<ComplaintOutcome>("work_order");
  const [scope, setScope] = useState<string>(complaint.suggested_scope ?? "");
  const [priority, setPriority] = useState<string>(complaint.suggested_priority ?? "medium");
  const [locationId, setLocationId] = useState<string>(complaint.contract?.location_id ?? "");
  const [assignedTo, setAssignedTo] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [title, setTitle] = useState("");
  const [locations, setLocations] = useState<Location[]>([]);
  const [assignees, setAssignees] = useState<Assignee[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/locations?is_active=true").then((r) => (r.ok ? r.json() : null)).then((j) => setLocations((j?.data ?? []) as Location[])).catch(() => {});
    fetch("/api/facility/assignees").then((r) => (r.ok ? r.json() : null)).then((j) => setAssignees((j?.data ?? []) as Assignee[])).catch(() => {});
  }, []);

  const makesIssue = decision === "qualify" && outcome !== "reply_only";

  async function submit() {
    setError("");
    if (makesIssue && !scope) { setError("Choose the department"); return; }
    if (makesIssue && !locationId) { setError("Choose the location"); return; }
    if (decision === "qualify" && outcome === "task" && (!assignedTo || !dueDate)) {
      setError("A task needs someone to do it and a due date");
      return;
    }
    setSaving(true);
    const res = await fetch(`/api/complaints/${complaint.id}/assess`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        decision,
        ...(decision === "qualify"
          ? {
              outcome,
              ...(makesIssue ? { scope, priority, location_id: locationId, title: title.trim() || undefined } : {}),
              ...(outcome === "task" ? { assigned_to: assignedTo, due_date: new Date(`${dueDate}T18:00:00+05:30`).toISOString() } : {}),
            }
          : {}),
      }),
    });
    setSaving(false);
    const json = await res.json().catch(() => null);
    if (!res.ok) { setError(json?.error ?? "Could not save the assessment"); return; }
    toast.success(json?.issue_number ? `Work order ${json.issue_number} created` : "Saved");
    onDone();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Assess {complaint.reference}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div className="rounded-md bg-muted/50 p-2">
            {complaint.messages.map((m, i) => <p key={i}>“{m.text}”</p>)}
            <p className="mt-1 text-xs text-muted-foreground">
              {complaint.customer_name} · {complaint.contract?.contract_number ?? "no active contract"}
            </p>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {([["qualify", "Valid, qualify"], ["needs_info", "Ask for more info"], ["not_a_complaint", "Not a complaint"]] as const).map(([v, label]) => (
              <button
                key={v}
                onClick={() => { setDecision(v); setError(""); }}
                className={`rounded-full border px-3 py-1 text-xs font-medium ${decision === v ? "border-blue-300 bg-blue-100 text-blue-800" : "hover:bg-muted"}`}
              >
                {label}
              </button>
            ))}
          </div>

          {decision === "qualify" && (
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground">What to do</label>
              <select className={SELECT_CLASS} value={outcome} onChange={(e) => setOutcome(e.target.value as ComplaintOutcome)}>
                {COMPLAINT_OUTCOMES.map((o) => <option key={o} value={o}>{COMPLAINT_OUTCOME_LABEL[o]}</option>)}
              </select>
              {makesIssue && (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-xs font-medium text-muted-foreground">Department</label>
                      <select className={SELECT_CLASS} value={scope} onChange={(e) => setScope(e.target.value)}>
                        <option value="">Choose…</option>
                        {(Object.keys(SCOPE_LABEL) as FacilityScope[]).map((s) => <option key={s} value={s}>{SCOPE_LABEL[s]}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="text-xs font-medium text-muted-foreground">
                        Priority{complaint.repeat_count >= 2 ? " (repeat complaint)" : ""}
                      </label>
                      <select className={SELECT_CLASS} value={priority} onChange={(e) => setPriority(e.target.value)}>
                        {["low", "medium", "high", "critical"].map((p) => <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</option>)}
                      </select>
                    </div>
                  </div>
                  <label className="text-xs font-medium text-muted-foreground">Location</label>
                  <select className={SELECT_CLASS} value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                    <option value="">Choose…</option>
                    {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                  </select>
                  <label className="text-xs font-medium text-muted-foreground">Work order title (optional)</label>
                  <Input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} placeholder="Defaults to the customer's words" />
                </>
              )}
              {outcome === "task" && (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">Assign to</label>
                    <select className={SELECT_CLASS} value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)}>
                      <option value="">Choose…</option>
                      {assignees.map((a) => <option key={a.id} value={a.id}>{a.full_name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">Due date</label>
                    <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
                  </div>
                </div>
              )}
              {outcome === "work_order" && (
                <p className="text-xs text-muted-foreground">
                  The work order is routed to the department&apos;s owner as usual; you can reassign it on the work order.
                </p>
              )}
            </div>
          )}

          {decision === "needs_info" && (
            <Textarea disabled rows={2} value="Replying to the customer from here comes next. For now the complaint stays open as Needs info." />
          )}
          {error && <p className="text-xs text-red-600">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
            <Button size="sm" disabled={saving} onClick={submit}>
              {saving ? "Saving…" : decision === "qualify" ? (makesIssue ? (outcome === "task" ? "Create task" : "Create work order") : "Close, reply only") : "Save"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
