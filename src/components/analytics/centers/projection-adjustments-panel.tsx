"use client";

import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/utils";
import type { ProjectionAdjustment, ProjectionContractRow } from "./types";

function monthLabel(ym: string) {
  const [y, m] = ym.split("-").map(Number);
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[m - 1]} '${String(y).slice(2)}`;
}

function AddAdjustmentDialog({
  open, onOpenChange, contracts, onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contracts: ProjectionContractRow[];
  onAdded: () => void;
}) {
  const [contractId, setContractId] = useState("");
  const [month, setMonth] = useState("");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const options = useMemo(
    () => [...contracts]
      .sort((a, b) => a.contract_number.localeCompare(b.contract_number))
      .map((c) => ({
        value: c.id,
        label: `${c.contract_number} — ${c.client_name} (${c.location_name})`,
      })),
    [contracts]
  );

  const reset = () => { setContractId(""); setMonth(""); setAmount(""); setReason(""); };

  const handleSubmit = async () => {
    const amountNum = Number(amount);
    if (!contractId) { toast.error("Select a contract"); return; }
    if (!/^\d{4}-\d{2}$/.test(month)) { toast.error("Pick a month"); return; }
    if (!amountNum || amountNum <= 0) { toast.error("Enter an amount greater than zero"); return; }
    if (!reason.trim()) { toast.error("A reason is required"); return; }

    setSubmitting(true);
    try {
      const res = await fetch("/api/analytics/centers/projections/adjustments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contract_id: contractId, month, amount: amountNum, reason: reason.trim() }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Failed to add adjustment");
        return;
      }
      toast.success("Adjustment added");
      reset();
      onOpenChange(false);
      onAdded();
    } catch {
      toast.error("Network error");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) reset(); onOpenChange(v); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add manual adjustment</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Contract</Label>
            <SearchableSelect
              options={options}
              value={contractId}
              onValueChange={setContractId}
              placeholder="Search by contract number or client..."
              searchPlaceholder="Search contracts..."
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Month</Label>
              <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Amount (₹, pre-GST)</Label>
              <Input type="number" min="1" step="1" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="2,03,928" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Reason</Label>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. April 2026 rent invoiced offline before this contract was set up in the CRM; payment received."
              rows={3}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            This only affects the Projections tab&apos;s Confirmed figure for this contract&apos;s center — it does not touch billing statements, collections, or New MRR, and the contract record itself stays unchanged.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Add adjustment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ProjectionAdjustmentsPanel({
  adjustments, contracts, onChanged,
}: {
  adjustments: ProjectionAdjustment[];
  contracts: ProjectionContractRow[];
  onChanged: () => void;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const handleDelete = async (adj: ProjectionAdjustment) => {
    if (!window.confirm(`Remove the ${monthLabel(adj.month)} adjustment of ${formatCurrency(adj.amount)} for ${adj.contract_number}?`)) return;
    setDeletingId(adj.id);
    try {
      const res = await fetch(`/api/analytics/centers/projections/adjustments/${adj.id}`, { method: "DELETE" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Failed to remove adjustment");
        return;
      }
      toast.success("Adjustment removed");
      onChanged();
    } catch {
      toast.error("Network error");
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="text-base">Manual adjustments</CardTitle>
          <p className="text-xs text-muted-foreground">Revenue that exists but isn&apos;t captured by a contract&apos;s dates — Confirmed only</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setDialogOpen(true)}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          Add adjustment
        </Button>
      </CardHeader>
      <CardContent>
        {adjustments.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">No manual adjustments yet.</p>
        ) : (
          <ul className="divide-y">
            {adjustments.map((adj) => (
              <li key={adj.id} className="flex items-start justify-between gap-3 py-3 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <div className="text-sm font-medium">
                    {adj.contract_number} · {monthLabel(adj.month)} · {formatCurrency(adj.amount)}
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">{adj.reason}</p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">Added by {adj.created_by_name}</p>
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                  onClick={() => handleDelete(adj)}
                  disabled={deletingId === adj.id}
                >
                  {deletingId === adj.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <AddAdjustmentDialog open={dialogOpen} onOpenChange={setDialogOpen} contracts={contracts} onAdded={onChanged} />
    </Card>
  );
}
