import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { verifyApprovalCode } from "@/lib/procurement/approval-code";

/**
 * PUBLIC verification endpoint — no authentication required.
 *
 * Security measures:
 * - Read-only (GET only)
 * - Returns ONLY safe, non-sensitive data (no internal IDs, no user emails, no amounts)
 * - No way to enumerate records (requires exact approval code)
 * - Rate-limit friendly (simple query, no joins to sensitive tables)
 * - Does not reveal whether the system uses Supabase, UUIDs, or any internal structure
 */
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code")?.trim().toUpperCase();
  if (!code || code.length < 10) {
    return NextResponse.json({ error: "Invalid approval code format" }, { status: 400 });
  }

  const supabase = await createAdminClient();
  const prefix = code.split("-")[0];

  // ── Search by type prefix ──
  if (prefix === "APR") {
    const { data: pr } = await supabase
      .from("purchase_requests")
      .select("id, pr_number, department, status, approval_code, approved_at, approver:users!purchase_requests_approved_by_fkey(full_name)")
      .eq("approval_code", code)
      .single();

    if (pr) {
      const isValid = verifyApprovalCode(code, pr.id, pr.approved_at || "");
      return NextResponse.json({
        found: true,
        is_valid: isValid,
        type: "Purchase Request Approval",
        reference: pr.pr_number,
        department: pr.department,
        status: pr.status,
        approved_on: pr.approved_at ? new Date(pr.approved_at).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", year: "numeric", month: "long", day: "numeric" }) : null,
        approved_by: (pr.approver as { full_name?: string } | null)?.full_name || null,
        company: "Sree Design Infrastructure Pvt Ltd",
        brand: "The WorkVilla",
      });
    }
  }

  if (prefix === "BAP") {
    const { data: bill } = await supabase
      .from("vendor_bills")
      .select("id, bill_number, approval_status, approval_code, approved_at, approver:users!vendor_bills_approved_by_fkey(full_name)")
      .eq("approval_code", code)
      .single();

    if (bill) {
      const isValid = verifyApprovalCode(code, bill.id, bill.approved_at || "");
      return NextResponse.json({
        found: true,
        is_valid: isValid,
        type: "Vendor Bill Approval",
        reference: bill.bill_number,
        status: bill.approval_status,
        approved_on: bill.approved_at ? new Date(bill.approved_at).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", year: "numeric", month: "long", day: "numeric" }) : null,
        approved_by: (bill.approver as { full_name?: string } | null)?.full_name || null,
        company: "Sree Design Infrastructure Pvt Ltd",
        brand: "The WorkVilla",
      });
    }
  }

  if (prefix === "TAP") {
    const { data: transfer } = await supabase
      .from("stock_transfers")
      .select("id, transfer_number, status, approval_code, approved_at, approver:users!stock_transfers_approved_by_fkey(full_name)")
      .eq("approval_code", code)
      .single();

    if (transfer) {
      const isValid = verifyApprovalCode(code, transfer.id, transfer.approved_at || "");
      return NextResponse.json({
        found: true,
        is_valid: isValid,
        type: "Stock Transfer Approval",
        reference: transfer.transfer_number,
        status: transfer.status,
        approved_on: transfer.approved_at ? new Date(transfer.approved_at).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", year: "numeric", month: "long", day: "numeric" }) : null,
        approved_by: (transfer.approver as { full_name?: string } | null)?.full_name || null,
        company: "Sree Design Infrastructure Pvt Ltd",
        brand: "The WorkVilla",
      });
    }
  }

  // Code not found — don't reveal which table was searched
  return NextResponse.json({
    found: false,
    is_valid: false,
    message: "This approval code does not match any record in our system.",
    company: "Sree Design Infrastructure Pvt Ltd",
    brand: "The WorkVilla",
  }, { status: 404 });
}
