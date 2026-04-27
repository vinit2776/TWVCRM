import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  if (!["admin", "manager", "office_admin", "accounts"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  // 1. Fetch MR
  const { data: mr, error: mrError } = await supabase
    .from("purchase_requests")
    .select("id, pr_number, status, created_at, approved_at, rejection_reason, department, approval_code, requester:users!purchase_requests_requested_by_fkey(id, full_name), approver:users!purchase_requests_approved_by_fkey(id, full_name)")
    .eq("id", id)
    .single();

  if (mrError || !mr) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // 2. Fetch linked POs
  const { data: pos } = await supabase
    .from("purchase_orders")
    .select(`
      id, po_number, po_type, status, total_amount, created_at, expected_delivery_date, ordered_at,
      procurement_vendors(id, name),
      po_delivery_receipts(id, received_at, status, receiver:users!po_delivery_receipts_received_by_fkey(id, full_name), po_delivery_receipt_items(id)),
      po_service_reports(id, service_date, notes, recorder:users!po_service_reports_recorded_by_fkey(id, full_name)),
      vendor_bills(id, bill_number, invoice_date, total_amount, payment_status, approval_status, approved_at, payment_date, approver:users!vendor_bills_approved_by_fkey(id, full_name))
    `)
    .eq("pr_id", id)
    .order("created_at", { ascending: true });

  const linkedPos = pos ?? [];

  // 3. Gather all entity IDs for audit trail
  const poIds = linkedPos.map((p: { id: string }) => p.id);
  const billIds = linkedPos.flatMap((p: { vendor_bills?: Array<{ id: string }> }) =>
    (p.vendor_bills ?? []).map((b: { id: string }) => b.id)
  );
  const allEntityIds = [id, ...poIds, ...billIds];

  // 4. Fetch audit trail across MR + all POs + all bills
  const { data: auditEvents } = await supabase
    .from("audit_trail")
    .select("id, entity_type, entity_id, action, changes, created_at, performer:users!audit_trail_performed_by_fkey(id, full_name)")
    .in("entity_id", allEntityIds)
    .order("created_at", { ascending: true });

  // Enrich audit events with entity labels
  const poNumberMap: Record<string, string> = {};
  const billNumberMap: Record<string, string> = {};
  linkedPos.forEach((p: { id: string; po_number: string; vendor_bills?: Array<{ id: string; bill_number: string }> }) => {
    poNumberMap[p.id] = p.po_number;
    (p.vendor_bills ?? []).forEach((b) => {
      billNumberMap[b.id] = b.bill_number;
    });
  });

  const enrichedAudit = (auditEvents ?? []).map((e: { entity_id: string; entity_type: string; [key: string]: unknown }) => ({
    ...e,
    entity_label:
      e.entity_id === id
        ? mr.pr_number
        : poNumberMap[e.entity_id] ?? billNumberMap[e.entity_id] ?? e.entity_id,
  }));

  return NextResponse.json({
    mr,
    linked_pos: linkedPos,
    audit_trail: enrichedAudit,
  });
}
