import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

/**
 * GET /api/procurement/bills/[id]/timeline
 *
 * Authenticates the caller, then uses the admin client to read audit history
 * (audit logs are not sensitive — anyone who can view a bill can see its history).
 *
 * Returns:
 *   - events: audit_trail entries enriched with user names (creation, approval, rejection, payments)
 *   - predecessor: the most likely rejected bill this one might replace
 *       (same vendor / same name, similar amount, rejection_outcome=replacement, last 90 days)
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Use admin client for read-only history queries to bypass any RLS edge cases
  // on audit_trail / cross-table joins. Auth was already enforced above.
  const admin = await createAdminClient();

  // Fetch the current bill (need vendor_id, total_amount, created_at, replaces_bill_id)
  const { data: bill } = await admin
    .from("vendor_bills")
    .select("id, vendor_id, total_amount, created_at, po_id, replaces_bill_id")
    .eq("id", id)
    .single();
  if (!bill) return NextResponse.json({ error: "Bill not found" }, { status: 404 });

  // ── Fetch audit trail events for this bill ────────────────────────────────
  const { data: rawEvents } = await admin
    .from("audit_trail")
    .select("id, action, changes, created_at, performed_by")
    .eq("entity_type", "vendor_bill")
    .eq("entity_id", id)
    .order("created_at", { ascending: true });

  // Enrich with performer's name
  const performerIds = Array.from(new Set((rawEvents ?? []).map((e) => e.performed_by).filter(Boolean)));
  const { data: performers } = performerIds.length
    ? await admin.from("users").select("id, full_name, role").in("id", performerIds)
    : { data: [] };
  const performerMap = new Map((performers ?? []).map((p) => [p.id, p]));

  const events = (rawEvents ?? []).map((e) => ({
    id: e.id,
    action: e.action,
    changes: e.changes,
    created_at: e.created_at,
    performer: e.performed_by ? performerMap.get(e.performed_by) ?? null : null,
  }));

  // ── 1. Deterministic lookup via replaces_bill_id ────────────────────────────
  // If the bill explicitly records what it replaces, use that as the source of truth.
  if (bill.replaces_bill_id) {
    const { data: explicitPredecessor } = await admin
      .from("vendor_bills")
      .select(`
        id, bill_number, total_amount, rejection_reason, rejection_outcome,
        approved_at, vendor_id, po_id,
        purchase_orders(id, po_number, pr_id,
          pr:purchase_requests!purchase_orders_pr_id_fkey(id, pr_number))
      `)
      .eq("id", bill.replaces_bill_id)
      .single();
    if (explicitPredecessor) {
      return NextResponse.json({
        events,
        predecessor: explicitPredecessor,
        predecessors: [explicitPredecessor],
      });
    }
  }

  // ── 2. Heuristic fallback (legacy bills without replaces_bill_id) ───────────
  // Same vendor (or same vendor name), same total, status=rejected,
  // rejection_outcome=replacement, created within 90 days BEFORE this bill.
  const ninetyDaysBefore = new Date(new Date(bill.created_at).getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();

  const { data: directMatch } = await admin
    .from("vendor_bills")
    .select(`
      id, bill_number, total_amount, rejection_reason, rejection_outcome,
      approved_at, vendor_id, po_id,
      purchase_orders(id, po_number, pr_id,
        pr:purchase_requests!purchase_orders_pr_id_fkey(id, pr_number))
    `)
    .eq("approval_status", "rejected")
    .eq("rejection_outcome", "replacement")
    .eq("vendor_id", bill.vendor_id)
    .eq("total_amount", bill.total_amount)
    .gte("created_at", ninetyDaysBefore)
    .lt("created_at", bill.created_at)
    .order("created_at", { ascending: false })
    .limit(3);

  let predecessors = directMatch ?? [];

  // If no exact match by vendor_id, also try by vendor name (handles duplicate vendor records)
  if (predecessors.length === 0) {
    const { data: thisVendor } = await admin
      .from("procurement_vendors")
      .select("id, name")
      .eq("id", bill.vendor_id)
      .single();

    if (thisVendor?.name) {
      const { data: sameNameVendors } = await admin
        .from("procurement_vendors")
        .select("id")
        .ilike("name", thisVendor.name);
      const vendorIds = (sameNameVendors ?? []).map((v) => v.id);

      if (vendorIds.length > 1) {
        const { data: nameMatchCandidates } = await admin
          .from("vendor_bills")
          .select(`
            id, bill_number, total_amount, rejection_reason, rejection_outcome,
            approved_at, vendor_id, po_id,
            purchase_orders(id, po_number, pr_id,
              pr:purchase_requests!purchase_orders_pr_id_fkey(id, pr_number))
          `)
          .eq("approval_status", "rejected")
          .eq("rejection_outcome", "replacement")
          .in("vendor_id", vendorIds)
          .eq("total_amount", bill.total_amount)
          .gte("created_at", ninetyDaysBefore)
          .lt("created_at", bill.created_at)
          .order("created_at", { ascending: false })
          .limit(3);
        predecessors = nameMatchCandidates ?? [];
      }
    }
  }

  return NextResponse.json({
    events,
    predecessor: predecessors[0] ?? null,
    predecessors,
  });
}
