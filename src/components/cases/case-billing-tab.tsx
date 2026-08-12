"use client";

import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, FileText, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import Link from "next/link";
import { formatCurrency } from "@/lib/utils";
import { HANDOFF_STATE_LABELS, type HandoffState } from "@/lib/tally-handoff";

interface CaseBillingTabProps {
  caseId: string;
}

interface CaseBillingInfo {
  case_source: "aggregator" | "direct";
  bill_to: "aggregator" | "client" | null;
  aggregator: { billing_method?: string } | null;
}

interface CaseStatement {
  id: string;
  statement_number: string | null;
  total_amount: number;
  payment_status: string;
  handoff_state: HandoffState | null;
  voided_at: string | null;
}

export function CaseBillingTab({ caseId }: CaseBillingTabProps) {
  const [caseInfo, setCaseInfo] = useState<CaseBillingInfo | null>(null);
  const [statement, setStatement] = useState<CaseStatement | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingBillTo, setSavingBillTo] = useState(false);
  const [generating, setGenerating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [caseRes, stmtRes] = await Promise.all([
        fetch(`/api/cases/${caseId}`).then((r) => r.json()),
        fetch(`/api/billing-statements?case_id=${caseId}&statement_type=vo_case&limit=1`).then((r) => r.json()),
      ]);
      setCaseInfo(caseRes.data ?? null);
      const rows = (stmtRes.data ?? []) as CaseStatement[];
      setStatement(rows.find((s) => !s.voided_at) ?? null);
    } catch {
      toast.error("Failed to load billing info");
    } finally {
      setLoading(false);
    }
  }, [caseId]);

  useEffect(() => {
    load();
  }, [load]);

  const eligible = caseInfo && (caseInfo.case_source === "direct" || caseInfo.aggregator?.billing_method === "prepaid");
  const needsBillTo = caseInfo?.case_source === "aggregator" && !caseInfo.bill_to;

  const handleBillToChange = async (value: string) => {
    setSavingBillTo(true);
    try {
      const res = await fetch(`/api/cases/${caseId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bill_to: value }),
      });
      if (!res.ok) throw new Error();
      setCaseInfo((prev) => (prev ? { ...prev, bill_to: value as "aggregator" | "client" } : prev));
      toast.success("Bill-to updated");
    } catch {
      toast.error("Failed to update bill-to");
    } finally {
      setSavingBillTo(false);
    }
  };

  const handleGenerateInvoice = async () => {
    setGenerating(true);
    try {
      const res = await fetch(`/api/cases/${caseId}/invoice`, { method: "POST" });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "Failed to generate invoice");
        return;
      }
      toast.success("Invoice generated — it now sits in the Tally Inbox for accounts to process");
      await load();
    } catch {
      toast.error("Failed to generate invoice");
    } finally {
      setGenerating(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="py-12 flex justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (!eligible) {
    return (
      <Card>
        <CardContent className="py-8 text-sm text-muted-foreground text-center">
          This case is billed via the aggregator&apos;s consolidated monthly invoice, not individually.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {caseInfo?.case_source === "aggregator" && (
        <Card>
          <CardContent className="py-4 space-y-2">
            <p className="text-sm font-medium">Bill To</p>
            <p className="text-xs text-muted-foreground">
              Who this case&apos;s invoice bills — varies case by case for prepaid aggregators.
            </p>
            <Select value={caseInfo.bill_to ?? undefined} onValueChange={handleBillToChange} disabled={savingBillTo || !!statement}>
              <SelectTrigger className="w-64">
                <SelectValue placeholder="Select bill-to" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="aggregator">Aggregator</SelectItem>
                <SelectItem value="client">End Client</SelectItem>
              </SelectContent>
            </Select>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="py-6">
          {!statement ? (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <FileText className="h-8 w-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">No invoice generated yet for this case.</p>
              <Button onClick={handleGenerateInvoice} disabled={generating || needsBillTo}>
                {generating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Generate Invoice
              </Button>
              {needsBillTo && (
                <p className="text-xs text-amber-600">Select who to bill before generating the invoice.</p>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-mono text-sm">{statement.statement_number ?? "—"}</p>
                  <p className="text-lg font-semibold">{formatCurrency(statement.total_amount)}</p>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <Badge variant={statement.payment_status === "paid" ? "default" : "outline"}>
                    {statement.payment_status === "paid" ? "Paid" : "Unpaid"}
                  </Badge>
                  {statement.handoff_state && (
                    <Badge variant="outline" className="text-xs">
                      {HANDOFF_STATE_LABELS[statement.handoff_state] ?? statement.handoff_state}
                    </Badge>
                  )}
                </div>
              </div>
              <Link
                href={`/accounting/inbox?id=${statement.id}`}
                className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
              >
                View in Tally Inbox <ExternalLink className="h-3.5 w-3.5" />
              </Link>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
