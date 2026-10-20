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
import { ComplaintReplyBox, type ComplaintReply } from "@/components/facility/complaint-reply-box";
import { SCOPE_LABEL, STATUS_STYLES, timeAgo } from "@/lib/facility-ui";
import {
  COMPLAINT_OUTCOME_LABEL,
  COMPLAINT_OUTCOMES,
  COMPLAINT_STATUS_LABEL,
  REQUEST_STATUS_LABEL,
  type ComplaintOutcome,
  type ComplaintStatus,
} from "@/lib/complaints";
import {
  REQUEST_DONE_TEXT,
  REQUEST_OWNER_LABEL,
  REQUEST_OWNER_ROLE,
  REQUEST_TYPE_LABEL,
  isRequestOverdue,
  type RequestType,
} from "@/lib/requests";
import type { FacilityScope, FacilityIssueStatus } from "@/types";

export interface Complaint {
  id: string;
  reference: string;
  kind: "complaint" | "request";
  request_type: RequestType | null;
  owner_role: string | null;
  due_at: string | null;
  lead?: { id: string } | null;
  task: { id: string; status: string; due_date: string | null; assignee: { full_name: string } | null } | null;
  enquiry: { id: string; reference: string } | null;
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
  replies?: ComplaintReply[];
}

export type TemplateStatus = { received: boolean; update: boolean; resolved: boolean };

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
  const [kind, setKind] = useState<"all" | "complaint" | "request">("all");
  const [openCounts, setOpenCounts] = useState({ all: 0, requests: 0 });
  const [rows, setRows] = useState<Complaint[]>([]);
  const [templates, setTemplates] = useState<TemplateStatus>({ received: false, update: false, resolved: false });
  const [loading, setLoading] = useState(true);
  const [assessing, setAssessing] = useState<Complaint | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/complaints?view=${view}${kind === "all" ? "" : `&kind=${kind}`}`);
    if (res.ok) {
      const json = await res.json();
      setRows((json.data ?? []) as Complaint[]);
      setOpenCounts({ all: json.openCount ?? 0, requests: json.openRequests ?? 0 });
      if (json.templates) setTemplates(json.templates as TemplateStatus);
    }
    setLoading(false);
  }, [view, kind]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1">
        {(["all", "complaint", "request"] as const).map((k) => (
          <button
            key={k}
            onClick={() => setKind(k)}
            className={`rounded-full border px-3 py-1 text-xs font-medium ${
              kind === k ? "border-blue-300 bg-blue-100 text-blue-800" : "text-muted-foreground hover:bg-muted"
            }`}
          >
            {k === "all" ? "All" : k === "complaint" ? "Complaints" : `Requests${openCounts.requests ? ` (${openCounts.requests})` : ""}`}
          </button>
        ))}
        <span className="mx-1 text-muted-foreground">|</span>
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
          {view === "open" ? "Nothing open. Customer problems and requests sent on WhatsApp will appear here." : "Nothing here yet."}
        </p>
      ) : (
        <div className="grid gap-2">
          {rows.map((c) => (
            <ComplaintCard key={c.id} c={c} templates={templates} onAssess={() => setAssessing(c)} onChanged={() => void load()} />
          ))}
        </div>
      )}

      {assessing && assessing.kind === "request" && (
        <HandleRequestDialog
          request={assessing}
          templates={templates}
          onClose={() => setAssessing(null)}
          onDone={() => {
            setAssessing(null);
            void load();
            onChanged?.();
          }}
        />
      )}
      {assessing && assessing.kind !== "request" && (
        <AssessDialog
          complaint={assessing}
          templates={templates}
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

function requestActionLink(c: Complaint): { href: string; label: string } | null {
  switch (c.request_type) {
    case "invoice_copy": return c.lead?.id ? { href: `/leads/${c.lead.id}`, label: "Open customer billing" } : null;
    case "access_pass": return { href: "/vouchers", label: "Open vouchers and access" };
    case "renewal_contract": return c.contract?.id ? { href: `/contracts/${c.contract.id}`, label: "Open contract" } : c.lead?.id ? { href: `/leads/${c.lead.id}`, label: "Open customer" } : null;
    case "booking_change": return { href: "/bookings", label: "Open bookings" };
    default: return null;
  }
}

function ComplaintCard({ c, templates, onAssess, onChanged }: { c: Complaint; templates: TemplateStatus; onAssess: () => void; onChanged: () => void }) {
  const canAssess = c.status === "new" || c.status === "needs_info";
  const isRequest = c.kind === "request";
  const open = c.status === "new" || c.status === "needs_info" || c.status === "qualified";
  const overdue = isRequest && isRequestOverdue(c.due_at, open);
  const action = isRequest ? requestActionLink(c) : null;
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
          {(isRequest ? REQUEST_STATUS_LABEL : COMPLAINT_STATUS_LABEL)[c.status]}
        </span>
      </div>
      <ul className="mt-1.5 space-y-0.5 text-sm">
        {c.messages.slice(-3).map((m, i) => (
          <li key={i}>“{m.text}”</li>
        ))}
      </ul>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {isRequest && c.request_type && (
          <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-medium text-violet-800">
            {REQUEST_TYPE_LABEL[c.request_type]} · {REQUEST_OWNER_LABEL[c.request_type]}
          </span>
        )}
        {overdue && <span className="rounded-full bg-red-600 px-2 py-0.5 text-[10px] font-bold text-white">Overdue {timeAgo(c.due_at as string).replace(" ago", "")}</span>}
        {action && (
          <Link href={action.href} className="rounded-md border px-2 py-0.5 text-[10px] font-medium hover:bg-muted">
            {action.label}
          </Link>
        )}
        {c.task && (
          <Link href="/tasks" className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-800">
            Task · {c.task.status === "done" ? "done" : c.task.status.replace("_", " ")}
            {c.task.assignee ? ` · ${c.task.assignee.full_name}` : ""}
          </Link>
        )}
        {c.enquiry && (
          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-800">
            Converted to enquiry {c.enquiry.reference}
          </span>
        )}
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
            {isRequest ? "Handle" : "Assess"}
          </Button>
        )}
      </div>
      {(c.status === "needs_info" || c.status === "qualified" || (c.replies?.length ?? 0) > 0) && (
        <ComplaintReplyBox
          complaintId={c.id}
          replies={c.replies ?? []}
          canSend={c.status === "needs_info" || c.status === "qualified"}
          updateTemplateReady={templates.update}
          onSent={onChanged}
        />
      )}
    </div>
  );
}

interface Location { id: string; name: string }
interface Assignee { id: string; full_name: string }

function AssessDialog({ complaint, templates, onClose, onDone }: { complaint: Complaint; templates: TemplateStatus; onClose: () => void; onDone: () => void }) {
  const [decision, setDecision] = useState<"qualify" | "needs_info" | "not_a_complaint">("qualify");
  const [outcome, setOutcome] = useState<ComplaintOutcome>("work_order");
  const [scope, setScope] = useState<string>(complaint.suggested_scope ?? "");
  const [priority, setPriority] = useState<string>(complaint.suggested_priority ?? "medium");
  const [locationId, setLocationId] = useState<string>(complaint.contract?.location_id ?? "");
  const [assignedTo, setAssignedTo] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [title, setTitle] = useState("");
  const [replyText, setReplyText] = useState("");
  const [notify, setNotify] = useState(true);
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
    const needsReply = decision === "needs_info" || (decision === "qualify" && outcome === "reply_only");
    if (needsReply && !replyText.trim()) {
      setError(decision === "needs_info" ? "Write the question to ask the customer" : "Write the reply to send the customer");
      return;
    }
    setSaving(true);
    const res = await fetch(`/api/complaints/${complaint.id}/assess`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        decision,
        ...(needsReply ? { reply_text: replyText.trim() } : {}),
        ...(makesIssue ? { notify_customer: notify } : {}),
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
    // The decision is saved either way; say plainly if the customer was not messaged.
    if (json?.reply && json.reply.status !== "sent") {
      toast.warning(
        json.reply.detail === "template not configured"
          ? "The WhatsApp template isn't approved yet, so the customer was not messaged. Reply from WhatsApp."
          : `The customer was not messaged (${json.reply.detail ?? json.reply.status}).`
      );
    }
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

          {(decision === "needs_info" || (decision === "qualify" && outcome === "reply_only")) && (
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">
                {decision === "needs_info" ? "Question to ask the customer (sent on WhatsApp)" : "Reply to the customer (sent on WhatsApp)"}
              </label>
              <Textarea value={replyText} maxLength={300} rows={2} onChange={(e) => setReplyText(e.target.value)} />
              {!templates.update && (
                <p className="text-xs text-amber-700">The update template isn&apos;t approved yet. This will be saved but not sent; reply from WhatsApp.</p>
              )}
            </div>
          )}
          {makesIssue && (
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
              Send the customer an acknowledgement on WhatsApp
              {!templates.received && <span className="text-amber-700">(template not approved yet, will be skipped)</span>}
            </label>
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


interface AssigneeWithRole { id: string; full_name: string; role: string }

type RequestDecision = "task" | "enquiry" | "done" | "needs_info" | "not_a_request";
const DECISION_LABEL: Record<RequestDecision, string> = {
  task: "Create a task",
  enquiry: "Convert to enquiry",
  done: "Mark done",
  needs_info: "Ask for more info",
  not_a_request: "Not a request",
};

/** Handle a customer request: hand it to a task, convert it to a sales enquiry, mark it done and
 *  tell the customer, ask a question, or reject it. */
function HandleRequestDialog({ request, templates, onClose, onDone }: { request: Complaint; templates: TemplateStatus; onClose: () => void; onDone: () => void }) {
  const type = request.request_type as RequestType;
  const [decision, setDecision] = useState<RequestDecision>(type === "add_seats" ? "enquiry" : "task");
  const [assignees, setAssignees] = useState<AssigneeWithRole[]>([]);
  const [assignedTo, setAssignedTo] = useState("");
  const [due, setDue] = useState(() => {
    const d = new Date(request.due_at ?? Date.now() + 24 * 3_600_000);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  });
  const [replyText, setReplyText] = useState("");
  const [notify, setNotify] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/facility/assignees")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        const list = (j?.data ?? []) as AssigneeWithRole[];
        setAssignees(list);
        // Pre-pick the first person in the owning role; anyone can be chosen instead.
        const owner = list.find((a) => a.role === REQUEST_OWNER_ROLE[type]);
        if (owner) setAssignedTo(owner.id);
      })
      .catch(() => {});
  }, [type]);

  const needsReply = decision === "done" || decision === "needs_info";

  function pick(d: RequestDecision) {
    setDecision(d);
    setError("");
    if (d === "done" && !replyText) setReplyText(REQUEST_DONE_TEXT[type]);
  }

  async function submit() {
    setError("");
    if (decision === "task" && !assignedTo) { setError("Choose who will do it"); return; }
    if (needsReply && !replyText.trim()) { setError(decision === "done" ? "Write the message to send the customer" : "Write the question to ask the customer"); return; }
    setSaving(true);
    const res = await fetch(`/api/complaints/${request.id}/handle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        decision,
        ...(decision === "task" || decision === "enquiry" ? { assigned_to: assignedTo || undefined, notify_customer: notify } : {}),
        ...(decision === "task" ? { due_date: new Date(due).toISOString() } : {}),
        ...(needsReply ? { reply_text: replyText.trim() } : {}),
      }),
    });
    setSaving(false);
    const json = await res.json().catch(() => null);
    if (!res.ok) { setError(json?.error ?? "Could not save"); return; }
    toast.success(decision === "task" ? "Task created" : decision === "enquiry" ? "Converted to an enquiry" : "Saved");
    if (json?.reply && json.reply.status !== "sent") {
      toast.warning(
        json.reply.detail === "template not configured"
          ? "The WhatsApp template isn't approved yet, so the customer was not messaged. Reply from WhatsApp."
          : `The customer was not messaged (${json.reply.detail ?? json.reply.status}).`
      );
    }
    onDone();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Handle {request.reference}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div className="rounded-md bg-muted/50 p-2">
            {request.messages.map((m, i) => <p key={i}>“{m.text}”</p>)}
            <p className="mt-1 text-xs text-muted-foreground">
              {REQUEST_TYPE_LABEL[type]} · {request.customer_name} · {request.contract?.contract_number ?? "no active contract"}
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {(Object.keys(DECISION_LABEL) as RequestDecision[]).filter((d) => d !== "enquiry" || type === "add_seats" || type === "renewal_contract").map((d) => (
              <button
                key={d}
                onClick={() => pick(d)}
                className={`rounded-full border px-3 py-1 text-xs font-medium ${decision === d ? "border-blue-300 bg-blue-100 text-blue-800" : "hover:bg-muted"}`}
              >
                {DECISION_LABEL[d]}
              </button>
            ))}
          </div>

          {(decision === "task" || decision === "enquiry") && (
            <div className="space-y-2">
              <div className={decision === "task" ? "grid grid-cols-2 gap-2" : ""}>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">
                    {decision === "task" ? `Assign to (${REQUEST_OWNER_LABEL[type]} by default)` : "Sales owner (optional)"}
                  </label>
                  <select className={SELECT_CLASS} value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)}>
                    <option value="">{decision === "task" ? "Choose…" : "Unassigned"}</option>
                    {assignees.map((a) => <option key={a.id} value={a.id}>{a.full_name}</option>)}
                  </select>
                </div>
                {decision === "task" && (
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">Due</label>
                    <Input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
                  </div>
                )}
              </div>
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
                Send the customer an acknowledgement on WhatsApp
                {!templates.received && <span className="text-amber-700">(template not approved yet, will be skipped)</span>}
              </label>
              <p className="text-xs text-muted-foreground">
                {decision === "task"
                  ? "It appears on the Tasks page and the customer's Tasks tab. Marking the task done tells the customer and closes this request."
                  : "A sales enquiry is opened for the same customer, so it gets next steps, history and conversion tracking."}
              </p>
            </div>
          )}

          {needsReply && (
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">
                {decision === "done" ? "Message to the customer (sent on WhatsApp)" : "Question to ask the customer (sent on WhatsApp)"}
              </label>
              <Textarea value={replyText} maxLength={300} rows={2} onChange={(e) => setReplyText(e.target.value)} />
              {!templates.update && (
                <p className="text-xs text-amber-700">The update template isn&apos;t approved yet. This will be saved but not sent; reply from WhatsApp.</p>
              )}
            </div>
          )}
          {error && <p className="text-xs text-red-600">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
            <Button size="sm" disabled={saving} onClick={submit}>
              {saving ? "Saving…" : decision === "task" ? "Create task" : decision === "enquiry" ? "Convert to enquiry" : decision === "done" ? "Mark done and tell customer" : "Save"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
