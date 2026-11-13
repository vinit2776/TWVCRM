"use client";

import Link from "next/link";
import { ExternalLink, ShieldCheck, AlertTriangle, ChevronDown } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency, formatDate } from "@/lib/utils";
import { BILLING_CYCLE_LABELS, type ServicePoBillingCycle } from "@/lib/constants";
import { CYCLE_UNIT_LABEL } from "@/lib/procurement/amc-billing";
import { cycleSchedule } from "@/lib/procurement/amc-running";

export interface BillAmcPo {
  id: string;
  po_number: string;
  billing_cycle: ServicePoBillingCycle | null;
  cycle_count: number | null;
  unit_cost_per_cycle: number | null;
  opening_cycles?: number | null;
  amc_coverage_type?: string | null;
  amc_start_date?: string | null;
  amc_end_date?: string | null;
  amc_visits_covered?: number | null;
  amc_status?: string | null;
  amc_terminated_at?: string | null;
  amc_termination_reason?: string | null;
  amc_contact_name?: string | null;
  amc_helpline_number?: string | null;
  amc_contact_email?: string | null;
  purchase_order_items?: Array<{
    id: string; item_name: string;
    linked_asset?: { id: string; name: string; asset_code: string | null; serial_number: string | null; make: string | null; model: string | null; location: { name: string } | null } | null;
  }>;
}

export interface BillAmcBill {
  id: string;
  bill_number: string;
  total_amount: number;
  approval_status: string;
  payment_status: string;
  service_report_id?: string | null;
}

interface Props {
  po: BillAmcPo;
  /** The bill being approved. */
  thisBill: { id: string; total_amount: number; service_report_id?: string | null };
  bills: BillAmcBill[];
  reports: Array<{ id: string; cycle_number: number; period_from: string; period_to: string; signed_url: string | null }>;
  visitsLogged: number;
}

const Fact = ({ k, children }: { k: string; children: React.ReactNode }) => (
  <div>
    <p className="text-xs text-muted-foreground">{k}</p>
    <div className="text-sm font-medium">{children}</div>
  </div>
);

/**
 * What the approver needs to see about the AMC before approving one of its invoices: who and what it covers,
 * how far along it is, and whether this bill matches the cycle and the agreed rate. Read-only; the full contract is one click away.
 */
export function BillAmcPanel({ po, thisBill, bills, reports, visitsLogged }: Props) {
  const cycle = po.billing_cycle;
  const unit = cycle ? CYCLE_UNIT_LABEL[cycle] : "cycle";
  const opening = po.opening_cycles ?? 0;
  const total = (po.cycle_count ?? 0) + opening;
  const perCycle = po.unit_cost_per_cycle ?? null;
  const schedule = po.amc_start_date && po.amc_end_date && cycle ? cycleSchedule(po.amc_start_date, po.amc_end_date, cycle) : [];
  const assets = (po.purchase_order_items ?? []).map((i) => i.linked_asset).filter((a): a is NonNullable<typeof a> => !!a);
  const reportOfThisBill = thisBill.service_report_id ? reports.find((r) => r.id === thisBill.service_report_id) : null;
  const billCycle = reportOfThisBill?.cycle_number ?? null;
  const serviced = opening + reports.length;
  const invoiced = opening + bills.filter((b) => b.service_report_id).length;
  const paid = opening + bills.filter((b) => b.service_report_id && b.payment_status === "paid").length;
  const amountOff = perCycle != null && Math.abs(Number(thisBill.total_amount) - perCycle) > 1;
  const reportFor = (n: number) => reports.find((r) => r.cycle_number === n);
  const billFor = (reportId: string | undefined) => (reportId ? bills.find((b) => b.service_report_id === reportId) : undefined);

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-muted-foreground" />
            AMC contract
          </CardTitle>
          <Link href={`/procurement/orders/${po.id}`} target="_blank" className="text-xs text-primary flex items-center gap-1 hover:underline">
            Open the full contract ({po.po_number}) <ExternalLink className="h-3 w-3" />
          </Link>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {po.amc_terminated_at && (
          <div className="flex gap-2 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <div>
              <p className="font-medium">This AMC was terminated on {formatDate(po.amc_terminated_at)}.</p>
              {po.amc_termination_reason && <p className="text-xs">{po.amc_termination_reason}</p>}
              <p className="text-xs">Check this invoice is for work done before termination. If not, reject it above.</p>
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <Fact k="Period">{po.amc_start_date && po.amc_end_date ? `${formatDate(po.amc_start_date)} – ${formatDate(po.amc_end_date)}` : "—"}</Fact>
          <Fact k="Covers">{po.amc_coverage_type === "labour_only" ? "Labour only" : po.amc_coverage_type === "comprehensive" ? "Labour + parts" : "—"}</Fact>
          <Fact k="Billing">{cycle ? BILLING_CYCLE_LABELS[cycle] : "—"}{perCycle != null && ` · ${formatCurrency(perCycle)} each`}</Fact>
          <Fact k="Cycles">{serviced} serviced · {invoiced} invoiced · {paid} paid · of {total}</Fact>
          <Fact k="Visits">{visitsLogged}{po.amc_visits_covered != null ? ` of ${po.amc_visits_covered}` : ""} logged</Fact>
          <Fact k="Contract value">{perCycle != null && total > 0 ? `${formatCurrency(perCycle * total)} before GST` : "—"}</Fact>
        </div>

        {assets.length > 0 && (
          <div>
            <p className="text-xs text-muted-foreground mb-1">Assets covered</p>
            <ul className="space-y-1">
              {assets.map((a) => (
                <li key={a.id} className="text-sm flex flex-wrap items-center gap-x-2">
                  <Link href={`/facility/assets/${a.id}`} target="_blank" className="font-medium text-primary hover:underline">{a.name}{a.asset_code ? ` (${a.asset_code})` : ""}</Link>
                  <span className="text-xs text-muted-foreground">
                    {[a.make, a.model].filter(Boolean).join(" ")}{a.serial_number ? ` · Serial ${a.serial_number}` : ""}{a.location ? ` · ${a.location.name}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className={`rounded-md border px-3 py-2 text-sm ${amountOff ? "border-amber-300 bg-amber-50 text-amber-900" : "bg-muted/30"}`}>
          <p>
            <span className="font-medium">This invoice:</span>{" "}
            {billCycle ? `${unit} ${billCycle} of ${total}` : "not tied to a service report yet"} · {formatCurrency(Number(thisBill.total_amount))} before GST
            {perCycle != null && <> · agreed {formatCurrency(perCycle)} per {unit}</>}
          </p>
          {amountOff && <p className="text-xs mt-0.5">The amount is not the agreed rate. Use Correct amount / Edit invoice if the invoice is wrong, or Reject it, before approving.</p>}
          {!billCycle && <p className="text-xs mt-0.5">A bill is meant to follow a recorded service report. Tie it to one from the contract before approving.</p>}
        </div>

        <details className="group rounded-md border">
          <summary className="flex cursor-pointer items-center justify-between px-3 py-2 text-sm font-medium">
            Deep dive: every {unit} and its bill
            <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" />
          </summary>
          <div className="border-t overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-1.5 font-medium">{unit}</th>
                  <th className="px-3 py-1.5 font-medium">Dates</th>
                  <th className="px-3 py-1.5 font-medium">Service report</th>
                  <th className="px-3 py-1.5 font-medium">Invoice</th>
                  <th className="px-3 py-1.5 font-medium">Payment</th>
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: Math.max(total, schedule.length) }, (_, i) => i + 1).map((n) => {
                  const span = schedule.find((c) => c.n === n);
                  const rep = reportFor(n);
                  const b = billFor(rep?.id);
                  const settled = n <= opening;
                  const current = b?.id === thisBill.id;
                  return (
                    <tr key={n} className={`border-t ${current ? "bg-blue-50" : ""}`}>
                      <td className="px-3 py-1.5 font-medium">{n}{current && <span className="ml-1 text-[10px] text-blue-800">this bill</span>}</td>
                      <td className="px-3 py-1.5 text-muted-foreground whitespace-nowrap">{span ? `${formatDate(span.from)} – ${formatDate(span.to)}` : "—"}</td>
                      <td className="px-3 py-1.5">
                        {settled ? <span className="text-muted-foreground">Done before this system</span>
                          : rep ? (rep.signed_url ? <a href={rep.signed_url} target="_blank" rel="noreferrer" className="text-primary hover:underline">Report · {formatDate(rep.period_to)}</a> : `Recorded · ${formatDate(rep.period_to)}`)
                          : <span className="text-muted-foreground">Not recorded</span>}
                      </td>
                      <td className="px-3 py-1.5">
                        {settled ? "—" : b ? <Link href={`/procurement/bills/${b.id}`} className="text-primary hover:underline">{b.bill_number} · {formatCurrency(Number(b.total_amount))}</Link> : <span className="text-muted-foreground">None</span>}
                      </td>
                      <td className="px-3 py-1.5">{settled ? "Paid" : b ? (b.payment_status === "paid" ? "Paid" : "Not paid") : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {(po.amc_contact_name || po.amc_helpline_number || po.amc_contact_email) && (
              <p className="border-t px-3 py-2 text-xs text-muted-foreground">
                Vendor contact: {[po.amc_contact_name, po.amc_helpline_number, po.amc_contact_email].filter(Boolean).join(" · ")}
              </p>
            )}
          </div>
        </details>
      </CardContent>
    </Card>
  );
}
