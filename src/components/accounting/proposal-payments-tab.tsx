"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  CheckCircle2, Circle, Download, FileSpreadsheet,
  FileText, RotateCcw, AlertCircle, Loader2,
} from "lucide-react";
import { toast } from "sonner";

interface ProformaRow {
  id: string;
  invoice_number: string;
  gst_invoice_number: string | null;
  title: string;
  subtotal: number;
  tax_amount: number;
  total_amount: number;
  tax_percentage: number;
  paid_at: string | null;
  payment_reference: string | null;
  accounted: boolean;
  accounted_at: string | null;
  lead: { first_name: string; last_name: string; company?: string; gst_number?: string } | null;
}

interface BillingRow {
  id: string;
  gst_invoice_number: string | null;
  subtotal: number;
  cgst_amount: number;
  sgst_amount: number;
  igst_amount: number;
  total_amount: number;
  tax_percentage: number;
  payment_date: string | null;
  accounted: boolean;
  accounted_at: string | null;
  contract: {
    contract_number: string;
    lead: { first_name: string; last_name: string; company?: string; gst_number?: string } | null;
  } | null;
}

interface Summary {
  proforma_count: number; proforma_total: number;
  billing_count: number; billing_total: number;
  unaccounted_count: number;
}

interface PaymentsData {
  month: string;
  proformas: ProformaRow[];
  billings: BillingRow[];
  summary: Summary;
}

function fmt(d?: string | null) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" });
}

function inr(n: number) {
  return `₹${Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;
}

function buyerName(lead: { first_name: string; last_name: string; company?: string } | null) {
  if (!lead) return "—";
  return lead.company || `${lead.first_name} ${lead.last_name}`.trim();
}

interface Props { month: string; }

export function ProposalPaymentsTab({ month }: Props) {
  const [data, setData] = useState<PaymentsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [markingId, setMarkingId] = useState<string | null>(null);
  const [gstLoading, setGstLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/accounting/proposal-payments?month=${month}`);
      if (res.ok) setData(await res.json());
    } finally {
      setLoading(false);
    }
  }, [month]);

  useEffect(() => { load(); }, [load]);

  const markAccounted = async (type: string, id: string, current: boolean) => {
    setMarkingId(`${type}-${id}`);
    try {
      const res = await fetch("/api/accounting/proposal-payments", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, id, accounted: !current }),
      });
      if (res.ok) {
        toast.success(!current ? "Marked as accounted" : "Unmarked");
        load();
      } else {
        const j = await res.json();
        toast.error(j.error || "Failed to update");
      }
    } finally {
      setMarkingId(null);
    }
  };

  // ── Export helpers ───────────────────────────────────────────────────────

  const exportGstReportPDF = async () => {
    setGstLoading(true);
    try {
      const res = await fetch(`/api/accounting/gst-report?month=${month}`);
      if (!res.ok) { toast.error("Failed to fetch GST data"); return; }
      const gst = await res.json();

      // Dynamic imports keep jsPDF + autotable out of the initial bundle.
      const { default: jsPDF } = await import("jspdf");
      const { default: autoTable } = await import("jspdf-autotable");
      const doc = new jsPDF({ orientation: "landscape" });
      const title = `GST Outward Supply Report — ${month}`;
      doc.setFontSize(14);
      doc.text(title, 14, 18);
      doc.setFontSize(9);
      doc.text(`Supplier: ${gst.supplier_name}  |  GSTIN: ${gst.supplier_gstin}  |  State: ${gst.supplier_state}`, 14, 26);

      const rows = (gst.all as {
        invoice_number: string; invoice_date: string; buyer_name: string;
        buyer_gstin: string | null; buyer_state: string | null; description: string;
        taxable_value: number; tax_rate: number; cgst: number; sgst: number; igst: number; total: number;
      }[]).map((l) => [
        l.invoice_number,
        fmt(l.invoice_date),
        l.buyer_name,
        l.buyer_gstin || "Unregistered",
        l.buyer_state || "—",
        l.description,
        `Rs.${l.taxable_value.toFixed(2)}`,
        `${l.tax_rate}%`,
        l.cgst > 0 ? `Rs.${l.cgst.toFixed(2)}` : "—",
        l.sgst > 0 ? `Rs.${l.sgst.toFixed(2)}` : "—",
        l.igst > 0 ? `Rs.${l.igst.toFixed(2)}` : "—",
        `Rs.${l.total.toFixed(2)}`,
      ]);

      autoTable(doc, {
        startY: 32,
        head: [["Invoice No.", "Date", "Buyer", "GSTIN", "State", "Description",
                "Taxable", "Rate", "CGST", "SGST", "IGST", "Total"]],
        body: rows,
        styles: { fontSize: 7, cellPadding: 2 },
        headStyles: { fillColor: [1, 94, 101] },
        foot: [[
          "", "", "", "", "", "TOTAL",
          `Rs.${gst.totals.taxable_value.toFixed(2)}`, "",
          `Rs.${gst.totals.cgst.toFixed(2)}`,
          `Rs.${gst.totals.sgst.toFixed(2)}`,
          `Rs.${gst.totals.igst.toFixed(2)}`,
          `Rs.${gst.totals.total.toFixed(2)}`,
        ]],
        footStyles: { fillColor: [240, 250, 245], textColor: [0, 0, 0], fontStyle: "bold" },
      });

      doc.save(`GST-Report-${month}.pdf`);
      toast.success("GST report PDF downloaded");
    } finally {
      setGstLoading(false);
    }
  };

  const exportGstReportCSV = async () => {
    setGstLoading(true);
    try {
      const res = await fetch(`/api/accounting/gst-report?month=${month}`);
      if (!res.ok) { toast.error("Failed to fetch GST data"); return; }
      const gst = await res.json();

      const header = ["Invoice No.", "Invoice Date", "Buyer Name", "Buyer GSTIN",
                      "State", "Description", "Taxable Value", "GST Rate %",
                      "CGST", "SGST", "IGST", "Total"].join(",");
      const rows = (gst.all as {
        invoice_number: string; invoice_date: string; buyer_name: string;
        buyer_gstin: string | null; buyer_state: string | null; description: string;
        taxable_value: number; tax_rate: number; cgst: number; sgst: number; igst: number; total: number;
      }[]).map((l) => [
        `"${l.invoice_number}"`,
        fmt(l.invoice_date),
        `"${l.buyer_name}"`,
        `"${l.buyer_gstin || "Unregistered"}"`,
        `"${l.buyer_state || ""}"`,
        `"${l.description}"`,
        l.taxable_value.toFixed(2),
        l.tax_rate,
        l.cgst.toFixed(2),
        l.sgst.toFixed(2),
        l.igst.toFixed(2),
        l.total.toFixed(2),
      ].join(","));

      const csv = [
        `"GST Outward Supply Report — ${month}"`,
        `"Supplier: ${gst.supplier_name} | GSTIN: ${gst.supplier_gstin}"`,
        "",
        header,
        ...rows,
        "",
        `"TOTAL","","","","","",${gst.totals.taxable_value.toFixed(2)},"",${gst.totals.cgst.toFixed(2)},${gst.totals.sgst.toFixed(2)},${gst.totals.igst.toFixed(2)},${gst.totals.total.toFixed(2)}`,
      ].join("\n");

      const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" }); // BOM for Excel
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `GST-Report-${month}.csv`; a.click();
      URL.revokeObjectURL(url);
      toast.success("GST report CSV downloaded (open in Excel)");
    } finally {
      setGstLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 gap-2 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
        <span className="text-sm">Loading payments…</span>
      </div>
    );
  }

  if (!data) return null;

  const { proformas, billings, summary } = data;
  const hasAny = proformas.length + billings.length > 0;

  return (
    <div className="space-y-6">
      {/* Summary bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-3">
          <div className="rounded-md border bg-card px-3 py-2 text-sm">
            <p className="text-xs text-muted-foreground">Adhoc Invoices</p>
            <p className="font-bold">{inr(summary.proforma_total)}
              <span className="text-xs font-normal text-muted-foreground ml-1">({summary.proforma_count})</span>
            </p>
          </div>
          <div className="rounded-md border bg-card px-3 py-2 text-sm">
            <p className="text-xs text-muted-foreground">Monthly GST Invoices</p>
            <p className="font-bold">{inr(summary.billing_total)}
              <span className="text-xs font-normal text-muted-foreground ml-1">({summary.billing_count})</span>
            </p>
          </div>
          {summary.unaccounted_count > 0 && (
            <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm flex items-center gap-2">
              <AlertCircle className="h-4 w-4 text-amber-600 shrink-0" />
              <div>
                <p className="text-xs text-amber-700">Pending accounting entry</p>
                <p className="font-bold text-amber-800">{summary.unaccounted_count} item{summary.unaccounted_count > 1 ? "s" : ""}</p>
              </div>
            </div>
          )}
        </div>

        {/* GST Report exports */}
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={exportGstReportPDF} disabled={gstLoading || !hasAny}>
            {gstLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileText className="mr-2 h-4 w-4" />}
            GST Report PDF
          </Button>
          <Button variant="outline" size="sm" onClick={exportGstReportCSV} disabled={gstLoading || !hasAny}>
            {gstLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileSpreadsheet className="mr-2 h-4 w-4" />}
            GST Report Excel
          </Button>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        Security deposit accounting has moved to Tally Inbox → Deposits.
      </p>

      {!hasAny && (
        <div className="text-center py-12 text-muted-foreground text-sm">
          No payments received in {month}.
        </div>
      )}

      {/* ── Proforma / Adhoc Invoices ─────────────────────────────────────── */}
      {proformas.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            Adhoc / Proforma Invoices ({proformas.length})
          </h3>
          <div className="rounded-md border overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Invoice</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Customer</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Paid</th>
                  <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Taxable</th>
                  <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">GST</th>
                  <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Total</th>
                  <th className="px-3 py-2 text-center text-xs font-medium text-muted-foreground">Accounted</th>
                </tr>
              </thead>
              <tbody>
                {proformas.map((p) => (
                  <tr key={p.id} className={`border-b last:border-0 ${p.accounted ? "bg-green-50/40" : ""}`}>
                    <td className="px-3 py-2.5">
                      <p className="font-mono text-xs font-semibold text-primary">{p.gst_invoice_number || p.invoice_number}</p>
                      <p className="text-xs text-muted-foreground truncate max-w-[140px]">{p.title}</p>
                    </td>
                    <td className="px-3 py-2.5">
                      <p className="text-xs font-medium">{buyerName(p.lead)}</p>
                      {p.lead?.gst_number && <p className="text-[10px] font-mono text-muted-foreground">{p.lead.gst_number}</p>}
                    </td>
                    <td className="px-3 py-2.5 text-xs">{fmt(p.paid_at)}</td>
                    <td className="px-3 py-2.5 text-right text-xs">{inr(p.subtotal)}</td>
                    <td className="px-3 py-2.5 text-right text-xs">
                      {inr(p.tax_amount)}
                      <span className="text-muted-foreground ml-1 text-[10px]">@{p.tax_percentage}%</span>
                    </td>
                    <td className="px-3 py-2.5 text-right font-semibold">{inr(p.total_amount)}</td>
                    <td className="px-3 py-2.5 text-center">
                      <div className="flex flex-col items-center gap-0.5">
                        <Button
                          size="sm"
                          variant={p.accounted ? "default" : "outline"}
                          className={`h-7 text-xs gap-1.5 ${p.accounted ? "bg-green-600 hover:bg-green-700" : ""}`}
                          disabled={markingId === `proforma-${p.id}`}
                          onClick={() => markAccounted("proforma", p.id, p.accounted)}
                        >
                          {markingId === `proforma-${p.id}` ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : p.accounted ? (
                            <CheckCircle2 className="h-3.5 w-3.5" />
                          ) : (
                            <Circle className="h-3.5 w-3.5" />
                          )}
                          {p.accounted ? "Accounted" : "Mark"}
                        </Button>
                        {p.accounted && p.accounted_at && (
                          <p className="text-[10px] text-green-700">{fmt(p.accounted_at)}</p>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ── Billing Statements (Monthly GST) ─────────────────────────────── */}
      {billings.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            Monthly GST Invoices — Contracts ({billings.length})
          </h3>
          <div className="rounded-md border overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Invoice / Contract</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Customer</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Paid</th>
                  <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Taxable</th>
                  <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">CGST</th>
                  <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">SGST</th>
                  <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">IGST</th>
                  <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Total</th>
                  <th className="px-3 py-2 text-center text-xs font-medium text-muted-foreground">Accounted</th>
                </tr>
              </thead>
              <tbody>
                {billings.map((b) => {
                  const lead = (b.contract as { lead?: { first_name: string; last_name: string; company?: string; gst_number?: string } | null } | null)?.lead || null;
                  return (
                    <tr key={b.id} className={`border-b last:border-0 ${b.accounted ? "bg-green-50/40" : ""}`}>
                      <td className="px-3 py-2.5">
                        <p className="font-mono text-xs font-semibold text-primary">{b.gst_invoice_number || "—"}</p>
                        <p className="text-xs text-muted-foreground">{b.contract?.contract_number}</p>
                      </td>
                      <td className="px-3 py-2.5">
                        <p className="text-xs font-medium">{buyerName(lead)}</p>
                        {lead?.gst_number && <p className="text-[10px] font-mono text-muted-foreground">{lead.gst_number}</p>}
                      </td>
                      <td className="px-3 py-2.5 text-xs">{fmt(b.payment_date)}</td>
                      <td className="px-3 py-2.5 text-right text-xs">{inr(b.subtotal)}</td>
                      <td className="px-3 py-2.5 text-right text-xs">{b.cgst_amount > 0 ? inr(b.cgst_amount) : "—"}</td>
                      <td className="px-3 py-2.5 text-right text-xs">{b.sgst_amount > 0 ? inr(b.sgst_amount) : "—"}</td>
                      <td className="px-3 py-2.5 text-right text-xs">{b.igst_amount > 0 ? inr(b.igst_amount) : "—"}</td>
                      <td className="px-3 py-2.5 text-right font-semibold">{inr(b.total_amount)}</td>
                      <td className="px-3 py-2.5 text-center">
                        <div className="flex flex-col items-center gap-0.5">
                          <Button
                            size="sm"
                            variant={b.accounted ? "default" : "outline"}
                            className={`h-7 text-xs gap-1.5 ${b.accounted ? "bg-green-600 hover:bg-green-700" : ""}`}
                            disabled={markingId === `billing-${b.id}`}
                            onClick={() => markAccounted("billing", b.id, b.accounted)}
                          >
                            {markingId === `billing-${b.id}` ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : b.accounted ? (
                              <CheckCircle2 className="h-3.5 w-3.5" />
                            ) : (
                              <Circle className="h-3.5 w-3.5" />
                            )}
                            {b.accounted ? "Accounted" : "Mark"}
                          </Button>
                          {b.accounted && b.accounted_at && (
                            <p className="text-[10px] text-green-700">{fmt(b.accounted_at)}</p>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
