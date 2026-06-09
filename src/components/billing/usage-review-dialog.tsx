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

import { useState, useMemo } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Loader2, Send, X, Pencil } from "lucide-react";
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
  line_items: LineItem[];
  paid_total: number;
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
}

const SOURCE_LABELS: Record<string, string> = {
  ad_hoc: "Ad-hoc",
  service: "Service / Print",
};

const canEdit = (role: string | null) => role === "admin" || role === "manager";

// ── Component ─────────────────────────────────────────────────────────────────

export function UsageReviewDialog({ open, onOpenChange, row, year, month, userRole, onSuccess }: Props) {
  // key = `${source}:${item_id}`
  const [overrides, setOverrides] = useState<Map<string, Override>>(new Map());
  // Which item is in "adjust" editing mode
  const [editing, setEditing] = useState<string | null>(null);
  const [editAmount, setEditAmount] = useState("");
  const [editReason, setEditReason] = useState("");
  const [sending, setSending] = useState(false);

  const editable = canEdit(userRole);

  // Reset state when dialog opens/closes
  const handleOpenChange = (v: boolean) => {
    if (!v) {
      setOverrides(new Map());
      setEditing(null);
      setEditAmount("");
      setEditReason("");
    }
    onOpenChange(v);
  };

  // ── Derived totals ──────────────────────────────────────────────────────────

  const items = row?.line_items ?? [];

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
            Review Usage &amp; Send PI
            <span className="text-muted-foreground font-normal text-sm">
              — {row.contract_number} · {row.customer}
            </span>
          </DialogTitle>
        </DialogHeader>

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

          {items.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-6">No usage items found for this contract.</p>
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

        <DialogFooter className="mt-3 border-t pt-3 gap-2">
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={sending}>Cancel</Button>
          <Button
            onClick={confirmAndSend}
            disabled={sending || effectiveTotal <= 0 || items.length === 0}
            className="bg-teal-700 hover:bg-teal-800"
            title={effectiveTotal <= 0 ? "Nothing to bill after adjustments" : undefined}
          >
            {sending
              ? <><Loader2 className="h-4 w-4 animate-spin mr-2" />Sending…</>
              : <><Send className="h-4 w-4 mr-2" />Confirm &amp; Send PI</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
