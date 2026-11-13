"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ExternalLink, FileText } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";

interface PanelBill {
  id: string;
  bill_number: string;
  po_id: string | null;
  po_number: string | null;
  po_value: number | null;
  invoice_number: string | null;
  total_amount: number;
  approval_status: string;
  payment_status: string;
  amount_paid: number;
  invoice_file_url: string | null;
  delivery_recorded: boolean;
  is_current: boolean;
}

interface PanelData {
  group: {
    id: string;
    invoice_number: string;
    invoice_total: number;
    allocated: number;
    left: number;
    combined_po_value: number | null;
  } | null;
  bills: PanelBill[];
  po_bills: PanelBill[];
  gate_error: string | null;
}

const approvalPill = (s: string) =>
  s === "approved" ? "bg-green-100 text-green-800" : s === "pending" ? "bg-amber-100 text-amber-800" : "bg-gray-100 text-gray-700";
const approvalLabel = (s: string) => (s === "approved" ? "Approved" : s === "pending" ? "Awaiting approval" : s);
const paymentLabel = (b: PanelBill) =>
  b.payment_status === "paid" ? `Paid ${formatCurrency(b.amount_paid)}` : b.payment_status === "partially_paid" ? `Part-paid ${formatCurrency(b.amount_paid)}` : "Unpaid";

function BillRows({ bills, showPo }: { bills: PanelBill[]; showPo: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] text-sm">
        <thead>
          <tr className="border-b text-left text-[11px] uppercase tracking-wide text-muted-foreground">
            <th className="py-1.5 pr-2 font-medium">Bill</th>
            <th className="py-1.5 pr-2 font-medium">{showPo ? "PO" : "Invoice no."}</th>
            <th className="py-1.5 pr-2 text-right font-medium">{showPo ? "Share" : "Amount"}</th>
            <th className="py-1.5 pr-2 font-medium">Approval</th>
            <th className="py-1.5 pr-2 font-medium">Payment</th>
            <th className="py-1.5 font-medium">Documents</th>
          </tr>
        </thead>
        <tbody>
          {bills.map((b) => (
            <tr key={b.id} className={`border-b last:border-0 ${b.is_current ? "bg-teal-50/60" : ""}`}>
              <td className="py-2 pr-2">
                {b.is_current ? <span className="font-medium">{b.bill_number} (this bill)</span> : (
                  <Link href={`/procurement/bills/${b.id}`} className="font-medium text-primary hover:underline">{b.bill_number}</Link>
                )}
              </td>
              <td className="py-2 pr-2">
                {showPo && b.po_id ? (
                  <Link href={`/procurement/orders/${b.po_id}`} className="text-primary hover:underline inline-flex items-center gap-1">
                    {b.po_number} <ExternalLink className="h-3 w-3" />
                  </Link>
                ) : (b.invoice_number ?? "—")}
              </td>
              <td className="py-2 pr-2 text-right tabular-nums">{formatCurrency(b.total_amount)}</td>
              <td className="py-2 pr-2"><span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${approvalPill(b.approval_status)}`}>{approvalLabel(b.approval_status)}</span></td>
              <td className="py-2 pr-2 text-xs">{paymentLabel(b)}</td>
              <td className="py-2 text-xs space-x-2 whitespace-nowrap">
                {b.invoice_file_url && (
                  <a href={b.invoice_file_url} target="_blank" rel="noreferrer" className="text-primary hover:underline inline-flex items-center gap-1">
                    <FileText className="h-3 w-3" /> Invoice
                  </a>
                )}
                {b.po_id && (
                  <span className={b.delivery_recorded ? "text-green-700" : "text-amber-700"}>
                    {b.delivery_recorded ? "Delivery recorded" : "No delivery recorded"}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The whole-invoice picture for whoever approves or pays a bill: every bill on the same vendor invoice,
 * with PO, share, status and delivery proof, plus every other live invoice on this bill's PO.
 * Renders nothing for an ordinary one-bill, one-invoice PO.
 */
export function SharedInvoicePanel({ billId, role, refreshKey }: { billId: string; role: string | null; refreshKey?: unknown }) {
  const [data, setData] = useState<PanelData | null>(null);
  const [editing, setEditing] = useState(false);
  const [newTotal, setNewTotal] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/procurement/bills/${billId}/shared-invoice`);
      if (res.ok) setData(await res.json());
    } catch {
      // Context only; the bill page works without it.
    }
  }, [billId]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  if (!data) return null;
  const { group, bills, po_bills: poBills } = data;
  const showPoInvoices = poBills.length > 1;
  if (!group && !showPoInvoices) return null;

  const canRaise = ["admin", "manager", "accounts"].includes(role ?? "");
  const paid = bills.reduce((s, b) => s + b.amount_paid, 0);
  const poValue = poBills.find((b) => b.po_value !== null)?.po_value ?? null;
  const poInvoiced = poBills.reduce((s, b) => s + b.total_amount, 0);

  const saveTotal = async () => {
    const total = parseFloat(newTotal);
    if (!group || !isFinite(total) || total <= 0) { toast.error("Enter the corrected invoice total"); return; }
    setSaving(true);
    try {
      const res = await fetch(`/api/procurement/invoice-groups/${group.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invoice_total: total, reason }),
      });
      const json = await res.json();
      if (!res.ok) { toast.error(typeof json.error === "string" ? json.error : "Could not update the invoice total"); return; }
      toast.success("Invoice total updated");
      setEditing(false);
      setReason("");
      await load();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      {group && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex flex-wrap items-center gap-2">
              Vendor invoice {group.invoice_number}
              <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-semibold text-blue-700">
                Shared across {bills.length} bill{bills.length === 1 ? "" : "s"}
              </span>
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              Invoice total {formatCurrency(group.invoice_total)}. Each bill below carries one PO&apos;s share; pay each bill for its own share.
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            <BillRows bills={bills} showPo />
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
              <span>Allocated <b className="text-foreground">{formatCurrency(group.allocated)}</b> of {formatCurrency(group.invoice_total)}</span>
              <span>Paid so far <b className="text-foreground">{formatCurrency(paid)}</b></span>
              {group.combined_po_value !== null && <span>Combined PO value <b className="text-foreground">{formatCurrency(group.combined_po_value)}</b></span>}
            </div>
            {data.gate_error && (
              <p className="text-xs text-red-700 rounded border border-red-200 bg-red-50 px-3 py-2 flex items-start gap-1.5" role="alert">
                <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" /> Approval is on hold: {data.gate_error}
              </p>
            )}
            {group.left > 0.01 && (
              <p className="text-xs text-amber-800 rounded border border-amber-200 bg-amber-50 px-3 py-2 flex items-start gap-1.5">
                <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
                {formatCurrency(group.left)} of this invoice is not on any PO yet. Don&apos;t treat the vendor&apos;s invoice as settled until it is.
              </p>
            )}
            {canRaise && (
              editing ? (
                <div className="rounded border bg-muted/20 p-3 space-y-2">
                  <p className="text-xs text-muted-foreground">
                    Correct the total on the vendor&apos;s invoice (currently {formatCurrency(group.invoice_total)}). It can&apos;t go below the shares already on its bills{role === "admin" ? "" : ", and only an admin can lower it"}.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Input type="number" min="0.01" step="0.01" placeholder="New total" value={newTotal} onChange={(e) => setNewTotal(e.target.value)} className="w-40" />
                    <Input placeholder="Reason (at least 10 characters)" value={reason} onChange={(e) => setReason(e.target.value)} className="flex-1 min-w-[12rem]" />
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" onClick={saveTotal} disabled={saving}>Save total</Button>
                    <Button size="sm" variant="outline" onClick={() => setEditing(false)} disabled={saving}>Cancel</Button>
                  </div>
                </div>
              ) : (
                <Button size="sm" variant="outline" onClick={() => { setNewTotal(String(group.invoice_total)); setEditing(true); }}>
                  Correct invoice total
                </Button>
              )
            )}
          </CardContent>
        </Card>
      )}

      {showPoInvoices && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Invoices on this PO ({poBills.length})</CardTitle>
            {poValue !== null && (
              <p className="text-sm text-muted-foreground">
                {formatCurrency(poInvoiced)} invoiced of {formatCurrency(poValue)}
                {poValue - poInvoiced > 0.01 ? ` · ${formatCurrency(poValue - poInvoiced)} still un-invoiced` : ""}
              </p>
            )}
          </CardHeader>
          <CardContent>
            <BillRows bills={poBills} showPo={false} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
