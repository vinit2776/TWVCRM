import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

const createVendorSchema = z.object({
  name: z.string().min(1, "Vendor name is required"),
  category: z.enum(["pantry", "maintenance", "administration", "general"]),
  contact_name: z.string().optional(),
  contact_phone: z.string().optional(),
  contact_email: z.string().email("Invalid email").optional().or(z.literal("")),
  address: z.string().optional(),
  gstin: z.string().optional(),
  payment_terms: z.string().optional(),
  terms_and_conditions: z.string().optional(),
  notes: z.string().optional(),
  // Bank details
  bank_name: z.string().optional(),
  bank_account_holder: z.string().optional(),
  bank_account_number: z.string().optional(),
  bank_ifsc: z.string().optional(),
  // KYC & compliance
  pan_number: z.string().optional(),
  msme_number: z.string().optional(),
});

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const category = searchParams.get("category");
  const search = searchParams.get("search");
  const includeInactive = searchParams.get("include_inactive") === "true";

  let query = supabase
    .from("procurement_vendors")
    .select("*", { count: "exact" })
    .order("name");

  if (!includeInactive) query = query.eq("is_active", true);
  if (category) query = query.eq("category", category);
  if (search?.trim()) query = query.ilike("name", `%${search.trim()}%`);

  const { data, error, count } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ data, count });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Only manager/admin can manage vendors
  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });
  if (!["admin", "manager", "office_admin"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const body = await request.json();
  const parsed = createVendorSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  const { data: vendor, error } = await supabase
    .from("procurement_vendors")
    .insert({ ...parsed.data, created_by: dbUser.id })
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await logAudit(supabase, {
    entityType: "procurement_vendor",
    entityId: vendor.id,
    action: "create",
    performedBy: dbUser.id,
  });

  return NextResponse.json({ data: vendor }, { status: 201 });
}
