"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Lock, Clock, CheckCircle2, MessageSquareWarning, Plus, History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { formatDate } from "@/lib/utils";
import { canApproveSpecialClause, canAuthorSpecialClause, SPECIAL_CLAUSE_LABELS, type SpecialClauseStatus } from "@/lib/special-clause/gate";
import { SpecialClauseComposer, type VettedClause, type ClauseReport } from "./special-clause-composer";

interface Revision {
  id: string;
  revision: number;
  status: "pending_approval" | "approved" | "changes_requested" | "withdrawn" | "superseded";
  intent: string;
  reason: string;
  clause_text: string;
  ai_report: ClauseReport | null;
  submitted_at: string;
  decided_at: string | null;
  decision_note: string | null;
  required_changes: string | null;
  self_approved: boolean;
  carried_from_id: string | null;
  submitted_by_user?: { full_name: string } | null;
  decided_by_user?: { full_name: string } | null;
}

const BADGE_STYLE: Record<SpecialClauseStatus, string> = {
  pending_approval: "bg-amber-100 text-amber-800 border-amber-200",
  changes_requested: "bg-red-100 text-red-800 border-red-200",
  approved: "bg-green-100 text-green-800 border-green-200",
};

/** Small status badge for the contract header. */
export function SpecialClauseBadge({ status }: { status: string | null | undefined }) {
  if (!status || !(status in SPECIAL_CLAUSE_LABELS)) return null;
  const s = status as SpecialClauseStatus;
  return <Badge variant="secondary" className={BADGE_STYLE[s]}>{SPECIAL_CLAUSE_LABELS[s]}</Badge>;
}

interface Props {
  contractId: string;
  status: string | null | undefined;
  /** True once the agreement is out for signature or signed — no new clause then. */
  locked: boolean;
  userRole: string | null;
  facts: Record<string, string>;
  onChanged: () => void;
}

export function SpecialClauseCard({ contractId, status, locked, userRole, facts, onChanged }: Props) {
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [loading, setLoading] = useState(true);
  const [composing, setComposing] = useState(false);
  const [vetted, setVetted] = useState<VettedClause | null>(null);
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const [required, setRequired] = useState("");
  const [showHistory, setShowHistory] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/contracts/${contractId}/special-clause`);
    if (res.ok) setRevisions((await res.json()).data ?? []);
    setLoading(false);
  }, [contractId]);

  // Reload whenever the contract's clause status changes (page refetch after any action).
  useEffect(() => { load(); }, [load, status]);

  const current = revisions.find((r) => ["pending_approval", "approved", "changes_requested"].includes(r.status)) ?? null;
  const canAuthor = canAuthorSpecialClause(userRole);
  const canApprove = canApproveSpecialClause(userRole);

  async function post(path: string, body?: unknown) {
    setBusy(true);
    try {
      const res = await fetch(`/api/contracts/${contractId}/special-clause${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(json.error ?? "That didn't work. Try again."); return false; }
      return true;
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (!vetted) return;
    if (await post("", vetted)) {
      toast.success(canApprove ? "Clause approved" : "Clause sent for approval");
      setComposing(false); setVetted(null); onChanged(); load();
    }
  }
  async function decide(decision: "approve" | "request_changes") {
    if (!current) return;
    if (await post("/decision", { revision_id: current.id, decision, note: note || undefined, required_changes: required || undefined })) {
      toast.success(decision === "approve" ? "Clause approved" : "Changes requested");
      setRejecting(false); setNote(""); setRequired(""); onChanged(); load();
    }
  }
  async function withdraw() {
    if (await post("/withdraw")) { toast.success("Clause withdrawn"); onChanged(); load(); }
  }

  // Nothing to show: no clause, and this user can't or needn't add one.
  if (!loading && !current && !composing && (!canAuthor || locked)) return null;

  const feedback = current?.status === "changes_requested"
    ? [current.decision_note && `Why: ${current.decision_note}`, current.required_changes && `Fix: ${current.required_changes}`].filter(Boolean).join("\n")
    : undefined;

  return (
    <Card className={current && current.status !== "approved" ? "border-2 border-amber-300" : undefined}>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">Special clause</CardTitle>
          <SpecialClauseBadge status={current?.status} />
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}

        {!loading && !current && !composing && (
          <div className="space-y-2">
            <p className="text-muted-foreground">
              A paragraph that applies to this customer&apos;s contract only. It prints as Clause 37 and needs a manager or admin&apos;s approval before the agreement can go out.
            </p>
            <Button variant="outline" size="sm" onClick={() => setComposing(true)}><Plus className="mr-1.5 h-3.5 w-3.5" />Add special clause</Button>
          </div>
        )}

        {current && !composing && (
          <>
            <p className="text-xs text-muted-foreground">
              Revision {current.revision} · submitted by {current.submitted_by_user?.full_name ?? "someone"} on {formatDate(current.submitted_at)}
              {current.status === "approved" && current.decided_at && (
                <> · {current.self_approved ? "self-approved" : `approved by ${current.decided_by_user?.full_name ?? "a manager"}`} on {formatDate(current.decided_at)}</>
              )}
              {current.carried_from_id && <> · carried over on renewal</>}
            </p>

            {canApprove && current.status === "pending_approval" && (
              <div className="space-y-2 rounded-md bg-muted/40 p-3">
                <div><p className="text-xs text-muted-foreground">What was asked for</p><p className="whitespace-pre-wrap">{current.intent}</p></div>
                <div><p className="text-xs text-muted-foreground">Why (internal)</p><p className="whitespace-pre-wrap">{current.reason}</p></div>
              </div>
            )}

            <div>
              <p className="text-xs text-muted-foreground">{canApprove && current.status === "pending_approval" ? "Clause as it will print" : "Clause"}</p>
              <p className="whitespace-pre-wrap rounded-md border bg-muted/30 p-3 leading-relaxed">{current.clause_text}</p>
            </div>

            {current.ai_report && (current.status === "pending_approval" || current.status === "changes_requested") && (
              <div className="space-y-1 text-xs">
                {current.ai_report.added.length > 0 ? (
                  <p className="text-amber-700">Added by AI beyond the request: {current.ai_report.added.join("; ")}</p>
                ) : (
                  <p className="text-green-700">Nothing added beyond the request.</p>
                )}
                {current.ai_report.topics_checked.length > 0 && <p className="text-muted-foreground">Checked against: {current.ai_report.topics_checked.join(", ")}</p>}
              </div>
            )}

            {current.status === "pending_approval" && !canApprove && (
              <p className="flex items-center gap-1.5 text-xs text-amber-800"><Clock className="h-3.5 w-3.5" />Waiting for a manager or admin. Locked while pending.</p>
            )}
            {current.status === "approved" && (
              <p className="flex items-center gap-1.5 text-xs text-green-700"><CheckCircle2 className="h-3.5 w-3.5" />Prints as Clause 37 in the agreement.</p>
            )}

            {current.status === "changes_requested" && (
              <div className="rounded-md border border-red-200 bg-red-50 p-3 text-red-800">
                <p className="flex items-center gap-1.5 font-medium"><MessageSquareWarning className="h-4 w-4" />{current.decided_by_user?.full_name ?? "A manager"} asked for changes{current.decided_at ? ` · ${formatDate(current.decided_at)}` : ""}</p>
                <p className="mt-1"><span className="font-medium">Why:</span> {current.decision_note}</p>
                <p><span className="font-medium">Fix:</span> {current.required_changes}</p>
              </div>
            )}

            {current.status === "pending_approval" && canApprove && !rejecting && (
              <div className="flex gap-2">
                <Button size="sm" onClick={() => decide("approve")} disabled={busy}>{busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}Approve</Button>
                <Button size="sm" variant="outline" onClick={() => setRejecting(true)} disabled={busy}>Request changes</Button>
              </div>
            )}
            {rejecting && (
              <div className="space-y-2 rounded-md border p-3">
                <div className="space-y-1"><Label>Reason</Label><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why this can't go in as written" /></div>
                <div className="space-y-1"><Label>What needs to be corrected</Label><Textarea rows={2} value={required} onChange={(e) => setRequired(e.target.value)} placeholder="What the author should change" /></div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => decide("request_changes")} disabled={busy || note.trim().length < 10 || required.trim().length < 10}>Send back</Button>
                  <Button size="sm" variant="ghost" onClick={() => setRejecting(false)}>Cancel</Button>
                </div>
                <p className="text-xs text-muted-foreground">Both fields need at least 10 characters.</p>
              </div>
            )}

            {current.status === "pending_approval" && !locked && (
              <Button size="sm" variant="ghost" onClick={withdraw} disabled={busy}>Withdraw</Button>
            )}
            {(current.status === "changes_requested" || (current.status === "approved" && !locked)) && canAuthor && (
              <Button size="sm" variant={current.status === "changes_requested" ? "default" : "outline"} onClick={() => setComposing(true)}>
                {current.status === "changes_requested" ? "Revise and resubmit" : "Propose a change"}
              </Button>
            )}
            {current.status === "approved" && locked && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Lock className="h-3.5 w-3.5" />Locked — the agreement is out for signature or signed. Changes go through an addendum.</p>
            )}
          </>
        )}

        {composing && (
          <div className="space-y-3">
            <SpecialClauseComposer
              facts={facts}
              onChange={setVetted}
              selfApproves={canApprove}
              initialIntent={current?.status === "changes_requested" ? current.intent : ""}
              initialReason={current?.status === "changes_requested" ? current.reason : ""}
              feedback={feedback}
              previousText={current?.clause_text}
            />
            <div className="flex gap-2">
              <Button size="sm" onClick={submit} disabled={!vetted || busy}>
                {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                {canApprove ? "Save and approve" : "Submit for approval"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { setComposing(false); setVetted(null); }}>Cancel</Button>
            </div>
          </div>
        )}

        {revisions.length > 1 && (
          <div>
            <button type="button" className="flex items-center gap-1.5 text-xs text-muted-foreground hover:underline" onClick={() => setShowHistory((v) => !v)}>
              <History className="h-3.5 w-3.5" />{showHistory ? "Hide" : "View"} history ({revisions.length} revisions)
            </button>
            {showHistory && (
              <ul className="mt-2 space-y-2 text-xs">
                {revisions.map((r) => (
                  <li key={r.id} className="rounded-md border p-2">
                    <p className="font-medium">Revision {r.revision} · {r.status.replace("_", " ")} · {formatDate(r.submitted_at)}</p>
                    <p className="whitespace-pre-wrap text-muted-foreground">{r.clause_text}</p>
                    {r.decision_note && <p className="mt-1">Note: {r.decision_note}{r.required_changes ? ` — Fix: ${r.required_changes}` : ""}</p>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
