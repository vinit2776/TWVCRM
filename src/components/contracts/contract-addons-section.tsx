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
import { Textarea } from "@/components/ui/textarea";
import { Plus, Pencil, ToggleLeft, ToggleRight, Loader2, CalendarX2 } from "lucide-react";
import { toast } from "sonner";
import { formatCurrency, formatDate } from "@/lib/utils";
import { addonTermKind, isAddonLiveOn } from "@/lib/addon-billing";
import type { ContractAddon } from "@/types";

interface ContractAddonsSectionProps {
  contractId: string;
  contractStartDate?: string;
  contractEndDate?: string;
  taxPercentage?: number;
  /** The contract's escalating monthly fee, for the running total. */
  monthlyFee?: number;
  /** Who may stop an add-on before its end date (admin, manager, sales rep). */
  canEndBilling?: boolean;
  readOnly?: boolean;
  /** Bump to open the Add dialog (the contract page's Invoice wizard does this). */
  openAddSignal?: number;
}

const MIN_END_REASON_LENGTH = 10;

/** A new add-on runs the whole contract term unless the customer asks otherwise. */
function emptyForm(termStart?: string, termEnd?: string) {
  return {
    description: "",
    amount: "",
    effective_from: termStart ?? new Date().toISOString().split("T")[0],
    effective_until: termEnd ?? "",
  };
}

export function ContractAddonsSection({ contractId, contractStartDate, contractEndDate, taxPercentage = 18, monthlyFee, canEndBilling = false, readOnly = false, openAddSignal = 0 }: ContractAddonsSectionProps) {
  const [addons, setAddons] = useState<ContractAddon[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ContractAddon | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(() => emptyForm(contractStartDate, contractEndDate));
  const [ending, setEnding] = useState<ContractAddon | null>(null);
  const [endDate, setEndDate] = useState("");
  const [endReason, setEndReason] = useState("");
  // Moving an Until date earlier in the Edit dialog is an early end too, so it asks for the same reason.
  const [editReason, setEditReason] = useState("");

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
    setEditReason("");
    setForm(emptyForm(contractStartDate, contractEndDate));
    setDialogOpen(true);
  }

  useEffect(() => {
    if (openAddSignal > 0 && !readOnly) openAdd();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openAddSignal]);

  function openEdit(addon: ContractAddon) {
    setEditing(addon);
    setEditReason("");
    setForm({
      description: addon.description,
      amount: String(addon.amount),
      effective_from: addon.effective_from,
      effective_until: addon.effective_until ?? "",
    });
    setDialogOpen(true);
  }

  const editShortens = !!editing && !!form.effective_until &&
    form.effective_until < (editing.effective_until ?? contractEndDate ?? "9999-12-31");

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

    if (editShortens) {
      if (!canEndBilling) { toast.error("Only admins, managers and sales reps can end an add-on early"); return; }
      if (editReason.trim().length < MIN_END_REASON_LENGTH) {
        toast.error(`Say why billing is ending early (at least ${MIN_END_REASON_LENGTH} characters)`);
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
        ...(editShortens ? { end_reason: editReason.trim() } : {}),
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
      await announceNotice(res);
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
      toast.success(addon.is_active ? "Billing paused for this add-on" : "Billing switched back on");
      await announceNotice(res);
      fetch();
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Could not change this add-on");
    }
  }

  /** The server says which invoices a change could not reach; show that rather than staying silent. */
  async function announceNotice(res: Response) {
    const json = await res.clone().json().catch(() => null);
    if (json?.notice) toast.warning(json.notice, { duration: 10000 });
  }

  function openEnd(addon: ContractAddon) {
    setEnding(addon);
    setEndDate("");
    setEndReason("");
  }

  async function handleEndBilling() {
    if (!ending) return;
    if (!endDate) { toast.error("Pick the last day to bill"); return; }
    if (endDate < ending.effective_from) { toast.error("The last day cannot be before billing started"); return; }
    if (contractEndDate && endDate >= contractEndDate) { toast.error("That is the contract's last day already; nothing to end early"); return; }
    if (endReason.trim().length < MIN_END_REASON_LENGTH) {
      toast.error(`Say why billing is ending (at least ${MIN_END_REASON_LENGTH} characters)`);
      return;
    }
    setSaving(true);
    try {
      const res = await window.fetch(`/api/contracts/${contractId}/addons`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ addon_id: ending.id, effective_until: endDate, end_reason: endReason.trim() }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        toast.error(err?.error || "Could not end billing");
        return;
      }
      toast.success(`${ending.description} will be billed up to ${formatDate(endDate)}`);
      await announceNotice(res);
      setEnding(null);
      fetch();
    } finally {
      setSaving(false);
    }
  }

  const active = addons.filter(a => a.is_active);
  const inactive = addons.filter(a => !a.is_active);
  const today = new Date().toISOString().split("T")[0];
  const billingNow = addons.filter(a => isAddonLiveOn(a, today)).reduce((sum, a) => sum + Number(a.amount), 0);

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
            <p className="text-xs text-muted-foreground italic">No recurring add-ons. Add items like name boards, parking, lockers — they&apos;ll auto-appear in every monthly bill.</p>
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
                      <p className="text-muted-foreground text-xs flex flex-wrap items-center gap-1.5">
                        <span>
                          From {formatDate(addon.effective_from)}
                          {addon.effective_until && ` · Until ${formatDate(addon.effective_until)}`}
                        </span>
                        {(() => {
                          const kind = addonTermKind(addon, contractStartDate, contractEndDate);
                          if (kind === "full") return <Badge variant="secondary" className="bg-emerald-50 text-emerald-700">Full term</Badge>;
                          if (kind === "ended_early") return <Badge variant="secondary" className="bg-amber-50 text-amber-800">Ends early</Badge>;
                          return <Badge variant="secondary" className="bg-slate-100 text-slate-600">Custom dates</Badge>;
                        })()}
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
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            title={addon.is_active ? "Pause billing for this add-on" : "Switch billing back on"}
                            onClick={() => toggleActive(addon)}
                          >
                            {addon.is_active
                              ? <ToggleRight className="h-4 w-4 text-green-600" />
                              : <ToggleLeft className="h-4 w-4 text-muted-foreground" />}
                          </Button>
                          {canEndBilling && addon.is_active && (
                            <Button size="icon" variant="ghost" className="h-7 w-7" title="End billing on a date" onClick={() => openEnd(addon)}>
                              <CalendarX2 className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/40 px-3 py-2 text-xs">
                <span className="text-muted-foreground">Billing now (before GST)</span>
                <span className="font-medium tabular-nums">
                  {typeof monthlyFee === "number" && <>Monthly fee {formatCurrency(monthlyFee)} + add-ons {formatCurrency(billingNow)} = </>}
                  {formatCurrency((monthlyFee ?? 0) + billingNow)}
                </span>
              </div>
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
            {editShortens && (
              <div>
                <Label htmlFor="addon-edit-reason">Why billing ends early, and who asked <span className="text-destructive">*</span></Label>
                <Textarea
                  id="addon-edit-reason"
                  value={editReason}
                  onChange={e => setEditReason(e.target.value)}
                  placeholder="e.g. Customer gave up the slot, email of 9 Jan"
                  className="mt-1"
                />
                <p className="text-xs text-muted-foreground mt-1">Kept in the audit trail. At least {MIN_END_REASON_LENGTH} characters.</p>
              </div>
            )}
            {addonTermKind({ effective_from: form.effective_from, effective_until: form.effective_until || null }, contractStartDate, contractEndDate) === "full" ? (
              <p className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-md px-3 py-2">
                Runs for the full contract term. Change a date only if the customer asked for a shorter or later period.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground bg-blue-50 border border-blue-200 rounded-md px-3 py-2">
                Custom dates. This add-on appears in every monthly bill between them; a mid-month date is pro-rated by day.
              </p>
            )}
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
      <Dialog open={!!ending} onOpenChange={(open) => { if (!open) setEnding(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>End billing for {ending?.description}</DialogTitle>
          </DialogHeader>
          {ending && (
            <div className="space-y-4 py-2">
              <div>
                <Label htmlFor="addon-end">Last day billed <span className="text-destructive">*</span></Label>
                <Input
                  id="addon-end"
                  type="date"
                  value={endDate}
                  min={ending.effective_from}
                  max={contractEndDate}
                  onChange={e => setEndDate(e.target.value)}
                  className="mt-1"
                />
              </div>
              <div>
                <Label htmlFor="addon-end-reason">Why, and who asked <span className="text-destructive">*</span></Label>
                <Textarea
                  id="addon-end-reason"
                  value={endReason}
                  onChange={e => setEndReason(e.target.value)}
                  placeholder="e.g. Customer gave up the slot, email of 9 Jan"
                  className="mt-1"
                />
                <p className="text-xs text-muted-foreground mt-1">Kept in the audit trail. At least {MIN_END_REASON_LENGTH} characters.</p>
              </div>
              <p className="text-xs text-muted-foreground bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                Billing stops after this day and the last month is pro-rated by day. Invoices already sent are not changed; if any cover days after this date, you will be told which. To pause and resume later instead, use the switch.
              </p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEnding(null)}>Cancel</Button>
            <Button onClick={handleEndBilling} disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              End billing
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
