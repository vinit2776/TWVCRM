import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

const updateVendorSchema = z.object({
  name: z.string().min(1).optional(),
  category: z.enum(["pantry", "maintenance", "administration", "general"]).optional(),
  contact_name: z.string().optional(),
  contact_phone: z.string().optional(),
  contact_email: z.string().email("Invalid email").optional().or(z.literal("")),
  address: z.string().optional(),
  gstin: z.string().optional(),
  payment_terms: z.string().optional(),
  terms_and_conditions: z.string().optional(),
  notes: z.string().optional(),
  is_active: z.boolean().optional(),
  // Bank details
  bank_name: z.string().optional(),
  bank_account_holder: z.string().optional(),
  bank_account_number: z.string().optional(),
  bank_ifsc: z.string().optional(),
  // KYC & compliance
  pan_number: z.string().optional(),
  msme_number: z.string().optional(),
  kyc_verified: z.boolean().optional(),
  kyc_verified_at: z.string().optional(),
  kyc_verified_by: z.string().uuid().optional(),
});

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("procurement_vendors")
    .select("*")
    .eq("id", id)
    .single();

  if (error || !data) return NextResponse.json({ error: "Vendor not found" }, { status: 404 });
  return NextResponse.json({ data });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });
  if (!["admin", "manager", "fms"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Only managers and admins can update vendors" }, { status: 403 });
  }

  const body = await request.json();
  const parsed = updateVendorSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  // If kyc_verified is being set to true, record who verified and when
  const updatePayload: Record<string, unknown> = { ...parsed.data };
  if (parsed.data.kyc_verified === true && !parsed.data.kyc_verified_at) {
    // Only admin and manager can mark KYC verified
    if (!["admin", "manager"].includes(dbUser.role)) {
      return NextResponse.json({ error: "Only managers and admins can mark KYC as verified" }, { status: 403 });
    }
    updatePayload.kyc_verified_at = new Date().toISOString();
    updatePayload.kyc_verified_by = dbUser.id;
  } else if (parsed.data.kyc_verified === false) {
    updatePayload.kyc_verified_at = null;
    updatePayload.kyc_verified_by = null;
  }

  const { data: updated, error } = await supabase
    .from("procurement_vendors")
    .update(updatePayload)
    .eq("id", id)
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!updated) return NextResponse.json({ error: "Vendor not found" }, { status: 404 });

  await logAudit(supabase, {
    entityType: "procurement_vendor",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
  });

  return NextResponse.json({ data: updated });
}
