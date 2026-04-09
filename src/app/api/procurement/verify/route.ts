import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { verifyApprovalCode } from "@/lib/procurement/approval-code";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const code = request.nextUrl.searchParams.get("code")?.trim().toUpperCase();
  if (!code) return NextResponse.json({ error: "Approval code is required" }, { status: 400 });

  // Determine type from prefix
  const prefix = code.split("-")[0];
  let result = null;

  // ── Search Purchase Requests ──
  if (prefix === "APR" || !result) {
    const { data: pr } = await supabase
      .from("purchase_requests")
      .select(
        `id, pr_number, department, status, approval_code, approved_at, total_estimated_amount,
         requester:users!purchase_requests_requested_by_fkey(id, full_name),
         approver:users!purchase_requests_approved_by_fkey(id, full_name),
         locations(id, name)`
      )
      .eq("approval_code", code)
      .single();

    if (pr) {
      const isValid = verifyApprovalCode(code, pr.id, pr.approved_at || "");
      // Fetch related POs
      const { data: pos } = await supabase
        .from("purchase_orders")
        .select("id, po_number, status, total_ordered_amount, procurement_vendors(name)")
        .eq("pr_id", pr.id);

      result = {
        type: "purchase_request",
        code,
        is_valid: isValid,
        entity: {
          id: pr.id,
          number: pr.pr_number,
          department: pr.department,
          status: pr.status,
          amount: pr.total_estimated_amount,
          approved_at: pr.approved_at,
          requester: pr.requester,
          approver: pr.approver,
          location: pr.locations,
        },
        related_orders: pos || [],
      };
    }
  }

  // ── Search Vendor Bills ──
  if (prefix === "BAP" || (!result && prefix !== "APR")) {
    const { data: bill } = await supabase
      .from("vendor_bills")
      .select(
        `id, bill_number, approval_status, approval_code, approved_at, total_amount, invoice_number,
         approver:users!vendor_bills_approved_by_fkey(id, full_name),
         procurement_vendors:vendor_id(name),
         purchase_orders:po_id(po_number)`
      )
      .eq("approval_code", code)
      .single();

    if (bill) {
      const isValid = verifyApprovalCode(code, bill.id, bill.approved_at || "");
      result = {
        type: "vendor_bill",
        code,
        is_valid: isValid,
        entity: {
          id: bill.id,
          number: bill.bill_number,
          invoice_number: bill.invoice_number,
          status: bill.approval_status,
          amount: bill.total_amount,
          approved_at: bill.approved_at,
          approver: bill.approver,
          vendor: bill.procurement_vendors,
          po: bill.purchase_orders,
        },
      };
    }
  }

  // ── Search Stock Transfers ──
  if (prefix === "TAP" || (!result && prefix !== "APR" && prefix !== "BAP")) {
    const { data: transfer } = await supabase
      .from("stock_transfers")
      .select(
        `id, transfer_number, status, approval_code, approved_at,
         approver:users!stock_transfers_approved_by_fkey(id, full_name),
         from_location:locations!stock_transfers_from_location_id_fkey(name),
         to_location:locations!stock_transfers_to_location_id_fkey(name),
         initiator:users!stock_transfers_initiated_by_fkey(id, full_name)`
      )
      .eq("approval_code", code)
      .single();

    if (transfer) {
      const isValid = verifyApprovalCode(code, transfer.id, transfer.approved_at || "");
      result = {
        type: "stock_transfer",
        code,
        is_valid: isValid,
        entity: {
          id: transfer.id,
          number: transfer.transfer_number,
          status: transfer.status,
          approved_at: transfer.approved_at,
          approver: transfer.approver,
          from_location: transfer.from_location,
          to_location: transfer.to_location,
          initiator: transfer.initiator,
        },
      };
    }
  }

  if (!result) {
    return NextResponse.json({ error: "Approval code not found", code, is_valid: false }, { status: 404 });
  }

  return NextResponse.json(result);
}
