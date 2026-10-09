"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Link2, Unlink, Receipt, CheckCircle2, AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { formatDate, formatCurrency } from "@/lib/utils";
import {
  ADHOC_ATTRIBUTION_PURPOSES,
  ADHOC_ATTRIBUTION_PURPOSE_LABELS,
  ADHOC_ATTRIBUTION_PURPOSE_DESCRIPTIONS,
  ACTIVATION_UNBLOCKING_PURPOSE,
  type AdhocAttributionPurpose,
} from "@/lib/constants";

interface AttributableInvoice {
  id: string;
  invoice_number: string;
  title: string;
  status: string;
  total_amount: number;
  paid_at: string | null;
  payment_reference: string | null;
  gst_invoice_number: string | null;
  due_date: string | null;
  created_at: string;
  attribution_purpose: AdhocAttributionPurpose | null;
  attributed_at: string | null;
}

interface Props {
  contractId: string;
  currentUserRole: string;
  /** Lets the parent refresh the activation gate once an invoice is linked. */
  onAttributionChanged?: () => void;
}

const PURPOSE_BADGE: Record<AdhocAttributionPurpose, string> = {
  prorata_first_invoice: "bg-emerald-50 text-emerald-700 border-emerald-200",
  monthly_rent: "bg-blue-50 text-blue-700 border-blue-200",
  security_deposit: "bg-amber-50 text-amber-700 border-amber-200",
  other: "bg-gray-100 text-gray-700 border-gray-200",
};

const STATUS_BADGE: Record<string, string> = {
  draft: "bg-gray-100 text-gray-700 border-gray-200",
  sent: "bg-blue-50 text-blue-700 border-blue-200",
  paid: "bg-green-50 text-green-700 border-green-200",
  overdue: "bg-red-50 text-red-700 border-red-200",
  cancelled: "bg-gray-100 text-gray-500 border-gray-200",
};

export function ContractAttributedInvoicesSection({
  contractId,
  currentUserRole,
  onAttributionChanged,
}: Props) {
  const [attributed, setAttributed] = useState<AttributableInvoice[]>([]);
  const [candidates, setCandidates] = useState<AttributableInvoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedInvoiceId, setSelectedInvoiceId] = useState("");
  const [purpose, setPurpose] = useState<AdhocAttributionPurpose | "">("");
  const [saving, setSaving] = useState(false);
  const [detachingId, setDetachingId] = useState<string | null>(null);
  // Unlinking pulls an invoice off the contract (and off the activation gate),
  // so it asks first — the icon alone is easy to hit by mistake.
  const [confirmDetach, setConfirmDetach] = useState<AttributableInvoice | null>(null);
  const [changingId, setChangingId] = useState<string | null>(null);

  const canAttribute = ["admin", "accounts"].includes(currentUserRole);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/contracts/${contractId}/attributed-invoices`);
      if (!res.ok) throw new Error();
      const json = await res.json();
      setAttributed(json.data?.attributed || []);
      setCandidates(json.data?.candidates || []);
    } catch {
      setAttributed([]);
      setCandidates([]);
    }
  }, [contractId]);

  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, [refresh]);

  const handleAttribute = async () => {
    if (!selectedInvoiceId || !purpose) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/invoices/${selectedInvoiceId}/attribution`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contract_id: contractId, purpose }),
      });
      if (res.ok) {
        toast.success("Invoice attributed to this contract");
        setDialogOpen(false);
        setSelectedInvoiceId("");
        setPurpose("");
        await refresh();
        onAttributionChanged?.();
      } else {
        const err = await res.json().catch(() => null);
        toast.error(err?.error || "Failed to attribute invoice");
      }
    } catch {
      toast.error("Failed to attribute invoice");
    } finally {
      setSaving(false);
    }
  };

  // Re-tag in place: the attribution POST already updates an attributed invoice,
  // so the invoice never leaves the contract (and the gate) in between.
  const handleChangePurpose = async (invoiceId: string, next: AdhocAttributionPurpose) => {
    setChangingId(invoiceId);
    try {
      const res = await fetch(`/api/invoices/${invoiceId}/attribution`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contract_id: contractId, purpose: next }),
      });
      if (res.ok) {
        toast.success(`Now counted as: ${ADHOC_ATTRIBUTION_PURPOSE_LABELS[next]}`);
        await refresh();
        onAttributionChanged?.();
      } else {
        const err = await res.json().catch(() => null);
        toast.error(err?.error || "Failed to change what this invoice covers");
      }
    } catch {
      toast.error("Failed to change what this invoice covers");
    } finally {
      setChangingId(null);
    }
  };

  const handleDetach = async (invoiceId: string) => {
    setDetachingId(invoiceId);
    try {
      const res = await fetch(`/api/invoices/${invoiceId}/attribution`, { method: "DELETE" });
      if (res.ok) {
        toast.success("Attribution removed");
        await refresh();
        onAttributionChanged?.();
      } else {
        const err = await res.json().catch(() => null);
        toast.error(err?.error || "Failed to remove attribution");
      }
    } catch {
      toast.error("Failed to remove attribution");
    } finally {
      setDetachingId(null);
    }
  };

  const selectedCandidate = candidates.find((c) => c.id === selectedInvoiceId);
  const paidProrataLinked = attributed.some(
    (inv) => inv.attribution_purpose === ACTIVATION_UNBLOCKING_PURPOSE && inv.status === "paid"
  );

  if (loading) return null;
  // Nothing linked and nothing linkable — don't add a dead card to the page.
  if (attributed.length === 0 && candidates.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-4">
          <CardTitle className="text-base flex items-center gap-2">
            <Receipt className="h-4 w-4" />
            Ad-hoc Invoices
          </CardTitle>
          {canAttribute && candidates.length > 0 && (
            <Button size="sm" variant="outline" onClick={() => setDialogOpen(true)}>
              <Link2 className="mr-2 h-3.5 w-3.5" />
              Attribute an invoice
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Charges for this contract that were collected through a lead-level ad-hoc invoice
          rather than a billing statement.
        </p>
      </CardHeader>

      <CardContent className="space-y-3">
        {attributed.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No ad-hoc invoices attributed to this contract yet.
            {candidates.length > 0 && ` ${candidates.length} invoice${candidates.length === 1 ? "" : "s"} for this customer could be attributed.`}
          </p>
        ) : (
          <div className="space-y-2">
            {attributed.map((inv) => (
              <div
                key={inv.id}
                className="flex items-start justify-between gap-3 rounded-md border p-3"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href="/invoices" className="font-mono text-xs text-primary hover:underline">
                      {inv.invoice_number}
                    </Link>
                    <Badge variant="outline" className={`text-[10px] ${STATUS_BADGE[inv.status] || ""}`}>
                      {inv.status}
                    </Badge>
                    {inv.attribution_purpose && (
                      <Badge
                        variant="outline"
                        className={`text-[10px] ${PURPOSE_BADGE[inv.attribution_purpose]}`}
                      >
                        {ADHOC_ATTRIBUTION_PURPOSE_LABELS[inv.attribution_purpose]}
                      </Badge>
                    )}
                  </div>
                  <p className="truncate text-sm font-medium">{inv.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatCurrency(inv.total_amount)}
                    {inv.paid_at && ` · paid ${formatDate(inv.paid_at)}`}
                    {inv.payment_reference && ` · ref ${inv.payment_reference}`}
                    {inv.gst_invoice_number && ` · GST ${inv.gst_invoice_number}`}
                  </p>
                </div>
                {canAttribute && (
                  <div className="flex shrink-0 items-center gap-1">
                    {/* A deposit credit moves money in the deposit pool, so it is
                        only changed by removing the attribution, never re-tagged inline. */}
                    {inv.attribution_purpose && inv.attribution_purpose !== "security_deposit" && (
                      <Select
                        value={inv.attribution_purpose}
                        onValueChange={(v) => handleChangePurpose(inv.id, v as AdhocAttributionPurpose)}
                        disabled={changingId === inv.id}
                      >
                        <SelectTrigger className="h-8 w-[170px] text-xs" aria-label={`What ${inv.invoice_number} covers`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ADHOC_ATTRIBUTION_PURPOSES.filter((p) => p !== "security_deposit").map((p) => (
                            <SelectItem key={p} value={p} className="text-xs">
                              {ADHOC_ATTRIBUTION_PURPOSE_LABELS[p]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-muted-foreground hover:text-destructive"
                      title="Remove from this contract"
                      aria-label={`Remove ${inv.invoice_number} from this contract`}
                      disabled={detachingId === inv.id}
                      onClick={() => setConfirmDetach(inv)}
                    >
                      {detachingId === inv.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Unlink className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {paidProrataLinked && (
          <p className="flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            A paid invoice is attributed as the pro-rata / first invoice, so it satisfies the
            activation payment requirement for this contract.
          </p>
        )}
      </CardContent>

      <Dialog open={!!confirmDetach} onOpenChange={(o) => { if (!o) setConfirmDetach(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove {confirmDetach?.invoice_number} from this contract?</DialogTitle>
            <DialogDescription>
              The invoice stays as it is, but it no longer counts for this contract
              {confirmDetach?.attribution_purpose === ACTIVATION_UNBLOCKING_PURPOSE
                ? ", and it stops satisfying the activation payment requirement"
                : ""}
              {confirmDetach?.attribution_purpose === "security_deposit"
                ? ", and its security deposit credit is taken back out of the customer's pool"
                : ""}
              . To change what it covers, use the dropdown on the row instead.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDetach(null)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => {
                const id = confirmDetach?.id;
                setConfirmDetach(null);
                if (id) void handleDetach(id);
              }}
            >
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Attribute an ad-hoc invoice</DialogTitle>
            <DialogDescription>
              Link an invoice raised for this customer to this contract, and state what it covers.
              This is recorded in the audit trail.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Invoice</Label>
              <Select value={selectedInvoiceId} onValueChange={setSelectedInvoiceId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select an invoice" />
                </SelectTrigger>
                <SelectContent>
                  {candidates.map((inv) => (
                    <SelectItem key={inv.id} value={inv.id}>
                      {inv.invoice_number} — {formatCurrency(inv.total_amount)} ({inv.status})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedCandidate && (
                <p className="text-xs text-muted-foreground">{selectedCandidate.title}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label>What does it cover?</Label>
              <Select
                value={purpose}
                onValueChange={(v) => setPurpose(v as AdhocAttributionPurpose)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a purpose" />
                </SelectTrigger>
                <SelectContent>
                  {ADHOC_ATTRIBUTION_PURPOSES.map((p) => (
                    <SelectItem key={p} value={p}>
                      {ADHOC_ATTRIBUTION_PURPOSE_LABELS[p]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {purpose && (
                <p className="text-xs text-muted-foreground">
                  {ADHOC_ATTRIBUTION_PURPOSE_DESCRIPTIONS[purpose]}
                </p>
              )}
            </div>

            {purpose === ACTIVATION_UNBLOCKING_PURPOSE && selectedCandidate?.status !== "paid" && (
              <p className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                This invoice isn&apos;t paid yet. It can still be attributed, but it won&apos;t
                satisfy the activation payment requirement until it is marked paid.
              </p>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={handleAttribute} disabled={!selectedInvoiceId || !purpose || saving}>
              {saving && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
              Attribute
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
