"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Plus, Pencil, ToggleLeft, ToggleRight, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { ContractAddon } from "@/types";

interface ContractAddonsSectionProps {
  contractId: string;
  contractStartDate?: string;
  contractEndDate?: string;
  taxPercentage?: number;
  readOnly?: boolean;
}

const EMPTY_FORM = {
  description: "",
  amount: "",
  effective_from: new Date().toISOString().split("T")[0],
  effective_until: "",
};

export function ContractAddonsSection({ contractId, contractStartDate, contractEndDate, taxPercentage = 18, readOnly = false }: ContractAddonsSectionProps) {
  const [addons, setAddons] = useState<ContractAddon[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ContractAddon | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);

  const fetch = useCallback(async () => {
    const res = await window.fetch(`/api/contracts/${contractId}/addons`);
    if (res.ok) {
      const json = await res.json();
      setAddons(json.data || []);
    }
    setLoading(false);
  }, [contractId]);

  useEffect(() => { fetch(); }, [fetch]);

  function openAdd() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  }

  function openEdit(addon: ContractAddon) {
    setEditing(addon);
    setForm({
      description: addon.description,
      amount: String(addon.amount),
      effective_from: addon.effective_from,
      effective_until: addon.effective_until ?? "",
    });
    setDialogOpen(true);
  }

  async function handleSave() {
    if (!form.description.trim()) { toast.error("Description is required"); return; }
    const amount = parseFloat(form.amount);
    if (!amount || amount <= 0) { toast.error("Amount must be positive"); return; }
    if (!form.effective_from) { toast.error("Effective from date is required"); return; }
    if (contractStartDate && form.effective_from < contractStartDate) {
      toast.error(`Effective from cannot be before the contract start date (${formatDate(contractStartDate)})`);
      return;
    }
    if (contractEndDate && form.effective_from > contractEndDate) {
      toast.error(`Effective from cannot be after the contract end date (${formatDate(contractEndDate)})`);
      return;
    }
    if (form.effective_until) {
      if (contractEndDate && form.effective_until > contractEndDate) {
        toast.error(`Effective until cannot be beyond the contract end date (${formatDate(contractEndDate)})`);
        return;
      }
      if (form.effective_until < form.effective_from) {
        toast.error("Effective until must be after effective from");
        return;
      }
    }

    setSaving(true);
    try {
      const body = {
        description: form.description.trim(),
        amount,
        effective_from: form.effective_from,
        effective_until: form.effective_until || null,
        ...(editing ? { addon_id: editing.id } : {}),
      };

      const res = await window.fetch(`/api/contracts/${contractId}/addons`, {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => null);
        toast.error(err?.error || "Failed to save add-on");
        return;
      }

      toast.success(editing ? "Add-on updated" : "Add-on added — will appear in next billing cycle");
      setDialogOpen(false);
      fetch();
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(addon: ContractAddon) {
    const res = await window.fetch(`/api/contracts/${contractId}/addons`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ addon_id: addon.id, is_active: !addon.is_active }),
    });
    if (res.ok) {
      toast.success(addon.is_active ? "Add-on deactivated" : "Add-on activated");
      fetch();
    }
  }

  const active = addons.filter(a => a.is_active);
  const inactive = addons.filter(a => !a.is_active);

  return (
    <>
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Recurring Add-ons
            </CardTitle>
            {!readOnly && (
              <Button size="sm" variant="outline" onClick={openAdd}>
                <Plus className="h-3.5 w-3.5 mr-1" />
                Add
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          {loading ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : addons.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">No recurring add-ons. Add items like name boards, parking, lockers — they'll auto-appear in every monthly bill.</p>
          ) : (
            <div className="space-y-2">
              {[...active, ...inactive].map(addon => {
                const gst = Math.round(addon.amount * taxPercentage / 100 * 100) / 100;
                return (
                  <div key={addon.id} className={`flex items-start justify-between gap-2 rounded-md border px-3 py-2 text-sm ${!addon.is_active ? "opacity-50 bg-muted/30" : ""}`}>
                    <div className="min-w-0">
                      <p className="font-medium truncate">{addon.description}</p>
                      <p className="text-muted-foreground text-xs mt-0.5">
                        {formatCurrency(addon.amount)} + {taxPercentage}% GST ({formatCurrency(gst)}) = {formatCurrency(addon.amount + gst)}/month
                      </p>
                      <p className="text-muted-foreground text-xs">
                        From {formatDate(addon.effective_from)}
                        {addon.effective_until && ` · Until ${formatDate(addon.effective_until)}`}
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <Badge variant="secondary" className={addon.is_active ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-500"}>
                        {addon.is_active ? "Active" : "Inactive"}
                      </Badge>
                      {!readOnly && (
                        <>
                          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => openEdit(addon)}>
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => toggleActive(addon)}>
                            {addon.is_active
                              ? <ToggleRight className="h-4 w-4 text-green-600" />
                              : <ToggleLeft className="h-4 w-4 text-muted-foreground" />}
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit Add-on" : "Add Recurring Add-on"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {(contractStartDate || contractEndDate) && (
              <div className="rounded-md bg-muted/50 border px-3 py-2 text-xs text-muted-foreground flex gap-4">
                {contractStartDate && <span>Contract starts: <span className="font-medium text-foreground">{formatDate(contractStartDate)}</span></span>}
                {contractEndDate && <span>Contract ends: <span className="font-medium text-foreground">{formatDate(contractEndDate)}</span></span>}
              </div>
            )}
            <div>
              <Label htmlFor="addon-desc">Description <span className="text-destructive">*</span></Label>
              <Input
                id="addon-desc"
                placeholder="e.g. Name Board, Parking Slot, Locker"
                value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="addon-amount">Monthly Amount (₹, excl. GST) <span className="text-destructive">*</span></Label>
              <Input
                id="addon-amount"
                type="number"
                min={1}
                placeholder="e.g. 500"
                value={form.amount}
                onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
                className="mt-1"
              />
              {form.amount && parseFloat(form.amount) > 0 && (
                <p className="text-xs text-muted-foreground mt-1">
                  + {taxPercentage}% GST = {formatCurrency(parseFloat(form.amount) * (1 + taxPercentage / 100))}/month total
                </p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="addon-from">Effective From <span className="text-destructive">*</span></Label>
                <Input
                  id="addon-from"
                  type="date"
                  value={form.effective_from}
                  min={contractStartDate}
                  max={contractEndDate}
                  onChange={e => setForm(f => ({ ...f, effective_from: e.target.value }))}
                  className="mt-1"
                />
              </div>
              <div>
                <Label htmlFor="addon-until">Effective Until <span className="text-muted-foreground text-xs">(optional)</span></Label>
                <Input
                  id="addon-until"
                  type="date"
                  value={form.effective_until}
                  min={form.effective_from || contractStartDate}
                  max={contractEndDate}
                  onChange={e => setForm(f => ({ ...f, effective_until: e.target.value }))}
                  className="mt-1"
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground bg-blue-50 border border-blue-200 rounded-md px-3 py-2">
              This add-on will automatically appear in every monthly bill. If the effective date falls mid-month, the first bill will be pro-rated accordingly.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {editing ? "Save Changes" : "Add to Contract"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
