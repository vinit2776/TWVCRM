"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { BlockerList } from "@/components/cases/renewal-guidance";
import { lapseDecisionAfter, lapseDecisionBlockers } from "@/lib/vo-renewal-guidance";
import { FileText, Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ReportPaymentDialog } from "@/components/queries/report-payment-dialog";
import { formatCurrency, formatDate, cn } from "@/lib/utils";
import {
  LAPSE_DECISIONS,
  LAPSE_DECISION_LABELS,
  LAPSE_REASON_MIN_LENGTH,
  MAX_GRACE_EXTENSION_DAYS,
  type LapseDecision,
  type LapseDecisionRecord,
} from "@/lib/vo-lapse-decision";

interface LapseState {
  today: string;
  status: string;
  end_date: string | null;
  decidable: boolean;
  can_decide: boolean;
  grace_last_day: string | null;
  decisions: LapseDecisionRecord[];
  extensions_used: number;
  extensions_left: number;
  latest_grace_date: string;
  open_bill: { id: string; statement_number: string | null; total_amount: number; payment_status: string; reported: boolean } | null;
  documents: number;
  documents_sent: boolean;
}

interface DiscontinuationDoc {
  id: string;
  document_type: string;
  label: string;
  goes_to: string | null;
  how: "email" | "post";
  status: "draft" | "approved" | "dispatched";
  approved_by: string | null;
  approved_at: string | null;
  dispatched_at: string | null;
  postal_tracking_number: string | null;
  preview_url: string | null;
}

interface Discontinuation {
  status: string;
  client_email: string | null;
  effective_date: string | null;
  can_act: boolean;
  documents: DiscontinuationDoc[];
}

const HINTS: Record<LapseDecision, string> = {
  paid: "Then report the payment against the renewal bill, or start the renewal if there is no bill yet. Accounts verifies it before the new term begins.",
  more_time: `Keeps the case in grace until the date you choose, at most ${MAX_GRACE_EXTENSION_DAYS} days from today.`,
  discontinue: "Prepares the discontinuation documents for review. Nothing is sent until each one is approved.",
};

/**
 * The decision on a Virtual Office case whose term has ended unpaid, and,
 * once discontinuation is chosen, the review of its documents. Renders
 * nothing for a case that is still within its term.
 */
export function CaseLapsePanel({
  caseId,
  onStartRenewal,
  onChanged,
}: {
  caseId: string;
  onStartRenewal?: () => void;
  onChanged?: () => void;
}) {
  const [state, setState] = useState<LapseState | null>(null);
  const [loading, setLoading] = useState(true);
  const [choice, setChoice] = useState<LapseDecision | null>(null);
  const [reason, setReason] = useState("");
  const [until, setUntil] = useState("");
  const [saving, setSaving] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/cases/${caseId}/lapse-decision`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load");
      setState(json.data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load the lapsed-case decision");
    } finally {
      setLoading(false);
    }
  }, [caseId]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return null;
  if (!state || !state.decidable) return null;

  const latest = state.decisions.length ? state.decisions[state.decisions.length - 1] : null;
  const isLapsed = state.status === "lapsed";
  const discontinuing = isLapsed && latest?.decision === "discontinue";
  const reasonOk = reason.trim().length >= LAPSE_REASON_MIN_LENGTH;
  const untilOk = choice !== "more_time" || (!!until && until > state.today && until <= state.latest_grace_date);

  const blockers = lapseDecisionBlockers({
    decision: choice,
    reasonLength: reason.trim().length,
    until,
    today: state.today,
    latestGraceDate: state.latest_grace_date,
  });

  const available = (d: LapseDecision) => {
    if (d === "more_time" && state.extensions_left === 0) return false;
    if (d !== "discontinue" && state.documents_sent) return false;
    if (d === "discontinue" && discontinuing) return false;
    return true;
  };

  const submit = async () => {
    if (!choice) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/cases/${caseId}/lapse-decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: choice, reason: reason.trim(), ...(choice === "more_time" ? { until } : {}) }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to record the decision");
      toast.success(lapseDecisionAfter(choice, choice === "more_time" ? until : undefined));
      setChoice(null);
      setReason("");
      setUntil("");
      await load();
      onChanged?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to record the decision");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <Card className={cn(isLapsed ? "border-red-300" : "border-orange-300")}>
        <CardHeader>
          <CardTitle className="text-base">
            {isLapsed ? "Lapsed: decide what happens next" : "Term ended unpaid"}
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {state.end_date ? `Ended ${formatDate(state.end_date)}. ` : ""}
            {!isLapsed && state.grace_last_day
              ? `In grace until ${formatDate(state.grace_last_day)}.`
              : isLapsed
                ? "The grace period is over."
                : ""}
            {state.extensions_used > 0 &&
              ` More time given ${state.extensions_used} time${state.extensions_used === 1 ? "" : "s"} this term.`}
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {state.decisions.length > 0 && (
            <ul className="space-y-2">
              {state.decisions.map((d, i) => (
                <li key={i} className="rounded-md border p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">
                      {LAPSE_DECISION_LABELS[d.decision]}
                      {d.until ? `, until ${formatDate(d.until)}` : ""}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      Recorded by {d.by_name ?? "someone"} on {formatDate(d.at)}
                    </span>
                  </div>
                  <p className="mt-1 text-muted-foreground">{d.reason}</p>
                </li>
              ))}
            </ul>
          )}

          {latest?.decision === "paid" && (
            <div className="rounded-md border border-teal-300 bg-teal-50 p-3 text-sm space-y-2 dark:bg-teal-950/30">
              {state.open_bill ? (
                state.open_bill.reported ? (
                  <p>
                    A payment against {state.open_bill.statement_number ?? "the renewal bill"} is reported and waiting for
                    accounts to verify it. The new term starts once they do.
                  </p>
                ) : (
                  <>
                    <p>
                      Report the payment against {state.open_bill.statement_number ?? "the renewal bill"} (
                      {formatCurrency(state.open_bill.total_amount)}). Accounts verifies it and the new term starts then.
                    </p>
                    <Button size="sm" onClick={() => setReportOpen(true)}>Report paid</Button>
                  </>
                )
              ) : (
                <>
                  <p>There is no open renewal bill. Start the renewal to raise one, then report the payment against it.</p>
                  {onStartRenewal && (
                    <Button size="sm" onClick={onStartRenewal}>Start renewal</Button>
                  )}
                </>
              )}
            </div>
          )}

          {state.can_decide ? (
            <div className="space-y-3">
              <div className="grid gap-2 sm:grid-cols-3">
                {LAPSE_DECISIONS.map((d) => (
                  <button
                    key={d}
                    type="button"
                    disabled={!available(d)}
                    onClick={() => setChoice(d)}
                    className={cn(
                      "rounded-md border p-3 text-left text-sm transition-colors hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-50",
                      choice === d && "border-primary ring-1 ring-primary",
                    )}
                  >
                    <div className="font-medium">{LAPSE_DECISION_LABELS[d]}</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {d === "more_time" && state.extensions_left === 0
                        ? "Already given more time twice this term."
                        : HINTS[d]}
                    </div>
                  </button>
                ))}
              </div>

              {choice && (
                <div className="space-y-3">
                  {choice === "more_time" && (
                    <div className="space-y-1">
                      <Label htmlFor="grace-until">Keep in grace until</Label>
                      <Input
                        id="grace-until"
                        type="date"
                        className="w-48"
                        min={state.today}
                        max={state.latest_grace_date}
                        value={until}
                        onChange={(e) => setUntil(e.target.value)}
                      />
                    </div>
                  )}
                  <div className="space-y-1">
                    <Label htmlFor="lapse-reason">Reason</Label>
                    <Textarea
                      id="lapse-reason"
                      rows={2}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder="What did the client say, and who spoke to them?"
                    />
                    <p className="text-xs text-muted-foreground">
                      At least {LAPSE_REASON_MIN_LENGTH} characters. Saved to the case and the audit trail.
                    </p>
                  </div>
                  <BlockerList reasons={blockers} />
                  <div className="flex gap-2">
                    <Button onClick={submit} disabled={saving || !reasonOk || !untilOk}>
                      {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      Record decision
                    </Button>
                    <Button variant="ghost" onClick={() => setChoice(null)} disabled={saving}>
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">An admin or manager records the decision on this case.</p>
          )}
        </CardContent>
      </Card>

      {discontinuing && <DiscontinuationDocuments caseId={caseId} />}

      {state.open_bill && (
        <ReportPaymentDialog
          open={reportOpen}
          onOpenChange={setReportOpen}
          entityType="billing_statement"
          entityId={state.open_bill.id}
          partyLabel={state.open_bill.statement_number}
          suggestedAmount={state.open_bill.total_amount}
          defaultStatementId={state.open_bill.id}
          onReported={() => {
            load();
            onChanged?.();
          }}
        />
      )}
    </div>
  );
}

function DiscontinuationDocuments({ caseId }: { caseId: string }) {
  const [data, setData] = useState<Discontinuation | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [effective, setEffective] = useState("");
  const [postNumbers, setPostNumbers] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/cases/${caseId}/discontinuation`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load");
      setData(json.data);
      setEffective(json.data.effective_date ?? "");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load the discontinuation documents");
    }
  }, [caseId]);

  useEffect(() => {
    load();
  }, [load]);

  const act = async (key: string, body: Record<string, unknown>, success: string) => {
    setBusy(key);
    try {
      const res = await fetch(`/api/cases/${caseId}/discontinuation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed");
      toast.success(success);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(null);
    }
  };

  if (!data) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading discontinuation documents…
      </div>
    );
  }

  const allDraft = data.documents.every((d) => d.status === "draft");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Discontinuation documents</CardTitle>
        <div className="flex flex-wrap items-end gap-2 text-sm">
          <div className="space-y-1">
            <Label htmlFor="disc-effective">Effective date</Label>
            <Input
              id="disc-effective"
              type="date"
              className="w-44"
              value={effective}
              disabled={!data.can_act || !allDraft}
              onChange={(e) => setEffective(e.target.value)}
            />
          </div>
          {data.can_act && allDraft && effective && effective !== data.effective_date && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() => act("regenerate", { action: "regenerate", effective_date: effective }, "Documents prepared again with the new date")}
            >
              {busy === "regenerate" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Redo with this date
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {data.documents.length === 0 ? (
          <p className="text-sm text-muted-foreground">No documents have been prepared.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50 text-left">
                  <th className="px-3 py-2 font-medium">Document</th>
                  <th className="px-3 py-2 font-medium">Goes to</th>
                  <th className="px-3 py-2 font-medium">How</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {data.documents.map((d) => (
                  <tr key={d.id} className="border-b last:border-0 align-top">
                    <td className="px-3 py-2">
                      <div className="font-medium">{d.how === "post" ? "Authority letter" : d.label}</div>
                      {d.preview_url && (
                        <a
                          href={d.preview_url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                        >
                          <FileText className="h-3 w-3" /> Preview PDF
                        </a>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {d.how === "email" ? (
                        <>
                          <div>Client</div>
                          <div className="text-xs text-muted-foreground">{data.client_email ?? "No email on file"}</div>
                        </>
                      ) : (
                        d.goes_to
                      )}
                    </td>
                    <td className="px-3 py-2">{d.how === "email" ? "Email" : "Registered post"}</td>
                    <td className="px-3 py-2">
                      <Badge variant={d.status === "dispatched" ? "default" : "outline"}>
                        {d.status === "draft"
                          ? "Draft"
                          : d.status === "approved"
                            ? "Approved, to post"
                            : d.how === "email"
                              ? "Emailed"
                              : "Posted"}
                      </Badge>
                      {d.approved_by && (
                        <div className="mt-1 text-xs text-muted-foreground">
                          Approved by {d.approved_by}
                          {d.approved_at ? ` on ${formatDate(d.approved_at)}` : ""}
                        </div>
                      )}
                      {d.postal_tracking_number && (
                        <div className="text-xs text-muted-foreground">Post no. {d.postal_tracking_number}</div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {!data.can_act ? null : d.status === "draft" ? (
                        <Button
                          size="sm"
                          disabled={busy !== null || (d.how === "email" && !data.client_email)}
                          onClick={() =>
                            act(
                              d.id,
                              { action: "approve", document_id: d.id },
                              d.how === "email" ? `${d.label} approved and emailed` : `${d.label} approved`,
                            )
                          }
                        >
                          {busy === d.id && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                          {d.how === "email" ? "Approve and email" : "Approve"}
                        </Button>
                      ) : d.status === "approved" && d.how === "post" ? (
                        <div className="flex justify-end gap-2">
                          <Input
                            className="h-8 w-36"
                            placeholder="Post number"
                            value={postNumbers[d.id] ?? ""}
                            onChange={(e) => setPostNumbers((p) => ({ ...p, [d.id]: e.target.value }))}
                          />
                          <Button
                            size="sm"
                            disabled={busy !== null || (postNumbers[d.id] ?? "").trim().length < 4}
                            onClick={() =>
                              act(
                                d.id,
                                { action: "record_post", document_id: d.id, tracking_number: postNumbers[d.id].trim() },
                                "Post number recorded",
                              )
                            }
                          >
                            Add post number
                          </Button>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          Emails go only after approval. Letters to authorities are printed and posted by hand; record the
          registered-post number.
        </p>
      </CardContent>
    </Card>
  );
}
