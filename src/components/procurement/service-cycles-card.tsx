"use client";

import Link from "next/link";
import { CheckCircle2, ClipboardList, Receipt, Paperclip, Info, Lock, Pencil } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency, formatDate } from "@/lib/utils";
import { CYCLE_UNIT_LABEL, serviceNextStep } from "@/lib/procurement/amc-billing";
import type { ServicePoBillingCycle } from "@/lib/constants";
import type { PoServiceReport } from "@/types";

export interface CycleBill {
  id: string;
  bill_number: string;
  total_amount: number;
  approval_status: string;
  payment_status: string;
  service_report_id?: string | null;
}

interface Props {
  status: string;
  terminated: boolean;
  billingCycle: ServicePoBillingCycle | null;
  cycleCount: number | null;
  unitCostPerCycle: number | null;
  reports: PoServiceReport[];
  bills: CycleBill[];
  onRecordReport: () => void;
  onUploadInvoice: () => void;
  onEditInvoice: (billId: string) => void;
}

const APPROVAL_BADGE: Record<string, { label: string; cls: string }> = {
  approved: { label: "Approved", cls: "bg-green-100 text-green-800" },
  rejected: { label: "Rejected", cls: "bg-red-100 text-red-800" },
  pending: { label: "Awaiting approval", cls: "bg-yellow-100 text-yellow-800" },
};

const PAYMENT_LABEL: Record<string, string> = {
  paid: "Paid",
  partially_paid: "Part paid",
  unpaid: "Unpaid",
};

/**
 * One place to run a service / AMC contract's billing: a banner naming the next
 * action, and a row per cycle showing its report, invoice and payment together.
 * Replaces a flat activity list in which a rejected-then-resubmitted invoice read
 * as several invoices on the same contract.
 */
export function ServiceCyclesCard({
  status, terminated, billingCycle, cycleCount, unitCostPerCycle,
  reports, bills, onRecordReport, onUploadInvoice, onEditInvoice,
}: Props) {
  const unit = billingCycle ? CYCLE_UNIT_LABEL[billingCycle] : "cycle";
  const Unit = unit.charAt(0).toUpperCase() + unit.slice(1);
  const total = cycleCount ?? 0;
  const sorted = [...reports].sort((a, b) => a.cycle_number - b.cycle_number);
  const billFor = (srId: string) => bills.find((b) => b.service_report_id === srId);

  const next = serviceNextStep({
    status, terminated,
    reportsFiled: reports.length,
    invoicesFiled: bills.length,
    cycleCount,
  });

  // One more placeholder row for the cycle after the last report, so the user
  // can see what is coming and why its invoice is locked.
  const upcomingCycle = sorted.length + 1;
  const showUpcoming = total === 0 || upcomingCycle <= total;
  const awaiting = bills.filter((b) => b.approval_status === "pending");

  const banner = (() => {
    switch (next.kind) {
      case "not_ordered":
        return { title: "Mark this PO as ordered to start billing", body: "Service reports and invoices open once the PO is ordered.", action: null };
      case "closed":
        return { title: "This purchase order is closed", body: "No further reports or invoices can be added.", action: null };
      case "terminated":
        return { title: "This contract was terminated", body: "No further reports or invoices can be added.", action: null };
      case "log_report":
        return {
          title: `Next step: record the service report for ${unit} ${next.cycle}${total > 1 ? ` of ${total}` : ""}`,
          body: "Upload the vendor's service report first. The invoice for this cycle unlocks after it.",
          action: (
            <Button size="sm" className="bg-teal-600 hover:bg-teal-700" onClick={onRecordReport}>
              <ClipboardList className="h-4 w-4 mr-1" /> Record service report
            </Button>
          ),
        };
      case "upload_invoice":
        return {
          title: `Next step: upload the invoice for ${unit} ${next.cycle}${total > 1 ? ` of ${total}` : ""}`,
          body: `The service report is in. Upload the vendor invoice${unitCostPerCycle ? ` — up to ${formatCurrency(unitCostPerCycle)} for this ${unit}` : ""}.`,
          action: (
            <Button size="sm" onClick={onUploadInvoice}>
              <Receipt className="h-4 w-4 mr-1" /> Upload invoice
            </Button>
          ),
        };
      case "all_billed":
        return {
          title: total > 0 ? `All ${total} ${unit}${total > 1 ? "s" : ""} are invoiced` : "All cycles are invoiced",
          body: awaiting.length
            ? `${awaiting.map((b) => b.bill_number).join(", ")} ${awaiting.length > 1 ? "are" : "is"} waiting for approval.`
            : "Nothing left to upload. Payment is handled in Finance › Acc Payables.",
          action: null,
        };
    }
  })();

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <ClipboardList className="h-4 w-4 text-muted-foreground" />
          <CardTitle className="text-base">Billing by {unit}</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-lg border-2 border-blue-200 bg-blue-50/60 px-4 py-3 flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-blue-900">{banner.title}</p>
            <p className="text-xs text-blue-800/80 mt-0.5">{banner.body}</p>
          </div>
          {banner.action}
        </div>

        <div className="rounded-md border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-3 py-2.5 text-left font-medium">{Unit}</th>
                <th className="px-3 py-2.5 text-left font-medium">Service report</th>
                <th className="px-3 py-2.5 text-left font-medium">Invoice</th>
                <th className="px-3 py-2.5 text-left font-medium">Payment</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((sr) => {
                const bill = billFor(sr.id);
                const approval = bill ? APPROVAL_BADGE[bill.approval_status] ?? APPROVAL_BADGE.pending : null;
                return (
                  <tr key={sr.id} className="border-b align-top">
                    <td className="px-3 py-2.5">
                      <p className="font-medium">{Unit} {sr.cycle_number}</p>
                      <p className="text-xs text-muted-foreground">{formatDate(sr.period_from)} – {formatDate(sr.period_to)}</p>
                    </td>
                    <td className="px-3 py-2.5">
                      {sr.report_file_url ? (
                        <a href={sr.report_file_url} target="_blank" rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                          <Paperclip className="h-3 w-3" /> View report
                        </a>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs text-green-700">
                          <CheckCircle2 className="h-3.5 w-3.5" /> Recorded
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      {bill && approval ? (
                        <div className="space-y-1">
                          <Link href={`/procurement/bills/${bill.id}`} className="font-mono text-xs text-primary hover:underline">
                            {bill.bill_number}
                          </Link>
                          <p className="text-xs text-muted-foreground">{formatCurrency(bill.total_amount)}</p>
                          <div className="flex items-center gap-2">
                            <Badge variant="secondary" className={`text-[10px] ${approval.cls}`}>{approval.label}</Badge>
                            {bill.approval_status !== "approved" && (
                              <button
                                type="button"
                                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                                onClick={() => onEditInvoice(bill.id)}
                              >
                                <Pencil className="h-3 w-3" />
                                {bill.approval_status === "rejected" ? "Correct and resubmit" : "Edit"}
                              </button>
                            )}
                          </div>
                        </div>
                      ) : (
                        <span className="text-xs text-amber-700">Invoice due</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-xs">
                      {bill && bill.approval_status === "approved"
                        ? PAYMENT_LABEL[bill.payment_status] ?? bill.payment_status
                        : <span className="text-muted-foreground">—</span>}
                    </td>
                  </tr>
                );
              })}
              {showUpcoming && !terminated && (
                <tr className="text-muted-foreground">
                  <td className="px-3 py-2.5">
                    <p className="font-medium">{Unit} {upcomingCycle}</p>
                  </td>
                  <td className="px-3 py-2.5 text-xs">{next.kind === "log_report" ? "Due" : "Not yet due"}</td>
                  <td className="px-3 py-2.5 text-xs">
                    <span className="inline-flex items-center gap-1"><Lock className="h-3 w-3" /> After the report</span>
                  </td>
                  <td className="px-3 py-2.5 text-xs">—</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          One invoice per {unit}. A rejected invoice is corrected on its own row rather than uploaded again.
        </p>
      </CardContent>
    </Card>
  );
}
