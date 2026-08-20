import { createClient } from "@/lib/supabase/server";
import { getBillVoidBlocker } from "@/lib/procurement/void-bill";
import {
  resolveStockLocationId,
  resolveStockItemId,
  isReceiptLive,
} from "@/lib/procurement/reverse-delivery";

type SupabaseClient = Awaited<ReturnType<typeof createClient>>;

export type CancellationBlocker = { entity: string; reason: string };

export type CancellationEffect = {
  kind: "bill_voided" | "po_cancelled" | "stock_reversed" | "mr_status";
  label: string;
  detail?: string;
};

export type CancellationPlanBill = { id: string };
export type CancellationPlanPo = { id: string };
export type CancellationPlanDeliveryItem = {
  po_item_id: string;
  stock_item_id: string | null;
  qty: number;
  skip_stock: boolean;
};
export type CancellationPlanDeliveryReceipt = {
  id: string;
  po_id: string;
  stock_location_id: string | null;
  items: CancellationPlanDeliveryItem[];
};

/** The JSONB payload handed to `apply_procurement_cancellation(p_plan, p_actor)`. */
export type CancellationPlan = {
  reason: string;
  root: { type: "purchase_request" | "purchase_order" | "vendor_bill"; id: string };
  outcome: "revoked" | "cancelled";
  material_request: { id: string; terminal_status: "submitted" | "cancelled" } | null;
  purchase_orders: CancellationPlanPo[];
  vendor_bills: CancellationPlanBill[];
  delivery_receipts: CancellationPlanDeliveryReceipt[];
  /**
   * Always empty. A processed PO advance is real money already paid to the
   * vendor — product decision (scope change, mid-build): it now BLOCKS
   * cancellation outright (see `processedAdvanceBlocker`) rather than being
   * flagged for later recovery. This field is kept in the JSONB shape only
   * because the RPC contract (owned by a concurrent migration) still
   * declares it; nothing in this resolver ever populates it.
   */
  advance_recoveries: never[];
};

export type CancellationImpact = {
  plan: CancellationPlan;
  blockers: CancellationBlocker[];
  effects: CancellationEffect[];
  requires_admin: boolean;
};

// ─────────────────────────────────────────────────────────────────────────
// Pure helpers — kept free of any Supabase calls so they can be unit tested
// without a database. All DB fetching happens in resolveCancellationImpact
// below, which then hands rows to these builders.
// ─────────────────────────────────────────────────────────────────────────

/**
 * `requires_admin` is true whenever the chain contains an approved vendor bill
 * (reversing an admin-only approval decision, same rationale as the PO cancel
 * escalation in orders/[id]/route.ts) or the root is a post-approval MR (an MR
 * that has already had budget committed against it and possibly spawned POs).
 */
export function computeRequiresAdmin(opts: {
  rootType: "purchase_request" | "purchase_order";
  rootPrStatus?: string | null;
  billApprovalStatuses: string[];
}): boolean {
  const hasApprovedBill = opts.billApprovalStatuses.includes("approved");
  const rootIsPostApprovalMr =
    opts.rootType === "purchase_request" &&
    ["approved", "partially_ordered", "po_created"].includes(opts.rootPrStatus ?? "");
  return hasApprovedBill || rootIsPostApprovalMr;
}

/**
 * Bill money-moved / TDS blockers — thin wrapper so aggregation logic is
 * unit-testable. Always names the parent PO alongside the bill: this is
 * surfaced from the Material Request cancellation flow, where a bare invoice
 * number means nothing to the person acting on the MR — they need to know
 * which PO is the problem. Product rule (explicitly confirmed): a cancel
 * must be blocked outright the moment ANY bill anywhere in the chain has a
 * recorded payment — this is the single most important invariant here, since
 * proceeding would cancel a PO the business has already paid for.
 */
export function billBlockerFromMessage(
  poNumber: string,
  billNumber: string,
  message: string | null
): CancellationBlocker | null {
  if (!message) return null;
  return { entity: `vendor_bill:${billNumber}`, reason: `${poNumber} — ${message}` };
}

export function reimbursementBlocker(hasActiveStatements: boolean, prNumber: string): CancellationBlocker | null {
  if (!hasActiveStatements) return null;
  return {
    entity: `purchase_request:${prNumber}`,
    reason:
      "This MR already has reimbursement invoice(s) issued to the customer. Void them first before cancelling.",
  };
}

export function amcServiceEventsBlocker(opts: {
  poNumber: string;
  poType: string;
  amcTerminatedAt: string | null;
  serviceEventCount: number;
}): CancellationBlocker | null {
  if (opts.poType !== "service") return null;
  if (opts.amcTerminatedAt) return null;
  if (opts.serviceEventCount <= 0) return null;
  return {
    entity: `purchase_order:${opts.poNumber}`,
    reason: `PO ${opts.poNumber} is an active AMC with logged service events. Terminate the AMC first (Terminate AMC action), then retry cancellation.`,
  };
}

export function buildBillVoidedEffect(billNumber: string, amount: number): CancellationEffect {
  return {
    kind: "bill_voided",
    label: `Bill ${billNumber} voided`,
    detail: `₹${amount.toLocaleString("en-IN")}`,
  };
}

export function buildPoCancelledEffect(poNumber: string): CancellationEffect {
  return { kind: "po_cancelled", label: `PO ${poNumber} cancelled` };
}

export function buildStockReversedEffect(opts: {
  dcNumber: string | null;
  itemName: string;
  qty: number;
  locationName: string | null;
}): CancellationEffect {
  return {
    kind: "stock_reversed",
    label: `Delivery ${opts.dcNumber ?? "(no DC number)"} stock reversed`,
    detail: `${opts.itemName} × ${opts.qty}${opts.locationName ? ` at ${opts.locationName}` : ""}`,
  };
}

/**
 * A processed PO advance is money already paid to the vendor. Product rule
 * (scope change): this blocks the cancel outright rather than producing a
 * "recovery due" effect. An admin can now clear this via the "Reverse
 * advance" action (PATCH .../orders/[id] action: "reverse_advance", modes
 * refund_received / adjusted / written_off — see migration 00517 and
 * src/app/api/procurement/orders/[id]/route.ts), which flips advance_status
 * to 'reversed' and this check stops blocking automatically since it only
 * ever matches 'processed'.
 */
export function processedAdvanceBlocker(opts: {
  poNumber: string;
  advanceStatus: string | null;
  advanceAmount: number;
}): CancellationBlocker | null {
  if (opts.advanceStatus !== "processed") return null;
  return {
    entity: `purchase_order:${opts.poNumber}`,
    reason: `${opts.poNumber} has a processed advance of ₹${opts.advanceAmount.toLocaleString("en-IN")}. That money has already been paid to the vendor; reverse the advance (refund received, adjusted, or written off) before this chain can be cancelled.`,
  };
}

export function buildMrStatusEffect(prNumber: string, terminalStatus: "submitted" | "cancelled"): CancellationEffect {
  return {
    kind: "mr_status",
    label: `Material request ${prNumber} → ${terminalStatus === "submitted" ? "back to Pending Approval" : "Cancelled"}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// DB-backed resolver
// ─────────────────────────────────────────────────────────────────────────

type PoRow = {
  id: string;
  po_number: string;
  po_type: string;
  status: string;
  pr_id: string | null;
  location_id: string | null;
  advance_status: string | null;
  advance_amount: number | null;
  amc_terminated_at: string | null;
};

type BillRow = {
  id: string;
  bill_number: string;
  po_id: string | null;
  approval_status: string;
  total_amount: number;
};

/**
 * Walks the chain from a Material Request or a Purchase Order and returns
 * everything needed to either refuse the action (blockers) or hand a plan to
 * `apply_procurement_cancellation`.
 *
 * For a `purchase_request` root, the chain is the MR plus every non-cancelled
 * PO raised against it (and each PO's bills / deliveries / advance).
 * For a `purchase_order` root, the chain is just that PO (its bills /
 * deliveries / advance) — the MR itself is left untouched here; callers that
 * cancel a single PO still recompute the MR's derived status afterwards via
 * `recalculatePrStatus`, same as before this change.
 */
export async function resolveCancellationImpact(
  supabase: SupabaseClient,
  opts: {
    rootType: "purchase_request" | "purchase_order";
    rootId: string;
    outcome: "revoked" | "cancelled";
    reason: string;
  }
): Promise<CancellationImpact> {
  const { rootType, rootId, outcome, reason } = opts;

  const blockers: CancellationBlocker[] = [];
  const effects: CancellationEffect[] = [];

  let prRow: { id: string; pr_number: string; status: string; department: string } | null = null;
  let pos: PoRow[] = [];

  if (rootType === "purchase_request") {
    const { data: pr } = await supabase
      .from("purchase_requests")
      .select("id, pr_number, status, department")
      .eq("id", rootId)
      .single();
    if (!pr) {
      return {
        plan: {
          reason,
          root: { type: rootType, id: rootId },
          outcome,
          material_request: null,
          purchase_orders: [],
          vendor_bills: [],
          delivery_receipts: [],
          advance_recoveries: [],
        },
        blockers: [{ entity: `purchase_request:${rootId}`, reason: "Material request not found." }],
        effects: [],
        requires_admin: true,
      };
    }
    prRow = pr;

    if (pr.department === "reimbursement") {
      const { count: activeStatements } = await supabase
        .from("billing_statements")
        .select("*", { count: "exact", head: true })
        .eq("source_pr_id", rootId)
        .is("voided_at", null);
      const blocker = reimbursementBlocker((activeStatements ?? 0) > 0, pr.pr_number);
      if (blocker) blockers.push(blocker);
    }

    const { data: poRows } = await supabase
      .from("purchase_orders")
      .select("id, po_number, po_type, status, pr_id, location_id, advance_status, advance_amount, amc_terminated_at")
      .eq("pr_id", rootId)
      .neq("status", "cancelled");
    pos = poRows ?? [];
  } else {
    const { data: po } = await supabase
      .from("purchase_orders")
      .select("id, po_number, po_type, status, pr_id, location_id, advance_status, advance_amount, amc_terminated_at")
      .eq("id", rootId)
      .single();
    if (!po) {
      return {
        plan: {
          reason,
          root: { type: rootType, id: rootId },
          outcome,
          material_request: null,
          purchase_orders: [],
          vendor_bills: [],
          delivery_receipts: [],
          advance_recoveries: [],
        },
        blockers: [{ entity: `purchase_order:${rootId}`, reason: "Purchase order not found." }],
        effects: [],
        requires_admin: true,
      };
    }
    pos = [po];
  }

  const planPos: CancellationPlanPo[] = [];
  const planBills: CancellationPlanBill[] = [];
  const planDeliveries: CancellationPlanDeliveryReceipt[] = [];
  const billApprovalStatuses: string[] = [];

  for (const po of pos) {
    // ── Processed advance guard ──────────────────────────────────────────
    // Checked before adding this PO to the plan — a blocked PO's bills and
    // deliveries are still walked below (so ALL blockers in the chain are
    // reported at once, not just the first one hit), but the PO itself, its
    // bills, and its deliveries never make it into planPos/planBills/
    // planDeliveries once any blocker exists for it. That final filtering
    // happens implicitly: resolveCancellationImpact refuses to hand back an
    // actionable plan whenever `blockers` is non-empty (see call sites in
    // the API routes), so a partially-built plan here is never executed.
    const advanceBlocker = processedAdvanceBlocker({
      poNumber: po.po_number,
      advanceStatus: po.advance_status,
      advanceAmount: Number(po.advance_amount ?? 0),
    });
    if (advanceBlocker) blockers.push(advanceBlocker);

    planPos.push({ id: po.id });
    effects.push(buildPoCancelledEffect(po.po_number));

    // ── AMC guard ──────────────────────────────────────────────────────
    if (po.po_type === "service") {
      const { count: eventCount } = await supabase
        .from("amc_service_events")
        .select("*", { count: "exact", head: true })
        .eq("po_id", po.id);
      const amcBlocker = amcServiceEventsBlocker({
        poNumber: po.po_number,
        poType: po.po_type,
        amcTerminatedAt: po.amc_terminated_at,
        serviceEventCount: eventCount ?? 0,
      });
      if (amcBlocker) blockers.push(amcBlocker);
    }

    // ── Vendor bills ───────────────────────────────────────────────────
    const { data: billRows } = await supabase
      .from("vendor_bills")
      .select("id, bill_number, po_id, approval_status, total_amount")
      .eq("po_id", po.id);
    const bills = (billRows ?? []) as BillRow[];

    for (const bill of bills) {
      // Already-voided bills (approval_status "rejected" + rejection_outcome
      // "void") are terminal — nothing left to do, so they're skipped rather
      // than re-added to the plan.
      if (bill.approval_status === "rejected") continue;

      billApprovalStatuses.push(bill.approval_status);

      const blockMsg = await getBillVoidBlocker(supabase, bill.id);
      const blocker = billBlockerFromMessage(po.po_number, bill.bill_number, blockMsg);
      if (blocker) {
        blockers.push(blocker);
        continue;
      }

      planBills.push({ id: bill.id });
      effects.push(buildBillVoidedEffect(bill.bill_number, Number(bill.total_amount)));
    }

    // ── Delivery receipts (stock reversal) ────────────────────────────
    const { data: receiptRows } = await supabase
      .from("po_delivery_receipts")
      .select("id, po_id, dc_number, stock_location_id, reversed_at, po_delivery_receipt_items(id, po_item_id, qty_received, stock_item_id)")
      .eq("po_id", po.id);

    for (const receipt of receiptRows ?? []) {
      // Already-reversed receipts are excluded from the plan outright — the
      // RPC must never re-reverse them. Nothing about a single already-
      // reversed receipt makes the rest of the chain inconsistent (the stock
      // effect it represents is already gone), so it's just omitted here,
      // not reported as a blocker.
      if (!isReceiptLive(receipt.reversed_at)) continue;

      let prLocationId: string | null = null;
      if (!receipt.stock_location_id && !po.location_id && po.pr_id) {
        const { data: prRowForLoc } = await supabase
          .from("purchase_requests")
          .select("location_id")
          .eq("id", po.pr_id)
          .maybeSingle();
        prLocationId = prRowForLoc?.location_id ?? null;
      }
      const stockLocationId = resolveStockLocationId(receipt.stock_location_id, po.location_id, prLocationId);
      let locationName: string | null = null;
      if (stockLocationId) {
        const { data: locRow } = await supabase
          .from("locations")
          .select("name")
          .eq("id", stockLocationId)
          .maybeSingle();
        locationName = locRow?.name ?? null;
      }

      const items: CancellationPlanDeliveryItem[] = [];
      for (const item of receipt.po_delivery_receipt_items ?? []) {
        const { data: poItem } = await supabase
          .from("purchase_order_items")
          .select("item_id, item_name, purchase_request_items(item_id)")
          .eq("id", item.po_item_id)
          .eq("po_id", po.id)
          .maybeSingle();

        const stockItemId = resolveStockItemId(
          item.stock_item_id,
          poItem?.item_id ?? null,
          (poItem?.purchase_request_items as unknown as { item_id: string | null } | null)?.item_id ?? null
        );

        let skipStock = false;
        if (stockItemId) {
          const { data: catalogRow } = await supabase
            .from("procurement_items")
            .select("item_type")
            .eq("id", stockItemId)
            .maybeSingle();
          skipStock = catalogRow?.item_type === "service";
        } else {
          skipStock = true;
        }

        items.push({
          po_item_id: item.po_item_id,
          stock_item_id: stockItemId,
          qty: Number(item.qty_received),
          skip_stock: skipStock,
        });

        if (!skipStock) {
          effects.push(
            buildStockReversedEffect({
              dcNumber: receipt.dc_number ?? null,
              itemName: poItem?.item_name ?? "item",
              qty: Number(item.qty_received),
              locationName,
            })
          );
        }
      }

      planDeliveries.push({
        id: receipt.id,
        po_id: po.id,
        stock_location_id: stockLocationId,
        items,
      });
    }
  }

  const terminalStatus: "submitted" | "cancelled" = outcome === "revoked" ? "submitted" : "cancelled";
  const materialRequest = prRow ? { id: prRow.id, terminal_status: terminalStatus } : null;
  if (prRow) {
    effects.push(buildMrStatusEffect(prRow.pr_number, terminalStatus));
  }

  const requiresAdmin = computeRequiresAdmin({
    rootType,
    rootPrStatus: prRow?.status ?? null,
    billApprovalStatuses,
  });

  const plan: CancellationPlan = {
    reason,
    root: { type: rootType, id: rootId },
    outcome,
    material_request: materialRequest,
    purchase_orders: planPos,
    vendor_bills: planBills,
    delivery_receipts: planDeliveries,
    advance_recoveries: [],
  };

  return { plan, blockers, effects, requires_admin: requiresAdmin };
}
