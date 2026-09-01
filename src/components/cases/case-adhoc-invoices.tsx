"use client";

/**
 * Ad-hoc proforma invoices on a case — any additional billing, as required.
 *
 * Sits on the Billing tab under the licence-fee invoice, because that tab
 * already holds every rupee associated with the case. Three VO charges were
 * previously raised as lead invoices because a case had nowhere to put them,
 * which left that money invisible from the case entirely.
 *
 * The "Bills to" line is not decoration: on a partner-billed case the charge
 * goes to the aggregator, and raising one against the wrong party means
 * invoicing a client their partner is supposed to be billed for. It is stated
 * before anything is created.
 */

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Loader2, Plus, ReceiptText, MoreHorizontal, Eye, Download, Mail,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmailDocumentDialog } from "@/components/shared/email-document-dialog";
import { INVOICE_STATUS_LABELS } from "@/lib/constants";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { LineItem, ProformaInvoice } from "@/types";

interface AdhocInvoice {
  id: string;
  invoice_number: string | null;
  total_amount: number;
  subtotal: number;
  tax_percentage: number;
  tax_amount: number;
  discount_percentage: number;
  discount_amount: number;
  status: string;
  items: LineItem[];
  due_date: string | null;
  notes: string | null;
  razorpay_link_url: string | null;
  created_at: string;
  title: string;
}

interface BillsTo {
  kind: "aggregator" | "client";
  name: string;
  gstin: string | null;
  email: string | null;
  phone: string | null;
}



export function CaseAdhocInvoices({ caseId }: { caseId: string }) {
  const [invoices, setInvoices] = useState<AdhocInvoice[]>([]);
  const [billsTo, setBillsTo] = useState<BillsTo | null>(null);
  const [endClientName, setEndClientName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [notes, setNotes] = useState("");
  const [billClient, setBillClient] = useState(false);
  const [saving, setSaving] = useState(false);

  const [viewInvoice, setViewInvoice] = useState<AdhocInvoice | null>(null);
  const [emailInvoice, setEmailInvoice] = useState<AdhocInvoice | null>(null);
  const [emailDialogOpen, setEmailDialogOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/cases/${caseId}/adhoc-invoices`);
      const j = await res.json();
      if (!res.ok) { toast.error(j.error || "Could not load ad-hoc invoices"); return; }
      setInvoices(j.data?.invoices ?? []);
      setBillsTo(j.data?.billsTo ?? null);
      setEndClientName(j.data?.endClientName ?? null);
    } catch {
      toast.error("Could not load ad-hoc invoices");
    } finally {
      setLoading(false);
    }
  }, [caseId]);

  useEffect(() => { load(); }, [load]);

  const amountNum = Number(amount);
  const valid = description.trim().length > 0 && Number.isFinite(amountNum) && amountNum > 0;
  const effectiveParty = billClient ? endClientName : billsTo?.name;

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/cases/${caseId}/adhoc-invoices`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: description.trim(),
          amount: amountNum,
          due_date: dueDate || null,
          notes: notes.trim() || null,
          bill_to_override: billClient ? "client" : null,
        }),
      });
      const json = await res.json();
      if (!res.ok) { toast.error(json.error || "Failed to create the invoice"); return; }
      toast.success(`${json.data.invoiceNumber} created — ${formatCurrency(json.data.total)} to ${json.data.buyerName}`);
      setOpen(false);
      setDescription(""); setAmount(""); setDueDate(""); setNotes(""); setBillClient(false);
      await load();
    } catch {
      toast.error("Failed to create the invoice");
    } finally {
      setSaving(false);
    }
  };

  // Synthesizes a lead-shaped object from the resolved billing party so the
  // PDF/email flow (built for lead invoices) can address a case's buyer —
  // mirrors leadFromVoSource() in src/lib/send-proforma.ts.
  const buyerAsLead = billsTo
    ? { first_name: "", last_name: "", company: billsTo.name, email: billsTo.email ?? undefined, phone: billsTo.phone ?? undefined }
    : undefined;

  const handleDownloadInvoicePDF = async (inv: AdhocInvoice) => {
    const { generateInvoicePDF } = await import("@/lib/pdf-generator");
    // AdhocInvoice only carries the fields this page needs, but they're the
    // same fields generateInvoicePDF reads off a ProformaInvoice — safe to
    // widen rather than duplicating the full type here.
    const doc = generateInvoicePDF(inv as unknown as ProformaInvoice, buyerAsLead);
    doc.save(`${inv.invoice_number}.pdf`);
  };

  const handleSendInvoice = (inv: AdhocInvoice) => {
    setEmailInvoice(inv);
    setEmailDialogOpen(true);
  };

  const live = invoices;

  return (
    <div className="rounded-lg border">
      <div className="flex flex-row items-start justify-between gap-4 p-6">
        <div>
          <div className="text-base font-semibold tracking-tight">Ad-Hoc Proforma Invoice</div>
          <p className="mt-0.5 text-xs text-muted-foreground max-w-xl">
            Any additional billing for this case, as required — anything not already covered
            by the licence fee or the renewal.
          </p>
          {billsTo && (
            <p className="mt-1.5 text-xs">
              <span className="text-muted-foreground">Bills to </span>
              <span className="font-medium">{billsTo.name}</span>{" "}
              <Badge variant="outline" className="text-[0.65rem]">
                {billsTo.kind === "aggregator" ? "Aggregator" : "Client"}
              </Badge>
            </p>
          )}
        </div>
        <Button size="sm" onClick={() => setOpen(true)} disabled={!billsTo}>
          <Plus className="mr-1.5 h-4 w-4" />
          New Invoice
        </Button>
      </div>

      <div className="px-6 pb-6">
        {loading ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : live.length === 0 ? (
          <div className="rounded-md border border-dashed py-8 text-center text-sm text-muted-foreground">
            <ReceiptText className="mx-auto mb-2 h-5 w-5 opacity-60" />
            No ad-hoc invoices raised for this case.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-4 py-2.5 text-left font-medium">Invoice #</th>
                  <th className="px-4 py-2.5 text-left font-medium">Title</th>
                  <th className="px-4 py-2.5 text-left font-medium">Raised</th>
                  <th className="px-4 py-2.5 text-left font-medium">Due</th>
                  <th className="px-4 py-2.5 text-left font-medium">Status</th>
                  <th className="px-4 py-2.5 text-right font-medium">Amount</th>
                  <th className="px-4 py-2.5 text-left font-medium w-10" />
                </tr>
              </thead>
              <tbody>
                {live.map((c) => (
                  <tr key={c.id} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="px-4 py-2.5 font-mono text-xs">{c.invoice_number ?? "—"}</td>
                    <td className="px-4 py-2.5">{c.title}</td>
                    <td className="px-4 py-2.5 text-muted-foreground">{formatDate(c.created_at)}</td>
                    <td className="px-4 py-2.5 text-muted-foreground">{c.due_date ? formatDate(c.due_date) : "—"}</td>
                    <td className="px-4 py-2.5">
                      <Badge variant={c.status === "paid" ? "default" : "outline"} className="text-xs">
                        {INVOICE_STATUS_LABELS[c.status as keyof typeof INVOICE_STATUS_LABELS] ?? c.status}
                      </Badge>
                    </td>
                    <td className="px-4 py-2.5 text-right font-medium tabular-nums">
                      {formatCurrency(c.total_amount)}
                    </td>
                    <td className="px-4 py-2.5">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-7 w-7">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => setViewInvoice(c)}>
                            <Eye className="mr-2 h-4 w-4" />
                            View
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => handleDownloadInvoicePDF(c)}>
                            <Download className="mr-2 h-4 w-4" />
                            Download PDF
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => handleSendInvoice(c)}>
                            <Mail className="mr-2 h-4 w-4" />
                            {c.status === "draft" ? "Send" : "Resend"}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Dialog open={open} onOpenChange={(o) => { if (!o) setOpen(false); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New ad-hoc invoice</DialogTitle>
            <DialogDescription>
              Creates a proforma invoice against this case, in the same INV- series as any
              other ad-hoc invoice. Nothing is created until you confirm.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="adhoc-desc">What is being charged</Label>
              <Input
                id="adhoc-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="e.g. Mail handling — 14 letters over allowance"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="adhoc-amt">Amount before GST (₹)</Label>
              <Input
                id="adhoc-amt"
                type="number"
                min="0"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
              {valid && (
                <p className="text-xs text-muted-foreground tabular-nums">
                  + 18% GST = <strong>{formatCurrency(Math.round(amountNum * 1.18 * 100) / 100)}</strong> total
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="adhoc-due">Due date (optional)</Label>
              <Input
                id="adhoc-due"
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="adhoc-notes">Customer-facing notes (optional)</Label>
              <Textarea
                id="adhoc-notes"
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Appears on the invoice PDF and email sent to the customer..."
              />
            </div>

            {billsTo?.kind === "aggregator" && (
              <div className="rounded-md border p-3 space-y-2">
                <div className="flex items-start gap-2">
                  <Checkbox
                    id="adhoc-billclient"
                    checked={billClient}
                    onCheckedChange={(v) => setBillClient(v === true)}
                  />
                  <div className="space-y-0.5">
                    <Label htmlFor="adhoc-billclient" className="text-sm font-normal">
                      Bill the client directly instead
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      This case is billed to {billsTo.name}. Tick this for a charge the client
                      caused and should settle themselves.
                    </p>
                  </div>
                </div>
              </div>
            )}

            <Separator />
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Will be billed to</span>
              <span className="font-medium">{effectiveParty ?? "—"}</span>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={!valid || saving}>
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
              Create invoice
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* View invoice */}
      <Dialog open={!!viewInvoice} onOpenChange={(o) => { if (!o) setViewInvoice(null); }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          {viewInvoice && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  {viewInvoice.invoice_number}
                  <Badge variant="secondary">
                    {INVOICE_STATUS_LABELS[viewInvoice.status as keyof typeof INVOICE_STATUS_LABELS] ?? viewInvoice.status}
                  </Badge>
                </DialogTitle>
                <DialogDescription>{viewInvoice.title}</DialogDescription>
              </DialogHeader>

              <div className="space-y-4">
                <div className="rounded-md border overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-muted/50">
                        <th className="px-3 py-2 text-left font-medium">Description</th>
                        <th className="px-3 py-2 text-right font-medium">Qty</th>
                        <th className="px-3 py-2 text-right font-medium">Unit Price</th>
                        <th className="px-3 py-2 text-right font-medium">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {viewInvoice.items.map((item, idx) => (
                        <tr key={idx} className="border-b last:border-0">
                          <td className="px-3 py-2">{item.description}</td>
                          <td className="px-3 py-2 text-right">{item.quantity}{item.unit ? ` ${item.unit}` : ""}</td>
                          <td className="px-3 py-2 text-right">{formatCurrency(item.unit_price)}</td>
                          <td className="px-3 py-2 text-right font-medium">{formatCurrency(item.total)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="flex flex-col items-end gap-1 text-sm">
                  <div className="flex justify-between w-48"><span className="text-muted-foreground">Subtotal</span><span>{formatCurrency(viewInvoice.subtotal)}</span></div>
                  <div className="flex justify-between w-48"><span className="text-muted-foreground">Tax ({viewInvoice.tax_percentage}%)</span><span>{formatCurrency(viewInvoice.tax_amount)}</span></div>
                  <div className="flex justify-between w-48"><span className="text-muted-foreground">Discount ({viewInvoice.discount_percentage}%)</span><span>-{formatCurrency(viewInvoice.discount_amount)}</span></div>
                  <div className="flex justify-between w-48 font-semibold border-t pt-1"><span>Total</span><span>{formatCurrency(viewInvoice.total_amount)}</span></div>
                </div>

                {viewInvoice.due_date && (
                  <p className="text-sm"><span className="text-muted-foreground">Due Date:</span> {formatDate(viewInvoice.due_date)}</p>
                )}

                {viewInvoice.notes && (
                  <div className="space-y-1">
                    <p className="text-xs font-medium text-muted-foreground">Customer-Facing Notes</p>
                    <p className="text-sm">{viewInvoice.notes}</p>
                  </div>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Send invoice — creates the Razorpay link, moves status to "sent" */}
      {emailInvoice && (
        <EmailDocumentDialog
          open={emailDialogOpen}
          onOpenChange={(o) => { setEmailDialogOpen(o); if (!o) setEmailInvoice(null); }}
          documentType="invoice"
          documentId={emailInvoice.id}
          documentNumber={emailInvoice.invoice_number ?? ""}
          leadEmail={billsTo?.email ?? undefined}
          leadPhone={billsTo?.phone ?? undefined}
          onGeneratePDF={async () => {
            const { generateInvoicePDF } = await import("@/lib/pdf-generator");
            const doc = generateInvoicePDF(emailInvoice as unknown as ProformaInvoice, buyerAsLead);
            return doc.output("datauristring").split(",")[1];
          }}
          onSuccess={load}
        />
      )}
    </div>
  );
}
