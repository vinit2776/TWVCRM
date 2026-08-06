"use client";

/**
 * TransactionSummary — the single money view for a booking.
 *
 * Consolidates what used to be spread across four places (the Financials
 * card's total block, the "Related Charges" card, the add-ons subtotal and
 * the payment banner) into one ordered breakdown:
 *
 *   Room booking → facilities → over-use/overage → overtime → other charges
 *   → subtotal (ex-GST) → GST → grand total → paid / balance
 *
 * Two things drive the shape of this component:
 *
 * 1. Waived rows are lossy. Waiving zeroes unit_price/total/gst_amount/
 *    total_with_gst on usage_charges, so the live columns can't show what
 *    was written off. The pre-waive figure is snapshotted into
 *    original_* columns (migration 00388) — we render that struck through,
 *    with who approved it, and count the line as ₹0 toward the total.
 *
 * 2. GST is not recorded uniformly. The quota/overage charge created at
 *    booking time omits gst_rate/gst_amount entirely (they default to 0),
 *    while overtime charges and add-ons carry real GST. Rather than invent
 *    a rate, lines with no recorded GST are marked and surfaced under a
 *    "GST extra as applicable" note, and excluded from the GST line.
 */

import { formatCurrency, formatDateTime } from "@/lib/utils";
import type { Booking, BookingPayment } from "@/types";

/** A usage_charges row as returned by GET /api/usage-charges?booking_id= */
export interface TxnUsageCharge {
  id: string;
  description: string;
  quantity?: number | null;
  unit_price?: number | null;
  total?: number | null;
  gst_rate?: number | null;
  gst_amount?: number | null;
  total_with_gst?: number | null;
  status: string;
  booking_charge_kind?: string | null;
  waive_reason?: string | null;
  waived_at?: string | null;
  /** Human-readable approval reference, e.g. TWV-WV-0004 (migration 00389). */
  waiver_ref?: string | null;
  original_total?: number | null;
  original_gst_amount?: number | null;
  original_total_with_gst?: number | null;
  waived_by_user?: { id: string; full_name: string; role?: string } | null;
}

/** A booking_addons row as returned by GET /api/bookings/[id]/addons */
export interface TxnAddon {
  id: string;
  description?: string | null;
  addon_type?: string | null;
  quantity?: number | null;
  unit_price?: number | null;
  amount?: number | null;
  gst_rate?: number | null;
  gst_amount?: number | null;
  total_with_gst?: number | null;
}

interface Props {
  booking: Booking & { facilities?: { facility_name: string; charge: number; is_complimentary: boolean }[] };
  charges: TxnUsageCharge[];
  addons: TxnAddon[];
  payments: BookingPayment[];
}

/** One rendered row in the breakdown. */
interface Line {
  key: string;
  label: string;
  sub?: string;
  /** Billable amount excluding GST. Always 0 for waived lines. */
  net: number;
  /** GST on this line. 0 when the source row didn't record any. */
  gst: number;
  /** False when the row carries an amount but no GST was recorded. */
  gstKnown: boolean;
  waived?: {
    original: number;
    by?: string | null;
    role?: string | null;
    reason?: string | null;
    at?: string | null;
    ref?: string | null;
  };
  /** Informational only — carries no money into the totals. */
  info?: boolean;
}

function formatDuration(hours: number): string {
  if (hours <= 0) return "—";
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

const KIND_LABEL: Record<string, string> = {
  quota_overage: "Over-use",
  overtime: "Overtime",
};

export function TransactionSummary({ booking, charges, addons, payments }: Props) {
  const isContractHolder = booking.customer_type === "contract_holder";
  const lines: Line[] = [];

  // ── Room booking ──────────────────────────────────────────────────────
  // Contract holders are never collected against the booking row — their
  // money lives on the usage_charges below (quota / overage / overtime).
  // Showing booking.total_amount as billable here would double-count it,
  // so it's rendered as context only.
  const roomQty = booking.pricing_model === "daily" ? Number(booking.quantity ?? 1) : Number(booking.duration_hours || 0);
  const roomLabel =
    booking.pricing_model === "daily"
      ? `Day pass × ${roomQty}`
      : `Room · ${formatDuration(roomQty)}`;
  const roomNet = Number(booking.hourly_rate || 0) * roomQty;

  if (isContractHolder) {
    lines.push({
      key: "room",
      label: roomLabel,
      sub: "Billed through the contract — see charges below",
      net: 0,
      gst: 0,
      gstKnown: true,
      info: true,
    });
  } else {
    lines.push({
      key: "room",
      label: roomLabel,
      net: roomNet,
      gst: 0,
      gstKnown: true,
    });
    // Chargeable facilities are folded into booking.total_amount alongside
    // the room, so list them to make that number add up on screen.
    for (const f of booking.facilities || []) {
      const charge = Number(f.charge || 0);
      if (f.is_complimentary || charge <= 0) continue;
      lines.push({ key: `fac-${f.facility_name}`, label: f.facility_name, net: charge, gst: 0, gstKnown: true });
    }
  }

  // Walk-in GST sits on the booking row itself, not per line.
  const bookingGst = isContractHolder ? 0 : Number(booking.gst_amount || 0);

  // ── Usage charges (quota / over-use / overtime / ad-hoc) ──────────────
  for (const c of charges) {
    const isWaived = c.status === "waived";
    const originalNet = Number(c.original_total ?? 0);
    const originalGst = Number(c.original_gst_amount ?? 0);
    const net = isWaived ? 0 : Number(c.total ?? 0);
    const gst = isWaived ? 0 : Number(c.gst_amount ?? 0);

    // A within-quota row is a ₹0 informational marker, not a charge.
    const isFreeQuotaMarker = isWaived && originalNet === 0 && Number(c.total ?? 0) === 0 && !c.waived_by_user;
    const kind = c.booking_charge_kind ? KIND_LABEL[c.booking_charge_kind] : null;

    const qty = Number(c.quantity ?? 0);
    const rate = Number(c.unit_price ?? 0) || Number(c.original_total && qty ? originalNet / qty : 0);
    const sub = qty > 0 && rate > 0 ? `${qty} × ${formatCurrency(rate)}` : undefined;

    lines.push({
      key: `uc-${c.id}`,
      label: kind ? `${kind} — ${c.description}` : c.description,
      sub,
      net,
      gst,
      // Overage rows created at booking time record no GST at all.
      gstKnown: net === 0 || Number(c.gst_rate ?? 0) > 0,
      info: isFreeQuotaMarker,
      waived:
        isWaived && !isFreeQuotaMarker
          ? {
              original: originalNet + originalGst,
              by: c.waived_by_user?.full_name,
              role: c.waived_by_user?.role,
              reason: c.waive_reason,
              at: c.waived_at,
              ref: c.waiver_ref,
            }
          : undefined,
    });
  }

  // ── Add-ons (extended time, F&B, damages, services) ───────────────────
  for (const a of addons) {
    const net = Number(a.amount ?? 0);
    const gst = Number(a.gst_amount ?? 0);
    const qty = Number(a.quantity ?? 0);
    const rate = Number(a.unit_price ?? 0);
    lines.push({
      key: `ad-${a.id}`,
      label: a.description || "Additional charge",
      sub: qty > 0 && rate > 0 ? `${qty} × ${formatCurrency(rate)}` : undefined,
      net,
      gst,
      gstKnown: net === 0 || Number(a.gst_rate ?? 0) > 0,
    });
  }

  // ── Totals ────────────────────────────────────────────────────────────
  const subtotal = lines.reduce((s, l) => s + l.net, 0);
  const gstTotal = lines.reduce((s, l) => s + l.gst, 0) + bookingGst;
  const grandTotal = subtotal + gstTotal;

  const gstUnknownLines = lines.filter((l) => !l.gstKnown && l.net > 0);
  const hasGstCaveat = gstUnknownLines.length > 0;

  const paid = payments
    .filter((p) => p.status === "verified")
    .reduce((s, p) => s + Number(p.amount || 0), 0);
  const balance = grandTotal - paid;

  const totalWaived = lines.reduce((s, l) => s + (l.waived?.original ?? 0), 0);

  return (
    <div className="rounded-lg border overflow-hidden">
      <div className="px-4 py-2.5 bg-muted/40 border-b flex items-center justify-between">
        <h3 className="text-sm font-semibold">Transaction Summary</h3>
        {isContractHolder && (
          <span className="text-[11px] text-muted-foreground">
            Posted to the contract&apos;s monthly invoice
          </span>
        )}
      </div>

      <div className="divide-y">
        {lines.map((l) => (
          <div key={l.key} className="flex items-start justify-between gap-3 px-4 py-2">
            <div className="min-w-0">
              <p className={`text-sm ${l.info ? "text-muted-foreground" : ""} ${l.waived ? "line-through text-muted-foreground" : ""}`}>
                {l.label}
                {!l.gstKnown && l.net > 0 && <sup className="ml-0.5 text-amber-600">*</sup>}
              </p>
              {l.sub && <p className="text-xs text-muted-foreground">{l.sub}</p>}
              {l.waived && (
                <div className="mt-1 text-xs text-red-600 space-y-0.5">
                  <p>
                    {l.waived.ref && (
                      <span className="font-mono font-medium mr-1.5">{l.waived.ref}</span>
                    )}
                    Waived{l.waived.by ? ` by ${l.waived.by}` : ""}
                    {l.waived.role ? ` (${l.waived.role})` : ""}
                    {l.waived.at ? ` · ${formatDateTime(l.waived.at)}` : ""}
                  </p>
                  {l.waived.reason && <p className="italic">“{l.waived.reason}”</p>}
                </div>
              )}
            </div>
            <div className="shrink-0 text-right">
              {l.waived ? (
                <>
                  <p className="text-xs line-through text-muted-foreground">{formatCurrency(l.waived.original)}</p>
                  <p className="text-sm tabular-nums">{formatCurrency(0)}</p>
                </>
              ) : l.info ? (
                <p className="text-sm text-muted-foreground">—</p>
              ) : (
                <p className="text-sm tabular-nums">{formatCurrency(l.net)}</p>
              )}
            </div>
          </div>
        ))}

        {lines.length === 0 && (
          <div className="px-4 py-4 text-sm text-muted-foreground text-center">No charges on this booking.</div>
        )}
      </div>

      {/* Totals */}
      <div className="px-4 py-3 bg-muted/20 border-t space-y-1.5">
        <div className="flex justify-between text-sm text-muted-foreground">
          <span>Subtotal (ex-GST)</span>
          <span className="tabular-nums">{formatCurrency(subtotal)}</span>
        </div>
        <div className="flex justify-between text-sm text-muted-foreground">
          <span>GST</span>
          <span className="tabular-nums">{formatCurrency(gstTotal)}</span>
        </div>
        {totalWaived > 0 && (
          <div className="flex justify-between text-sm text-red-600">
            <span>Waived</span>
            <span className="tabular-nums">− {formatCurrency(totalWaived)}</span>
          </div>
        )}
        <div className="flex justify-between font-semibold text-base border-t pt-2 mt-1">
          <span>Grand Total</span>
          <span className="tabular-nums">{formatCurrency(grandTotal)}</span>
        </div>
        {hasGstCaveat && (
          <p className="text-[11px] text-amber-700 pt-0.5">
            <span className="font-medium">*</span> GST extra as applicable — not yet recorded on{" "}
            {gstUnknownLines.length === 1 ? "this line" : `${gstUnknownLines.length} lines`}; it is
            applied when the charge is billed.
          </p>
        )}

        {(paid > 0 || balance !== grandTotal) && (
          <div className="pt-2 mt-1 border-t space-y-1.5">
            <div className="flex justify-between text-sm text-muted-foreground">
              <span>Paid</span>
              <span className="tabular-nums">{formatCurrency(paid)}</span>
            </div>
            <div className="flex justify-between text-sm font-medium">
              <span>Balance due</span>
              <span className="tabular-nums">{formatCurrency(Math.max(0, balance))}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
