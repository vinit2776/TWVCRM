import type { SupabaseClient } from "@supabase/supabase-js";
import { DEAD_BILL_STATUSES_FILTER } from "@/lib/constants";
import { invoiceNumberKey, sharedInvoiceApprovalError } from "@/lib/procurement/shared-invoice";

/** One live bill that carries (part of) a vendor invoice. */
export interface SameInvoiceBill {
  id: string;
  bill_number: string;
  po_id: string | null;
  invoice_number: string | null;
  invoice_date: string;
  total_amount: number;
  approval_status: string;
  payment_status: string;
  amount_paid: number;
  invoice_group_id: string | null;
  po_number: string | null;
  po_type: string | null;
  po_value: number | null;
}

/**
 * Live bills for this vendor and company that carry the same invoice number (case and
 * spacing ignored). Rejected and withdrawn bills never count.
 */
export async function findSameInvoiceBills(
  client: SupabaseClient,
  params: { vendorId: string; companyId: string; invoiceNumber: string; excludeBillId?: string | null },
): Promise<SameInvoiceBill[]> {
  const key = invoiceNumberKey(params.invoiceNumber);
  if (!key) return [];

  // ilike does the case-insensitive narrowing in SQL; % and _ are escaped so a number is never a pattern.
  const pattern = params.invoiceNumber.trim().replace(/[\\%_]/g, (c) => `\\${c}`);
  const { data, error } = await client
    .from("vendor_bills")
    .select(
      "id, bill_number, po_id, invoice_number, invoice_date, total_amount, approval_status, payment_status, amount_paid, invoice_group_id, purchase_orders(po_number, po_type, total_ordered_amount)",
    )
    .eq("vendor_id", params.vendorId)
    .eq("company_id", params.companyId)
    .ilike("invoice_number", pattern)
    .not("approval_status", "in", DEAD_BILL_STATUSES_FILTER);
  if (error) throw new Error(error.message);

  type Row = {
    id: string; bill_number: string; po_id: string | null; invoice_number: string | null; invoice_date: string;
    total_amount: number; approval_status: string; payment_status: string; amount_paid: number;
    invoice_group_id: string | null;
    purchase_orders: { po_number: string; po_type: string; total_ordered_amount: number } | { po_number: string; po_type: string; total_ordered_amount: number }[] | null;
  };
  return ((data ?? []) as unknown as Row[])
    .filter((b) => b.id !== params.excludeBillId && invoiceNumberKey(b.invoice_number ?? "") === key)
    .map((b) => {
      const po = Array.isArray(b.purchase_orders) ? b.purchase_orders[0] : b.purchase_orders;
      return {
        id: b.id,
        bill_number: b.bill_number,
        po_id: b.po_id,
        invoice_number: b.invoice_number,
        invoice_date: b.invoice_date,
        total_amount: Number(b.total_amount),
        approval_status: b.approval_status,
        payment_status: b.payment_status,
        amount_paid: Number(b.amount_paid ?? 0),
        invoice_group_id: b.invoice_group_id,
        po_number: po?.po_number ?? null,
        po_type: po?.po_type ?? null,
        po_value: po ? Number(po.total_ordered_amount) : null,
      };
    });
}

/** Why a new bill on `poId` can't be added to an invoice already on `existing`, or null when it can. */
export function cannotJoinReason(
  existing: SameInvoiceBill[],
  next: { poId: string | null; poType: string | null },
): string | null {
  if (!next.poId || next.poType === "service") {
    return "Only goods purchase orders can share an invoice.";
  }
  if (existing.some((b) => !b.po_id || b.po_type === "service")) {
    return "The earlier bill with this number is not on a goods purchase order, so it can't be shared.";
  }
  const samePo = existing.find((b) => b.po_id === next.poId);
  if (samePo) {
    return `This invoice number is already recorded on this PO (${samePo.bill_number}). Check Vendor Payments to avoid duplicate processing.`;
  }
  return null;
}

/** Distinct PO values (by PO id) among bills. */
export function distinctPoValues(bills: Array<{ po_id: string | null; po_value: number | null }>): number[] {
  const byPo = new Map<string, number>();
  for (const b of bills) if (b.po_id && b.po_value !== null) byPo.set(b.po_id, b.po_value);
  return [...byPo.values()];
}

/**
 * The approval gate for a bill on a shared invoice: shares within the invoice, and the
 * invoice within its POs. Returns the reason when approval must wait, else null.
 */
export async function sharedInvoiceGateError(client: SupabaseClient, groupId: string | null): Promise<string | null> {
  if (!groupId) return null;
  const { data: group } = await client
    .from("vendor_invoice_groups")
    .select("invoice_total")
    .eq("id", groupId)
    .single();
  if (!group) return null;

  const { data: bills } = await client
    .from("vendor_bills")
    .select("id, po_id, total_amount, purchase_orders(total_ordered_amount)")
    .eq("invoice_group_id", groupId)
    .not("approval_status", "in", DEAD_BILL_STATUSES_FILTER);

  type Row = { id: string; po_id: string | null; total_amount: number; purchase_orders: { total_ordered_amount: number } | { total_ordered_amount: number }[] | null };
  const rows = (bills ?? []) as unknown as Row[];
  const poValues = distinctPoValues(
    rows.map((r) => {
      const po = Array.isArray(r.purchase_orders) ? r.purchase_orders[0] : r.purchase_orders;
      return { po_id: r.po_id, po_value: po ? Number(po.total_ordered_amount) : null };
    }),
  );
  return sharedInvoiceApprovalError({
    invoiceTotal: Number(group.invoice_total),
    shares: rows.map((r) => Number(r.total_amount)),
    poValues,
  });
}

export type SharePlan =
  /** First PO on an invoice that is bigger than this PO: open the group now, others join later. */
  | { kind: "open"; invoiceTotal: number }
  /** Same invoice number as bills already recorded: join them (creating the group if they had none). */
  | { kind: "join"; groupId: string | null; invoiceTotal: number; currentTotal: number; attachBillIds: string[] };

/**
 * Makes the group a new bill will belong to exist, raises its total if the person corrected it,
 * and attaches earlier bills that had no group yet. Returns the group id.
 *
 * Audit rows go on the earlier bills too, so whoever opens one of them sees the total changed.
 * The group total is deliberately not behind the chain lock: it is not a bill amount, and a
 * late PO joining must be able to correct it even when the first PO's cycle has closed.
 */
export async function applySharePlan(
  admin: SupabaseClient,
  plan: SharePlan,
  ctx: { companyId: string; vendorId: string; invoiceNumber: string; userId: string; existingBillIds: string[] },
): Promise<string> {
  const { logAudit } = await import("@/lib/audit");
  let groupId = plan.kind === "join" ? plan.groupId : null;

  if (!groupId) {
    const { data, error } = await admin
      .from("vendor_invoice_groups")
      .insert({
        company_id: ctx.companyId,
        vendor_id: ctx.vendorId,
        invoice_number: ctx.invoiceNumber.trim(),
        invoice_number_key: invoiceNumberKey(ctx.invoiceNumber),
        invoice_total: plan.invoiceTotal,
        created_by: ctx.userId,
      })
      .select("id")
      .single();
    if (error || !data) {
      if (error?.code === "23505") {
        throw new Error("Someone just recorded this invoice number. Reload the page and add this PO to it.");
      }
      throw new Error(error?.message ?? "Could not set up the shared invoice");
    }
    groupId = data.id as string;
  } else if (plan.kind === "join" && plan.invoiceTotal > plan.currentTotal + 0.01) {
    const { error } = await admin
      .from("vendor_invoice_groups")
      .update({ invoice_total: plan.invoiceTotal })
      .eq("id", groupId);
    if (error) throw new Error(error.message);
    for (const billId of ctx.existingBillIds) {
      logAudit(admin, {
        entityType: "vendor_bill",
        entityId: billId,
        action: "update",
        performedBy: ctx.userId,
        changes: { shared_invoice_total: { old: plan.currentTotal, new: plan.invoiceTotal } },
      });
    }
  }

  if (plan.kind === "join" && plan.attachBillIds.length > 0) {
    const { error } = await admin
      .from("vendor_bills")
      .update({ invoice_group_id: groupId })
      .in("id", plan.attachBillIds);
    if (error) throw new Error(error.message);
    for (const billId of plan.attachBillIds) {
      logAudit(admin, {
        entityType: "vendor_bill",
        entityId: billId,
        action: "update",
        performedBy: ctx.userId,
        changes: { shared_invoice_group: { old: null, new: groupId } },
      });
    }
  }
  return groupId;
}
