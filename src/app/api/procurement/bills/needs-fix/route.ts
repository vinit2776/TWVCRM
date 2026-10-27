import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { canEditBill, billEditLockReason, PAYMENT_HOLD_REASON_LABELS } from "@/lib/procurement/bill-edit-rules";

export const dynamic = "force-dynamic";

/**
 * GET /api/procurement/bills/needs-fix
 *
 * Bills the caller can still correct that someone is waiting on: an open query
 * on the bill, or Accounts holding its payment. Powers the red "Needs your
 * correction" group on the bills list. Read-only.
 */
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const [{ data: queries }, { data: held }] = await Promise.all([
    supabase
      .from("queries")
      .select(
        `id, entity_id, created_at,
         created_by:users!queries_created_by_fkey(full_name),
         messages:query_messages(body, event_type, created_at)`
      )
      .eq("entity_type", "vendor_bill")
      .eq("status", "open"),
    supabase.from("vendor_bills").select("id").eq("payment_hold_status", "on_hold"),
  ]);

  type QueryRow = {
    id: string;
    entity_id: string;
    created_by: { full_name: string } | { full_name: string }[] | null;
    messages: Array<{ body: string | null; event_type: string; created_at: string }> | null;
  };
  const firstOf = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? v[0] ?? null : v);

  const queryByBill = new Map<string, { asker: string | null; message: string | null }>();
  for (const q of (queries ?? []) as unknown as QueryRow[]) {
    const lastMessage = [...(q.messages ?? [])]
      .filter((m) => m.event_type === "message" && m.body)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .pop();
    if (!queryByBill.has(q.entity_id)) {
      queryByBill.set(q.entity_id, { asker: firstOf(q.created_by)?.full_name ?? null, message: lastMessage?.body ?? null });
    }
  }

  const billIds = [...new Set([...queryByBill.keys(), ...(held ?? []).map((h: { id: string }) => h.id)])];
  if (billIds.length === 0) return NextResponse.json({ items: [] });

  const { data: bills } = await supabase
    .from("vendor_bills")
    .select(
      `id, bill_number, total_amount, created_by, approval_status, payment_status, cheque_signed_at,
       payment_hold_status, payment_hold_reason, payment_hold_notes,
       purchase_orders(po_number, po_type, total_ordered_amount, unit_cost_per_cycle),
       vendor_bill_payments(reversed_at)`
    )
    .in("id", billIds);

  const items = (bills ?? [])
    .filter((b) => {
      if (!canEditBill({ role: dbUser.role, userId: dbUser.id, createdBy: b.created_by })) return false;
      const payments = (b.vendor_bill_payments ?? []) as Array<{ reversed_at: string | null }>;
      return billEditLockReason({
        approvalStatus: b.approval_status,
        standingPaymentCount: payments.filter((p) => !p.reversed_at).length,
        paymentStatus: b.payment_status,
        chequeSigned: !!b.cheque_signed_at,
      }) === null;
    })
    .map((b) => {
      const po = firstOf(b.purchase_orders as unknown as
        | { po_number: string; po_type: string; total_ordered_amount: number | null; unit_cost_per_cycle: number | null }
        | Array<{ po_number: string; po_type: string; total_ordered_amount: number | null; unit_cost_per_cycle: number | null }>
        | null);
      const q = queryByBill.get(b.id);
      const poValue = po ? Number(po.po_type === "service" && po.unit_cost_per_cycle ? po.unit_cost_per_cycle : po.total_ordered_amount ?? 0) : null;
      return {
        bill_id: b.id,
        bill_number: b.bill_number,
        po_number: po?.po_number ?? null,
        total_amount: Number(b.total_amount),
        po_value: poValue && poValue > 0 ? poValue : null,
        kind: q ? ("query" as const) : ("hold" as const),
        asker: q?.asker ?? null,
        message: q
          ? q.message
          : [PAYMENT_HOLD_REASON_LABELS[b.payment_hold_reason ?? ""] ?? b.payment_hold_reason, b.payment_hold_notes].filter(Boolean).join(" — "),
      };
    });

  return NextResponse.json({ items });
}
