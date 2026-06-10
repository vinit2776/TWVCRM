"use client";

/**
 * UsageReviewDialog
 *
 * Pre-send review step for usage proformas. Shows all line items grouped by
 * type. Admin / manager can waive (→ ₹0 on PI) or adjust individual items
 * before confirming dispatch. Overrides are transient — applied at confirm time.
 *
 * Also embeds an inline Print Log section (visible when the contract has print
 * services configured). This replaces the previous dialog-swap pattern where
 * clicking "Log Print" would close this dialog and open a separate one.
 *
 * Waived items appear on the PI at ₹0 with the reason for internal reference.
 */

import { useState, useMemo, useEffect, useCallback } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Loader2, Send, X, Pencil, Plus, Printer, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────

interface LineItem {
  description: string;
  amount: number;
  source: "ad_hoc" | "service";
  item_id: string;
}

export interface UsageReviewRow {
  contract_id: string;
  contract_number: string;
  customer: string;
  billing_mode?: string | null;
  tax_percentage: number;
  line_items: LineItem[];
  paid_total: number;
  has_print_quota?: boolean;
  statement: { id: string; total_amount: number } | null;
}

interface Override {
  amount: number;
  reason: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  row: UsageReviewRow | null;
  year: number;
  month: number;
  userRole: string | null;
  onSuccess: () => void;
  /** Called after print is saved inline — parent can refresh usage rows if needed */
  onPrintSaved?: () => void | Promise<void>;
}

const SOURCE_LABELS: Record<string, string> = {
  ad_hoc: "Ad-hoc",
  service: "Service / Print",
};

const canEdit = (role: string | null) => role === "admin" || role === "manager";

// ── Component ─────────────────────────────────────────────────────────────────

export function UsageReviewDialog({ open, onOpenChange, row, year, month, userRole, onSuccess, onPrintSaved }: Props) {
  // key = `${source}:${item_id}`
  const [overrides, setOverrides] = useState<Map<string, Override>>(new Map());
  // Which item is in "adjust" editing mode
  const [editing, setEditing] = useState<string | null>(null);
  const [editAmount, setEditAmount] = useState("");
  const [editReason, setEditReason] = useState("");
  const [sending, setSending] = useState(false);
  const [savingWaiveKey, setSavingWaiveKey] = useState<string | null>(null);

  // Local copy of line items — seeded from prop, extended when charges are added
  const [localItems, setLocalItems] = useState<LineItem[]>(row?.line_items ?? []);
  useEffect(() => { setLocalItems(row?.line_items ?? []); }, [row]);

  // Add-charge form state
  const [showAddCharge, setShowAddCharge] = useState(false);
  const [addDesc, setAddDesc] = useState("");
  const [addQty, setAddQty] = useState<number>(1);
  const [addUnitPrice, setAddUnitPrice] = useState<number>(0);
  const [addDate, setAddDate] = useState<string>("");
  const [addNotes, setAddNotes] = useState("");
  const [savingCharge, setSavingCharge] = useState(false);

  const addTotal = Math.round(addQty * addUnitPrice);

  // ── Print log state ─────────────────────────────────────────────────────────
  const [printBwUsed, setPrintBwUsed]         = useState("");
  const [printColourUsed, setPrintColourUsed] = useState("");
  const [printNotes, setPrintNotes]           = useState("");
  const [printLoading, setPrintLoading]       = useState(false);
  const [printSaving, setPrintSaving]         = useState(false);
  const [printExisting, setPrintExisting]     = useState(false);
  const [printSaved, setPrintSaved]           = useState(false);
  const [printBwQuota, setPrintBwQuota]       = useState<number | null>(null);
  const [printColourQuota, setPrintColourQuota] = useState<number | null>(null);
  const [printBwRate, setPrintBwRate]         = useState(0);
  const [printColourRate, setPrintColourRate] = useState(0);

  // ── Print derived values ────────────────────────────────────────────────────
  const printBwParsed     = parseFloat(printBwUsed)     || 0;
  const printColourParsed = parseFloat(printColourUsed) || 0;
  const printBwOverage     = Math.max(0, printBwParsed     - (printBwQuota ?? 0));
  const printColourOverage = Math.max(0, printColourParsed - (printColourQuota ?? 0));
  const printBwAmount     = parseFloat((printBwOverage     * printBwRate).toFixed(2));
  const printColourAmount = parseFloat((printColourOverage * printColourRate).toFixed(2));

  const editable = canEdit(userRole);

  // ── Reset state when dialog opens/closes ───────────────────────────────────
  const handleOpenChange = (v: boolean) => {
    if (!v) {
      setOverrides(new Map());
      setEditing(null);
      setEditAmount("");
      setEditReason("");
      setShowAddCharge(false);
      setAddDesc("");
      setAddQty(1);
      setAddUnitPrice(0);
      setAddNotes("");
      // Reset print state
      setPrintBwUsed("");
      setPrintColourUsed("");
      setPrintNotes("");
      setPrintExisting(false);
      setPrintSaved(false);
      setPrintBwQuota(null);
      setPrintColourQuota(null);
      setPrintBwRate(0);
      setPrintColourRate(0);
    }
    onOpenChange(v);
  };

  // ── Fetch existing print data when dialog opens ─────────────────────────────
  // This pre-fills B&W / Colour inputs if the contract already has a manual
  // entry for this period. Works for contracts with and without quota rows.
  useEffect(() => {
    if (!open || !row) return;

    setPrintLoading(true);
    Promise.all([
      fetch(`/api/contracts/${row.contract_id}/quotas`).then(r => r.json()),
      fetch(`/api/accounting/print-usage?contract_id=${row.contract_id}&period_year=${year}&period_month=${month}`)
        .then(r => r.json()),
    ])
      .then(([quotaJson, existingJson]) => {
        const allQuotas: Array<{
          service_id: string;
          monthly_quota: number;
          overage_rate: number;
          service?: { printer_column: string | null };
        }> = quotaJson.data || [];

        const bwQ  = allQuotas.find(q => q.service?.printer_column === "bw");
        const colQ = allQuotas.find(q => q.service?.printer_column === "colour");

        const cats = existingJson.catalogRates ?? { bw: 0, colour: 0 };
        setPrintBwQuota(bwQ?.monthly_quota ?? null);
        setPrintColourQuota(colQ?.monthly_quota ?? null);
        setPrintBwRate(bwQ?.overage_rate ?? cats.bw ?? 0);
        setPrintColourRate(colQ?.overage_rate ?? cats.colour ?? 0);

        // Each record now carries printer_column directly (enriched by the API)
        // so pre-fill works even for contracts with no quota rows.
        const data: Array<{ printer_column: string | null; quantity_used: number }> =
          existingJson.data || [];

        const bwEntry  = data.find(e => e.printer_column === "bw");
        const colEntry = data.find(e => e.printer_column === "colour");
        if (bwEntry)  setPrintBwUsed(String(bwEntry.quantity_used));
        if (colEntry) setPrintColourUsed(String(colEntry.quantity_used));
        setPrintExisting(data.length > 0);
      })
      .catch(() => { /* non-critical — print section still usable */ })
      .finally(() => setPrintLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, row?.contract_id, year, month]);

  // ── Add-charge handler ──────────────────────────────────────────────────────

  const saveCharge = async () => {
    if (!row) return;
    if (!addDesc.trim()) { toast.error("Description is required"); return; }
    if (addQty <= 0) { toast.error("Quantity must be positive"); return; }
    if (addUnitPrice < 0) { toast.error("Unit price must be ≥ 0"); return; }
    if (!addDate) { toast.error("Charge date is required"); return; }

    setSavingCharge(true);
    try {
      const res = await fetch("/api/usage-charges", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contract_id: row.contract_id,
          description: addDesc.trim(),
          quantity: addQty,
          unit_price: addUnitPrice,
          total: addTotal,
          charge_date: addDate,
          notes: addNotes.trim() || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to add charge");

      // Append to local items so it appears immediately in the review list
      setLocalItems((prev) => [
        ...prev,
        { description: addDesc.trim(), amount: addTotal, source: "ad_hoc" as const, item_id: json.data.id },
      ]);
      toast.success("Charge added");
      setShowAddCharge(false);
      setAddDesc("");
      setAddQty(1);
      setAddUnitPrice(0);
      setAddNotes("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to add charge");
    } finally {
      setSavingCharge(false);
    }
  };

  // ── Save print handler ──────────────────────────────────────────────────────

  const savePrint = useCallback(async () => {
    if (!row) return;
    if (printBwParsed === 0 && printColourParsed === 0) {
      toast.error("Enter at least B&W or Colour page count");
      return;
    }
    setPrintSaving(true);
    try {
      const res = await fetch("/api/accounting/print-usage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contract_id:  row.contract_id,
          period_year:  year,
          period_month: month,
          bw_used:      printBwParsed,
          colour_used:  printColourParsed,
          notes:        printNotes.trim() || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to save");

      toast.success("Print usage saved");
      setPrintSaved(true);
      setPrintExisting(true);
      onPrintSaved?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save print usage");
    } finally {
      setPrintSaving(false);
    }
  }, [row, year, month, printBwParsed, printColourParsed, printNotes, onPrintSaved]);

  // ── Derived totals ──────────────────────────────────────────────────────────

  const items = localItems;

  const effectiveItems = useMemo(() => items.map((li) => {
    const key = `${li.source}:${li.item_id}`;
    const ov = overrides.get(key);
    return { ...li, effective_amount: ov !== undefined ? ov.amount : li.amount, override: ov };
  }), [items, overrides]);

  const effectiveTotal = useMemo(
    () => effectiveItems.reduce((sum, li) => sum + li.effective_amount, 0),
    [effectiveItems],
  );

  const originalTotal = useMemo(
    () => items.reduce((sum, li) => sum + li.amount, 0),
    [items],
  );

  const delta = effectiveTotal - originalTotal;

  // ── Override handlers ───────────────────────────────────────────────────────

  const startEdit = (li: typeof effectiveItems[0]) => {
    const key = `${li.source}:${li.item_id}`;
    setEditing(key);
    setEditAmount(String(li.override?.amount ?? li.amount));
    setEditReason(li.override?.reason ?? "");
  };

  const commitEdit = async (key: string) => {
    const parsed = parseFloat(editAmount);
    if (isNaN(parsed) || parsed < 0) { toast.error("Enter a valid amount (≥ 0)"); return; }
    if (!editReason.trim()) { toast.error("Reason is required"); return; }

    const [source, item_id] = key.split(/:(.+)/);

    // Persist waive to DB immediately for ad_hoc charges (amount=0 only).
    // This marks the usage_charge as waived so it's excluded from future PI
    // generation — the user doesn't need to go through Confirm & Send.
    if (parsed === 0 && source === "ad_hoc") {
      setSavingWaiveKey(key);
      try {
        const res = await fetch(`/api/usage-charges/${item_id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "waived", waive_reason: editReason.trim() }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "Failed to waive charge");
        // Remove the charge from local list — it's gone from billing permanently
        setLocalItems((prev) => prev.filter((li) => !(li.source === "ad_hoc" && li.item_id === item_id)));
        setOverrides((prev) => { const next = new Map(prev); next.delete(key); return next; });
        toast.success("Charge waived");
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to waive charge");
        return;
      } finally {
        setSavingWaiveKey(null);
      }
      setEditing(null);
      setEditAmount("");
      setEditReason("");
      return;
    }

    // All other cases (adjustments, service overrides) remain transient —
    // applied to the PI at Confirm & Send time.
    setOverrides((prev) => new Map(prev).set(key, { amount: Math.round(parsed), reason: editReason.trim() }));
    setEditing(null);
    setEditAmount("");
    setEditReason("");
  };

  const waiveItem = (li: typeof effectiveItems[0]) => {
    const key = `${li.source}:${li.item_id}`;
    if (editing === key) { setEditing(null); }
    setEditing(key);
    setEditAmount("0");
    setEditReason("");
  };

  const restoreItem = (key: string) => {
    setOverrides((prev) => { const next = new Map(prev); next.delete(key); return next; });
    if (editing === key) setEditing(null);
  };

  // ── Confirm & Send ──────────────────────────────────────────────────────────

  const confirmAndSend = async () => {
    if (!row) return;
    if (effectiveTotal <= 0) {
      toast.error("Total is ₹0 after adjustments — nothing to bill. Waive all items or cancel.");
      return;
    }

    const overridePayload = Array.from(overrides.entries()).map(([key, ov]) => {
      const [source, item_id] = key.split(/:(.+)/); // split on first colon only
      return { source, item_id, amount: ov.amount, reason: ov.reason };
    });

    setSending(true);
    try {
      const res = await fetch("/api/billing/usage-finalize-and-send-for-contract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contract_id: row.contract_id,
          year,
          month,
          overrides: overridePayload,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed");

      if (json.all_waived) {
        toast.success("All charges waived — no invoice sent");
      } else {
        toast.success(
          json.no_contact
            ? "Finalized — customer has no contact info; proforma was NOT sent"
            : `Sent to ${json.emailed_to || "customer"}`,
        );
      }
      handleOpenChange(false);
      onSuccess();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to send");
    } finally {
      setSending(false);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  if (!row) return null;

  const paidItems  = effectiveItems.filter((li) => li.amount > 0 || (li.override !== undefined));
  const freeItems  = effectiveItems.filter((li) => li.amount <= 0 && li.override === undefined);
  const showPrintSection = row.has_print_quota || printExisting;
  // All chargeable items explicitly waived → no invoice, but still a valid action
  const allWaived = paidItems.length > 0 && effectiveTotal <= 0 && overrides.size > 0;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            Review Usage &amp; {row.billing_mode === "gst_direct" ? "Send GST Invoice" : "Send PI"}
            <span className="text-muted-foreground font-normal text-sm">
              — {row.contract_number} · {row.customer}
            </span>
          </DialogTitle>
        </DialogHeader>

        {row.billing_mode === "gst_direct" && (
          <div className="rounded-md border border-violet-200 bg-violet-50 px-4 py-2.5 text-xs text-violet-800">
            <span className="font-semibold">GST Direct contract</span>
            {" "}— confirming will issue a <strong>Tax Invoice immediately</strong>. No proforma step.
            The invoice number and IRN will be generated and emailed to the customer right away.
          </div>
        )}

        <div className="flex-1 overflow-y-auto space-y-4 pr-1">

          {/* Chargeable items */}
          {paidItems.length > 0 && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Chargeable items</p>
              <div className="rounded-md border divide-y text-sm">
                {paidItems.map((li) => {
                  const key = `${li.source}:${li.item_id}`;
                  const isEditing = editing === key;
                  const isWaived  = li.override?.amount === 0;
                  const isAdjusted = li.override !== undefined && li.override.amount > 0;

                  return (
                    <div key={key} className="px-3 py-2.5 space-y-1.5">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className={isWaived ? "line-through text-muted-foreground" : ""}>{li.description}</span>
                            <span className="text-[10px] text-muted-foreground border rounded px-1 py-0.5">{SOURCE_LABELS[li.source] ?? li.source}</span>
                            {isWaived   && <Badge className="bg-red-50 text-red-700 border-red-200 text-[10px]">WAIVED</Badge>}
                            {isAdjusted && <Badge className="bg-blue-50 text-blue-700 border-blue-200 text-[10px]">ADJUSTED</Badge>}
                          </div>
                          {li.override && (
                            <p className="text-[11px] text-muted-foreground mt-0.5 italic">Reason: {li.override.reason}</p>
                          )}
                        </div>
                        <div className="text-right shrink-0">
                          {li.override !== undefined ? (
                            <div className="space-y-0.5">
                              <div className="text-muted-foreground line-through text-xs">{formatCurrency(li.amount)}</div>
                              <div className={`font-semibold ${isWaived ? "text-red-600" : "text-blue-700"}`}>{formatCurrency(li.effective_amount)}</div>
                            </div>
                          ) : (
                            <span className="font-semibold">{formatCurrency(li.amount)}</span>
                          )}
                        </div>
                      </div>

                      {/* Inline edit row */}
                      {isEditing && (
                        <div className="flex items-center gap-2 mt-1.5 bg-muted/40 rounded p-2">
                          <div className="flex-1 flex items-center gap-2">
                            <span className="text-xs text-muted-foreground whitespace-nowrap">Amount (₹)</span>
                            <Input
                              type="number" min="0" step="1" className="h-7 w-28 text-sm"
                              value={editAmount}
                              onChange={(e) => setEditAmount(e.target.value)}
                              autoFocus
                            />
                            <Input
                              type="text" className="h-7 flex-1 text-sm"
                              placeholder="Reason (required)"
                              value={editReason}
                              onChange={(e) => setEditReason(e.target.value)}
                              onKeyDown={(e) => { if (e.key === "Enter") void commitEdit(key); }}
                            />
                          </div>
                          <Button size="sm" className="h-7 px-3" onClick={() => commitEdit(key)} disabled={savingWaiveKey === key}>
                            {savingWaiveKey === key ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
                          </Button>
                          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setEditing(null)} disabled={savingWaiveKey === key}><X className="h-3.5 w-3.5" /></Button>
                        </div>
                      )}

                      {/* Action buttons — admin/manager only */}
                      {editable && !isEditing && (
                        <div className="flex items-center gap-2">
                          {li.override !== undefined ? (
                            <button
                              className="text-[11px] text-muted-foreground hover:text-foreground underline underline-offset-2"
                              onClick={() => restoreItem(key)}
                            >
                              Restore original
                            </button>
                          ) : (
                            <>
                              <button
                                className="text-[11px] text-red-600 hover:text-red-800 underline underline-offset-2"
                                onClick={() => waiveItem(li)}
                              >
                                Waive
                              </button>
                              <span className="text-muted-foreground text-[11px]">·</span>
                              <button
                                className="text-[11px] text-blue-600 hover:text-blue-800 underline underline-offset-2 flex items-center gap-1"
                                onClick={() => startEdit(li)}
                              >
                                <Pencil className="h-2.5 w-2.5" />Adjust
                              </button>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Free items */}
          {freeItems.length > 0 && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Within free quota (₹0)</p>
              <div className="rounded-md border divide-y text-sm bg-muted/20">
                {freeItems.map((li) => (
                  <div key={`${li.source}:${li.item_id}`} className="px-3 py-2 flex items-center justify-between text-muted-foreground">
                    <span>{li.description}</span>
                    <span className="text-xs">₹0</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {items.length === 0 && !showAddCharge && !showPrintSection && (
            <p className="text-sm text-muted-foreground text-center py-6">No usage items found for this contract.</p>
          )}

          {/* ── Inline Print Log section ──────────────────────────────────── */}
          {/* Shown when the contract has print services configured or already  */}
          {/* has a manual entry for this period. Pre-filled from the API.      */}
          {showPrintSection && (
            <div className="rounded-md border border-amber-200 bg-amber-50/40 p-3 space-y-3">
              <div className="flex items-center gap-2">
                <Printer className="h-3.5 w-3.5 text-amber-700" />
                <p className="text-xs font-semibold text-amber-800">
                  Print Log
                </p>
                {printSaved && (
                  <Badge className="ml-auto bg-green-50 text-green-700 border-green-200 text-[10px]">Saved ✓</Badge>
                )}
                {printExisting && !printSaved && (
                  <Badge className="ml-auto bg-amber-100 text-amber-700 border-amber-300 text-[10px]">Entry exists</Badge>
                )}
              </div>

              {printLoading ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" /> Loading existing entry…
                </div>
              ) : (
                <>
                  {printExisting && !printSaved && (
                    <div className="flex items-start gap-1.5 text-[11px] text-amber-700">
                      <AlertCircle className="h-3 w-3 mt-0.5 shrink-0" />
                      <span>Existing entry found — submitting will replace it.</span>
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-3">
                    {/* B&W */}
                    <div>
                      <Label className="text-xs">
                        B&amp;W Pages
                        {printBwQuota !== null ? (
                          <span className="ml-1 font-normal text-muted-foreground">
                            (quota: {printBwQuota.toLocaleString()})
                          </span>
                        ) : printBwRate > 0 ? (
                          <span className="ml-1 font-normal text-muted-foreground">
                            ({formatCurrency(printBwRate)}/pg)
                          </span>
                        ) : null}
                      </Label>
                      <Input
                        type="number" min="0" step="1" placeholder="0"
                        value={printBwUsed}
                        onChange={e => setPrintBwUsed(e.target.value)}
                        className="mt-1 h-7 text-sm"
                        disabled={printSaving}
                      />
                      {printBwParsed > 0 && printBwRate > 0 && (
                        <p className="text-[11px] mt-0.5 text-muted-foreground">
                          {printBwQuota !== null ? (
                            <span className={printBwOverage > 0 ? "text-red-600 font-medium" : "text-green-700"}>
                              {printBwOverage > 0
                                ? `${printBwOverage.toLocaleString()} overage → ${formatCurrency(printBwAmount)}`
                                : "within quota"}
                            </span>
                          ) : (
                            <span className="text-red-600 font-medium">
                              {printBwParsed.toLocaleString()} pages → {formatCurrency(printBwAmount)}
                            </span>
                          )}
                        </p>
                      )}
                    </div>

                    {/* Colour */}
                    <div>
                      <Label className="text-xs">
                        Colour Pages
                        {printColourQuota !== null ? (
                          <span className="ml-1 font-normal text-muted-foreground">
                            (quota: {printColourQuota.toLocaleString()})
                          </span>
                        ) : printColourRate > 0 ? (
                          <span className="ml-1 font-normal text-muted-foreground">
                            ({formatCurrency(printColourRate)}/pg)
                          </span>
                        ) : null}
                      </Label>
                      <Input
                        type="number" min="0" step="1" placeholder="0"
                        value={printColourUsed}
                        onChange={e => setPrintColourUsed(e.target.value)}
                        className="mt-1 h-7 text-sm"
                        disabled={printSaving}
                      />
                      {printColourParsed > 0 && printColourRate > 0 && (
                        <p className="text-[11px] mt-0.5 text-muted-foreground">
                          {printColourQuota !== null ? (
                            <span className={printColourOverage > 0 ? "text-red-600 font-medium" : "text-green-700"}>
                              {printColourOverage > 0
                                ? `${printColourOverage.toLocaleString()} overage → ${formatCurrency(printColourAmount)}`
                                : "within quota"}
                            </span>
                          ) : (
                            <span className="text-red-600 font-medium">
                              {printColourParsed.toLocaleString()} pages → {formatCurrency(printColourAmount)}
                            </span>
                          )}
                        </p>
                      )}
                    </div>
                  </div>

                  <Input
                    placeholder="Notes (optional)"
                    value={printNotes}
                    onChange={e => setPrintNotes(e.target.value)}
                    className="h-7 text-sm"
                    disabled={printSaving}
                  />

                  <div className="flex justify-end">
                    <Button
                      size="sm"
                      className="h-7 bg-amber-600 hover:bg-amber-700 text-white"
                      onClick={savePrint}
                      disabled={printSaving || (printBwParsed + printColourParsed === 0)}
                    >
                      {printSaving
                        ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        : printExisting && !printSaved ? "Update Print" : "Save Print"}
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Add Charge */}
          {editable && (
            <div>
              {!showAddCharge ? (
                <button
                  className="flex items-center gap-1.5 text-xs text-teal-700 hover:text-teal-900 font-medium"
                  onClick={() => {
                    setAddDate(new Date().toISOString().split("T")[0]);
                    setShowAddCharge(true);
                  }}
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add charge
                </button>
              ) : (
                <div className="rounded-md border border-teal-200 bg-teal-50/50 p-3 space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold text-teal-800">New charge</p>
                    <button onClick={() => setShowAddCharge(false)} className="text-muted-foreground hover:text-foreground">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  {/* Description */}
                  <Input
                    placeholder="Description (e.g. Extra printing, Pantry setup, IT support)"
                    value={addDesc}
                    onChange={(e) => setAddDesc(e.target.value)}
                    className="h-8 text-sm"
                  />

                  {/* Qty × Unit Price row */}
                  <div className="flex items-center gap-2">
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className="text-xs text-muted-foreground whitespace-nowrap">Qty</span>
                      <Input
                        type="number" min="1" step="1"
                        className="h-8 w-20 text-sm"
                        value={addQty}
                        onChange={(e) => setAddQty(Math.max(1, Number(e.target.value)))}
                      />
                    </div>
                    <span className="text-muted-foreground text-sm">×</span>
                    <div className="flex items-center gap-1.5 flex-1">
                      <span className="text-xs text-muted-foreground whitespace-nowrap">Unit ₹</span>
                      <Input
                        type="number" min="0" step="1"
                        className="h-8 flex-1 text-sm"
                        value={addUnitPrice}
                        onChange={(e) => setAddUnitPrice(Math.max(0, Number(e.target.value)))}
                      />
                    </div>
                    <div className="text-sm font-semibold text-right shrink-0 min-w-[70px]">
                      {formatCurrency(addTotal)}
                    </div>
                  </div>

                  {/* Date + Notes row */}
                  <div className="flex items-center gap-2">
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className="text-xs text-muted-foreground whitespace-nowrap">Date</span>
                      <Input
                        type="date"
                        className="h-8 text-sm w-36"
                        value={addDate}
                        onChange={(e) => setAddDate(e.target.value)}
                      />
                    </div>
                    <Input
                      placeholder="Notes (optional)"
                      value={addNotes}
                      onChange={(e) => setAddNotes(e.target.value)}
                      className="h-8 text-sm flex-1"
                    />
                  </div>

                  <p className="text-[11px] text-muted-foreground">
                    GST will be calculated at the contract rate when the statement is generated.
                  </p>

                  <div className="flex justify-end gap-2">
                    <Button variant="outline" size="sm" className="h-7" onClick={() => setShowAddCharge(false)} disabled={savingCharge}>
                      Cancel
                    </Button>
                    <Button
                      size="sm" className="h-7 bg-teal-700 hover:bg-teal-800"
                      onClick={saveCharge}
                      disabled={savingCharge || !addDesc.trim() || addTotal < 0}
                    >
                      {savingCharge ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save charge"}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Totals summary — show full GST breakdown so operator knows exactly what gets sent */}
          {items.length > 0 && (() => {
            const taxRate    = row.tax_percentage ?? 18;
            const taxAmount  = parseFloat((effectiveTotal * taxRate / 100).toFixed(2));
            const grandTotal = parseFloat((effectiveTotal + taxAmount).toFixed(2));
            const cgst       = parseFloat((taxAmount / 2).toFixed(2));
            const sgst       = parseFloat((taxAmount / 2).toFixed(2));

            return (
              <div className="rounded-md border bg-muted/30 px-4 py-3 space-y-1.5 text-sm">
                {delta !== 0 && (
                  <div className={`flex justify-between text-xs ${delta < 0 ? "text-red-600" : "text-blue-600"}`}>
                    <span>Original total</span>
                    <span>{formatCurrency(originalTotal)}</span>
                  </div>
                )}
                {delta !== 0 && (
                  <div className={`flex justify-between text-xs ${delta < 0 ? "text-red-600" : "text-blue-600"}`}>
                    <span>Adjustments</span>
                    <span>{delta < 0 ? "−" : "+"}{formatCurrency(Math.abs(delta))}</span>
                  </div>
                )}
                <div className="flex justify-between text-muted-foreground">
                  <span>Subtotal (ex-GST)</span>
                  <span className={effectiveTotal <= 0 ? "text-red-600" : ""}>{formatCurrency(effectiveTotal)}</span>
                </div>
                {effectiveTotal > 0 && (
                  <>
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>CGST ({taxRate / 2}%)</span>
                      <span>{formatCurrency(cgst)}</span>
                    </div>
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>SGST ({taxRate / 2}%)</span>
                      <span>{formatCurrency(sgst)}</span>
                    </div>
                    <div className="flex justify-between font-bold border-t pt-1.5 mt-0.5 text-base">
                      <span>Total (payment link amount)</span>
                      <span className="text-teal-700">{formatCurrency(grandTotal)}</span>
                    </div>
                  </>
                )}
                {effectiveTotal <= 0 && (
                  <p className="text-xs text-red-600">Nothing to bill — total is ₹0 after adjustments.</p>
                )}
              </div>
            );
          })()}
        </div>

        {allWaived && (
          <div className="mx-0 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 flex items-center gap-2">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            All charges have been waived — no invoice will be sent this month.
          </div>
        )}

        <DialogFooter className="mt-3 border-t pt-3 gap-2 flex-wrap">
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={sending}>Cancel</Button>
          {allWaived ? (
            <Button
              onClick={confirmAndSend}
              disabled={sending}
              className="bg-amber-600 hover:bg-amber-700"
            >
              {sending
                ? <><Loader2 className="h-4 w-4 animate-spin mr-2" />Saving…</>
                : <><Send className="h-4 w-4 mr-2" />Confirm Waivers (No Invoice)</>}
            </Button>
          ) : (
            <Button
              onClick={confirmAndSend}
              disabled={sending || effectiveTotal <= 0 || items.length === 0}
              className={row.billing_mode === "gst_direct" ? "bg-violet-700 hover:bg-violet-800" : "bg-teal-700 hover:bg-teal-800"}
              title={effectiveTotal <= 0 ? "Nothing to bill after adjustments" : undefined}
            >
              {sending
                ? <><Loader2 className="h-4 w-4 animate-spin mr-2" />Sending…</>
                : row.billing_mode === "gst_direct"
                  ? <><Send className="h-4 w-4 mr-2" />Confirm &amp; Issue GST Invoice</>
                  : <><Send className="h-4 w-4 mr-2" />Confirm &amp; Send PI</>}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
