import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { findDuplicateLandlordBill, findDuplicateVendorBill } from "@/lib/electricity-bill-context-server";

const ROLES = ["admin", "manager", "accounts", "office_admin"];

/**
 * Read-only: says whether a landlord bill number is already on file, so the capture form can warn
 * as soon as the invoice is read instead of failing at Save. Creates and changes nothing.
 */
export async function GET(request: NextRequest) {
  const authClient = await createClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: dbUser } = await admin.from("users").select("role").eq("auth_id", user.id).single();
  if (!dbUser || !ROLES.includes(dbUser.role)) return NextResponse.json({ error: "Not allowed" }, { status: 403 });

  const { searchParams } = new URL(request.url);
  const locationId = searchParams.get("location_id");
  const billNumber = searchParams.get("bill_number")?.trim();
  if (!locationId || !billNumber) return NextResponse.json({ duplicate: null });

  try {
    const bill = await findDuplicateLandlordBill(admin, locationId, billNumber);
    if (bill) {
      return NextResponse.json({ duplicate: { message: `This bill number is already recorded for this location (${bill.bill_month}/${bill.bill_year}, ${bill.status}).` } });
    }
    const { data: config } = await admin
      .from("location_electricity_config")
      .select("landlord_vendor_id")
      .eq("location_id", locationId)
      .maybeSingle();
    if (config?.landlord_vendor_id) {
      const vendorBill = await findDuplicateVendorBill(admin, config.landlord_vendor_id, billNumber);
      if (vendorBill) {
        return NextResponse.json({ duplicate: { message: `This invoice is already recorded as vendor bill ${vendorBill.bill_number} (${vendorBill.approval_status}). Open that bill instead of capturing it again.` } });
      }
    }
    return NextResponse.json({ duplicate: null });
  } catch (err) {
    console.error("[electricity-bills/duplicate-check]", err instanceof Error ? err.message : "unknown error");
    return NextResponse.json({ duplicate: null });
  }
}
