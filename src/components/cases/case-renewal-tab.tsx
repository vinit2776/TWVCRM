"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { STATEMENT_PAYMENT_MODE_LABELS } from "@/lib/constants";
import { formatDate, formatCurrency } from "@/lib/utils";
import { CaseLapsePanel } from "@/components/cases/case-lapse-panel";
import { CaseRemindersCard } from "@/components/cases/case-reminders-card";

interface Reminder {
  id: string;
  reminder_number: number;
  sent_at: string;
  email_sent: boolean;
  whatsapp_sent: boolean;
  is_grace_notice: boolean;
}

interface Bill {
  id: string;
  statement_number: string | null;
  period_start: string | null;
  period_end: string | null;
  total_amount: number;
  payment_status: string;
  created_at: string;
  voided_at: string | null;
}

interface Payment {
  id: string;
  statement_number: string | null;
  amount: number;
  payment_date: string | null;
  payment_mode: string | null;
  source: "razorpay_link" | "recorded";
  reference: string | null;
  recorded_by: string | null;
  reported_by: string | null;
  payer_name: string | null;
  recorded_at: string;
}

interface OpenReport {
  id: string;
  statement_number: string | null;
  amount: number;
  paid_on: string;
  payment_mode: string;
  reference: string | null;
  reported_by: string | null;
}

interface History {
  reminders: Reminder[];
  bills: Bill[];
  payments: Payment[];
  open_reports: OpenReport[];
}

const PAYMENT_STATUS_LABEL: Record<string, string> = {
  paid: "Paid",
  partially_paid: "Part paid",
  unpaid: "Unpaid",
};

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  );
}

/**
 * The case's renewal record: notices sent, renewal bills, and every payment
 * with its full provenance. Above it, for a term that has ended unpaid, the
 * decision on what happens next.
 */
export function CaseRenewalTab({
  caseId,
  onStartRenewal,
  onChanged,
}: {
  caseId: string;
  onStartRenewal?: () => void;
  onChanged?: () => void;
}) {
  const [history, setHistory] = useState<History | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/cases/${caseId}/renewal-history`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load renewal history");
      setHistory(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load renewal history");
    } finally {
      setLoading(false);
    }
  }, [caseId]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading renewal history…
      </div>
    );
  }
  if (error || !history) {
    return <p className="text-sm text-destructive py-4">{error ?? "No renewal history."}</p>;
  }

  const modeLabel = (m: string | null) => (m ? STATEMENT_PAYMENT_MODE_LABELS[m] ?? m : "—");

  return (
    <div className="space-y-6">
      <CaseLapsePanel caseId={caseId} onStartRenewal={onStartRenewal} onChanged={onChanged} />
      <CaseRemindersCard caseId={caseId} onChanged={onChanged} />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Renewal payments</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {history.open_reports.map((r) => (
              <div key={r.id} className="rounded-md border border-amber-300 bg-amber-50 p-3 space-y-1 dark:bg-amber-950/30">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Reported paid, waiting for accounts</span>
                  <Badge variant="outline">{formatCurrency(r.amount)}</Badge>
                </div>
                <Row label="Bill" value={r.statement_number ?? "—"} />
                <Row label="Paid on" value={formatDate(r.paid_on)} />
                <Row label="Mode" value={modeLabel(r.payment_mode)} />
                <Row label="Reference" value={r.reference ?? "—"} />
                <Row label="Reported by" value={r.reported_by ?? "—"} />
              </div>
            ))}
            {history.payments.length === 0 && history.open_reports.length === 0 ? (
              <p className="text-sm text-muted-foreground">No renewal payment received yet.</p>
            ) : (
              history.payments.map((p) => (
                <div key={p.id} className="rounded-md border p-3 space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">
                      {p.source === "razorpay_link" ? "Paid by payment link" : "Recorded payment"}
                    </span>
                    <Badge variant="outline">{formatCurrency(p.amount)}</Badge>
                  </div>
                  <Row label="Bill" value={p.statement_number ?? "—"} />
                  <Row label="Paid on" value={p.payment_date ? formatDate(p.payment_date) : "—"} />
                  <Row label="Source" value={modeLabel(p.payment_mode)} />
                  <Row label="Reference" value={p.reference ?? "—"} />
                  {p.payer_name && <Row label="Paid from" value={p.payer_name} />}
                  <Row label="Reported by" value={p.reported_by ?? "—"} />
                  <Row label="Recorded by" value={p.source === "razorpay_link" ? "Automatic (Razorpay)" : p.recorded_by ?? "—"} />
                  <Row label="Recorded on" value={formatDate(p.recorded_at)} />
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Renewal bills</CardTitle>
            </CardHeader>
            <CardContent>
              {history.bills.length === 0 ? (
                <p className="text-sm text-muted-foreground">No renewal bill has been issued.</p>
              ) : (
                <ul className="divide-y text-sm">
                  {history.bills.map((b) => (
                    <li key={b.id} className="flex items-center justify-between gap-3 py-2">
                      <div>
                        <div className="font-medium">{b.statement_number ?? "—"}</div>
                        <div className="text-xs text-muted-foreground">
                          {b.period_start && b.period_end
                            ? `${formatDate(b.period_start)} to ${formatDate(b.period_end)}`
                            : "—"}
                          {" · issued "}
                          {formatDate(b.created_at)}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="tabular-nums">{formatCurrency(b.total_amount)}</div>
                        <Badge variant={b.payment_status === "paid" ? "default" : "outline"}>
                          {b.voided_at ? "Voided" : PAYMENT_STATUS_LABEL[b.payment_status] ?? b.payment_status}
                        </Badge>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Notices sent</CardTitle>
            </CardHeader>
            <CardContent>
              {history.reminders.length === 0 ? (
                <p className="text-sm text-muted-foreground">No renewal notice has been sent.</p>
              ) : (
                <ul className="divide-y text-sm">
                  {history.reminders.map((r) => (
                    <li key={r.id} className="flex items-center justify-between gap-3 py-2">
                      <div>
                        <div className="font-medium">
                          {r.is_grace_notice ? "Grace notice" : r.reminder_number === 1 ? "Renewal notice" : `Reminder ${r.reminder_number - 1}`}
                        </div>
                        <div className="text-xs text-muted-foreground">{formatDate(r.sent_at)}</div>
                      </div>
                      <div className="flex gap-1">
                        {r.email_sent && <Badge variant="outline">Email</Badge>}
                        {r.whatsapp_sent && <Badge variant="outline">WhatsApp</Badge>}
                        {!r.email_sent && !r.whatsapp_sent && <Badge variant="outline">Not delivered</Badge>}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
