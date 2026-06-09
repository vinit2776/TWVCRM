"use client";

/**
 * UsageReviewDialog
 *
 * Pre-send review step for usage proformas. Shows all line items grouped by
 * type. Admin / manager can waive (→ ₹0 on PI) or adjust individual items
 * before confirming dispatch. Overrides are transient — applied at confirm time.
 *
 * Waived items appear on the PI at ₹0 with the reason for internal reference.
 */

import { useState, useMemo, useEffect } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Loader2, Send, X, Pencil, Plus, Printer } from "lucide-react";
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
  /** Called when user clicks "Log Print" — parent should close this dialog and open ManualPrintEntryDialog */
  onLogPrint?: () => void;
}

const SOURCE_LABELS: Record<string, string> = {
  ad_hoc: "Ad-hoc",
  service: "Service / Print",
};

const canEdit = (role: string | null) => role === "admin" || role === "manager";

// ── Component ─────────────────────────────────────────────────────────────────

export function UsageReviewDialog({ open, onOpenChange, row, year, month, userRole, onSuccess, onLogPrint }: Props) {
  // key = `${source}:${item_id}`
  const [overrides, setOverrides] = useState<Map<string, Override>>(new Map());
  // Which item is in "adjust" editing mode
  const [editing, setEditing] = useState<string | null>(null);
  const [editAmount, setEditAmount] = useState("");
  const [editReason, setEditReason] = useState("");
  const [sending, setSending] = useState(false);

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

  const editable = canEdit(userRole);

  // Reset state when dialog opens/closes
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
    }
    onOpenChange(v);
  };

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

  const commitEdit = (key: string) => {
    const parsed = parseFloat(editAmount);
    if (isNaN(parsed) || parsed < 0) { toast.error("Enter a valid amount (≥ 0)"); return; }
    if (!editReason.trim()) { toast.error("Reason is required"); return; }
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

      toast.success(
        json.no_contact
          ? "Finalized — customer has no contact info; proforma was NOT sent"
          : `Sent to ${json.emailed_to || "customer"}`,
      );
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
                              onKeyDown={(e) => { if (e.key === "Enter") commitEdit(key); }}
                            />
                          </div>
                          <Button size="sm" className="h-7 px-3" onClick={() => commitEdit(key)}>Save</Button>
                          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setEditing(null)}><X className="h-3.5 w-3.5" /></Button>
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

          {items.length === 0 && !showAddCharge && (
            <p className="text-sm text-muted-foreground text-center py-6">No usage items found for this contract.</p>
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

          {/* Totals summary */}
          {items.length > 0 && (
            <div className="rounded-md border bg-muted/30 px-4 py-3 space-y-1 text-sm">
              <div className="flex justify-between text-muted-foreground">
                <span>Original total</span>
                <span>{formatCurrency(originalTotal)}</span>
              </div>
              {delta !== 0 && (
                <div className={`flex justify-between text-xs ${delta < 0 ? "text-red-600" : "text-blue-600"}`}>
                  <span>Adjustments</span>
                  <span>{delta < 0 ? "−" : "+"}{formatCurrency(Math.abs(delta))}</span>
                </div>
              )}
              <div className="flex justify-between font-semibold border-t pt-1 mt-1">
                <span>Amount to bill (ex-GST)</span>
                <span className={effectiveTotal <= 0 ? "text-red-600" : ""}>{formatCurrency(effectiveTotal)}</span>
              </div>
              <p className="text-[11px] text-muted-foreground">GST will be calculated and added by the system at dispatch.</p>
            </div>
          )}
        </div>

        <DialogFooter className="mt-3 border-t pt-3 gap-2 flex-wrap">
          {/* Log Print — left-side secondary action, only when contract has print quota */}
          {row.has_print_quota && onLogPrint && (
            <Button
              variant="outline"
              size="sm"
              className="mr-auto border-amber-400 text-amber-700 hover:bg-amber-50"
              onClick={() => { handleOpenChange(false); onLogPrint(); }}
              disabled={sending}
            >
              <Printer className="h-3.5 w-3.5 mr-1.5" />Log Print
            </Button>
          )}
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={sending}>Cancel</Button>
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
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
