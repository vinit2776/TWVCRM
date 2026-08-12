"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Loader2, AlertTriangle, FileCheck, Zap, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import Link from "next/link";
import { MONTH_NAMES, VO_PURPOSE_LABELS } from "@/lib/constants";
import { formatCurrency } from "@/lib/utils";
import { HANDOFF_STATE_LABELS, type HandoffState } from "@/lib/tally-handoff";

interface ReferralCase {
  id: string;
  case_number: string;
  client_name: string;
  purpose: string;
  rate: number | null;
}

interface BilledReferral extends ReferralCase {
  amount: number;
  statement: {
    id: string;
    statement_number: string | null;
    handoff_state: HandoffState | null;
    payment_status: string;
  };
}

interface AggregatorBillingTabProps {
  aggregatorId: string;
  creditLimit?: number;
  billingMode?: "proforma_first" | "gst_direct" | null;
  billingMethod?: "postpaid" | "prepaid";
}

export function AggregatorBillingTab({ aggregatorId, creditLimit, billingMode, billingMethod }: AggregatorBillingTabProps) {
  // Prepaid aggregators bill per-case from the case's own Billing tab
  // (src/lib/case-invoicing.ts) — this tab's Referrals list only applies to
  // postpaid's bundled monthly billing. Prepaid aggregators still need this
  // tab for the Proforma/GST-Direct toggle above, just not the rest.
  const isPostpaid = billingMethod !== "prepaid";
  const [pending, setPending] = useState<ReferralCase[]>([]);
  const [billed, setBilled] = useState<BilledReferral[]>([]);
  const [loading, setLoading] = useState(true);

  // Proforma-vs-GST-Direct billing mode — same toggle pattern as
  // src/components/contracts/contract-invoices-section.tsx. Takes effect
  // from the next invoice only, never retroactive.
  const [currentMode, setCurrentMode] = useState<"proforma_first" | "gst_direct">(billingMode || "gst_direct");
  const [savingMode, setSavingMode] = useState(false);

  useEffect(() => {
    setCurrentMode(billingMode || "gst_direct");
  }, [billingMode]);

  const handleModeChange = async (newMode: "proforma_first" | "gst_direct") => {
    if (newMode === currentMode) return;
    setSavingMode(true);
    try {
      const res = await fetch(`/api/aggregators/${aggregatorId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ billing_mode: newMode }),
      });
      if (res.ok) {
        setCurrentMode(newMode);
        toast.success(newMode === "gst_direct" ? "GST Direct billing enabled from next invoice" : "Proforma First billing enabled from next invoice");
      } else {
        const err = await res.json().catch(() => null);
        toast.error(err?.error || "Failed to update billing mode");
      }
    } catch {
      toast.error("Failed to update billing mode");
    } finally {
      setSavingMode(false);
    }
  };

  const now = new Date();
  const [genMonth, setGenMonth] = useState(String(now.getMonth() + 1));
  const [genYear, setGenYear] = useState(String(now.getFullYear()));
  const [generating, setGenerating] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Selection defaults to "bill all" — every pending case starts checked;
  // unchecking one carves it out as a one-off exception for this invoice
  // (it stays in the pending pool for next time).
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/aggregators/${aggregatorId}/billing-reconciliation`);
      if (res.ok) {
        const json = await res.json();
        setPending(json.data?.pending || []);
        setBilled(json.data?.billed || []);
      }
    } finally {
      setLoading(false);
    }
  }, [aggregatorId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    setSelectedIds(new Set(pending.map((c) => c.id)));
  }, [pending]);

  const toggleCase = (caseId: string, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(caseId);
      else next.delete(caseId);
      return next;
    });
  };

  const allSelected = pending.length > 0 && selectedIds.size === pending.length;
  const selectedSum = pending
    .filter((c) => selectedIds.has(c.id))
    .reduce((sum, c) => sum + (c.rate || 0), 0);
  const pendingSum = pending.reduce((sum, c) => sum + (c.rate || 0), 0);

  // Outstanding = unpaid invoiced amount + everything still pending — the
  // credit-limit check needs the full exposure, not just what's on an
  // already-sent invoice.
  const unpaidBilledSum = useMemo(
    () => billed.filter((c) => c.statement.payment_status !== "paid").reduce((sum, c) => sum + c.amount, 0),
    [billed],
  );
  const outstanding = unpaidBilledSum + pendingSum;
  const overLimit = creditLimit != null && creditLimit > 0 && outstanding >= creditLimit;

  const handleOpenConfirm = () => {
    if (selectedIds.size === 0) {
      toast.error("Select at least one referral to invoice.");
      return;
    }
    setConfirmOpen(true);
  };

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const res = await fetch("/api/aggregator-invoices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          aggregator_id: aggregatorId,
          period_month: parseInt(genMonth),
          period_year: parseInt(genYear),
          case_ids: Array.from(selectedIds),
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to generate invoice");
      }
      toast.success(`Invoice generated for ${selectedIds.size} referral(s)`);
      setConfirmOpen(false);
      fetchData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to generate invoice");
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Billing mode toggle */}
      <div className="rounded-md border p-4">
        <p className="text-xs text-muted-foreground mb-2 font-medium">Invoice Type (from next invoice)</p>
        <div className="flex gap-2">
          <button
            onClick={() => handleModeChange("proforma_first")}
            disabled={savingMode}
            className={`flex-1 flex items-center justify-center gap-1.5 rounded-md border px-3 py-2 text-xs font-medium transition-colors ${
              currentMode === "proforma_first"
                ? "bg-[#015E65] text-white border-[#015E65]"
                : "bg-background text-muted-foreground border-border hover:bg-muted/30"
            }`}
          >
            <FileCheck className="h-3.5 w-3.5 shrink-0" />
            Proforma First
          </button>
          <button
            onClick={() => handleModeChange("gst_direct")}
            disabled={savingMode}
            className={`flex-1 flex items-center justify-center gap-1.5 rounded-md border px-3 py-2 text-xs font-medium transition-colors ${
              currentMode === "gst_direct"
                ? "bg-violet-700 text-white border-violet-700"
                : "bg-background text-muted-foreground border-border hover:bg-muted/30"
            }`}
          >
            <Zap className="h-3.5 w-3.5 shrink-0" />
            GST Direct
          </button>
        </div>
        {currentMode === "gst_direct" && (
          <p className="text-[10px] text-violet-700 mt-1.5">
            Tax invoice issued directly · Accountant creates it in Tally, then the customer is billed · No proforma
          </p>
        )}
        {currentMode === "proforma_first" && (
          <p className="text-[10px] text-[#015E65] mt-1.5">
            Proforma invoice sent immediately with a payment link · Real GST invoice issued once paid
          </p>
        )}
      </div>

      {isPostpaid && (
      <>
      {loading ? (
        <div className="text-center py-8 text-muted-foreground text-sm">Loading...</div>
      ) : (
        <>
          <div className="rounded-md border p-4">
            <p className="text-xs text-muted-foreground">Outstanding (unpaid invoices + pending referrals)</p>
            <p className="text-2xl font-semibold mt-1">{formatCurrency(outstanding)}</p>
            {overLimit && (
              <div className="flex items-center gap-1.5 text-xs text-amber-700 mt-2">
                <AlertTriangle className="h-3.5 w-3.5" />
                Over credit limit ({formatCurrency(creditLimit!)})
              </div>
            )}
          </div>

          {/* Pending referrals */}
          <div className="rounded-md border">
            <div className="flex flex-wrap items-center justify-between gap-3 p-4 border-b bg-muted/30">
              <div>
                <h3 className="text-sm font-medium">Pending Referrals ({pending.length})</h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {selectedIds.size} selected · {formatCurrency(selectedSum)} of {formatCurrency(pendingSum)}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Select value={genMonth} onValueChange={setGenMonth}>
                  <SelectTrigger className="w-32 h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MONTH_NAMES.map((label, idx) => (
                      <SelectItem key={label} value={String(idx + 1)}>{label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  type="number"
                  value={genYear}
                  onChange={(e) => setGenYear(e.target.value)}
                  className="w-20 h-8 text-xs"
                />
                <Button size="sm" onClick={handleOpenConfirm} disabled={generating || selectedIds.size === 0}>
                  Invoice Selected ({selectedIds.size})
                </Button>
              </div>
            </div>

            {pending.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground text-sm">No pending referrals to bill.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/50">
                      <th className="px-4 py-2 text-left">
                        <Checkbox
                          checked={allSelected}
                          onCheckedChange={(checked) =>
                            setSelectedIds(checked ? new Set(pending.map((c) => c.id)) : new Set())
                          }
                        />
                      </th>
                      <th className="px-4 py-2 text-left font-medium">Case</th>
                      <th className="px-4 py-2 text-left font-medium">Client</th>
                      <th className="px-4 py-2 text-left font-medium">Purpose</th>
                      <th className="px-4 py-2 text-right font-medium">Rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pending.map((c) => (
                      <tr key={c.id} className="border-b last:border-0">
                        <td className="px-4 py-2">
                          <Checkbox
                            checked={selectedIds.has(c.id)}
                            onCheckedChange={(checked) => toggleCase(c.id, checked === true)}
                          />
                        </td>
                        <td className="px-4 py-2 font-mono text-xs">{c.case_number}</td>
                        <td className="px-4 py-2">{c.client_name}</td>
                        <td className="px-4 py-2 text-muted-foreground">{VO_PURPOSE_LABELS[c.purpose] ?? c.purpose}</td>
                        <td className="px-4 py-2 text-right font-medium">{formatCurrency(c.rate || 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Billed referrals */}
          <div className="rounded-md border">
            <div className="p-4 border-b bg-muted/30">
              <h3 className="text-sm font-medium">Invoiced Referrals ({billed.length})</h3>
            </div>
            {billed.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground text-sm">No referrals invoiced yet.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/50">
                      <th className="px-4 py-2 text-left font-medium">Case</th>
                      <th className="px-4 py-2 text-left font-medium">Client</th>
                      <th className="px-4 py-2 text-left font-medium">Statement</th>
                      <th className="px-4 py-2 text-left font-medium">Status</th>
                      <th className="px-4 py-2 text-right font-medium">Amount</th>
                      <th className="px-4 py-2 text-left font-medium"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {billed.map((c) => (
                      <tr key={c.id} className="border-b last:border-0">
                        <td className="px-4 py-2 font-mono text-xs">{c.case_number}</td>
                        <td className="px-4 py-2">{c.client_name}</td>
                        <td className="px-4 py-2 font-mono text-xs">{c.statement.statement_number ?? "—"}</td>
                        <td className="px-4 py-2">
                          <div className="flex flex-col items-start gap-1">
                            <Badge variant={c.statement.payment_status === "paid" ? "default" : "outline"}>
                              {c.statement.payment_status === "paid" ? "Paid" : "Unpaid"}
                            </Badge>
                            {c.statement.handoff_state && (
                              <Badge variant="outline" className="text-xs">
                                {HANDOFF_STATE_LABELS[c.statement.handoff_state] ?? c.statement.handoff_state}
                              </Badge>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-2 text-right font-medium">{formatCurrency(c.amount)}</td>
                        <td className="px-4 py-2">
                          {c.statement.handoff_state ? (
                            <Link
                              href={`/accounting/inbox?id=${c.statement.id}`}
                              className="inline-flex items-center gap-1 text-xs text-primary hover:underline whitespace-nowrap"
                            >
                              View in Tally Inbox <ExternalLink className="h-3 w-3" />
                            </Link>
                          ) : (
                            <span className="text-xs text-muted-foreground whitespace-nowrap">Awaiting payment</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
      </>
      )}

      {/* Confirm before dispatching — this is a real, customer-facing action */}
      <Dialog open={confirmOpen} onOpenChange={(open) => !generating && setConfirmOpen(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Generate invoice for {selectedIds.size} referral(s)?</DialogTitle>
            <DialogDescription>
              {MONTH_NAMES[parseInt(genMonth) - 1]} {genYear} · {formatCurrency(selectedSum)} subtotal
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md border divide-y text-sm max-h-48 overflow-y-auto">
            {pending
              .filter((c) => selectedIds.has(c.id))
              .map((c) => (
                <div key={c.id} className="flex items-center justify-between px-3 py-2">
                  <span>{c.case_number} — {c.client_name}</span>
                  <span className="font-medium">{formatCurrency(c.rate || 0)}</span>
                </div>
              ))}
          </div>
          <p className="text-xs text-muted-foreground">
            {currentMode === "proforma_first"
              ? "A proforma invoice will be generated and a payment link will be emailed to the aggregator immediately."
              : "No invoice or payment link goes out yet — this queues in the Tally Inbox until an accountant issues the real GST invoice."}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={generating}>Cancel</Button>
            <Button onClick={handleGenerate} disabled={generating}>
              {generating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Confirm & Generate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
