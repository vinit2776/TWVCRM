import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { RENT_MANAGEMENT_ROLES } from "@/lib/constants";
import { zodErrorResponse } from "@/lib/validations";

const createPaymentSchema = z.object({
  payment_month: z.string().regex(/^\d{4}-\d{2}$/, "Format: YYYY-MM"),
  due_date: z.string().min(1),
  gross_rent_amount: z.number().positive(),
  tds_amount: z.number().min(0).default(0),
  notes: z.string().nullish(),
});

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("role").eq("auth_id", user.id).single();
  if (!dbUser || !RENT_MANAGEMENT_ROLES.includes(dbUser.role as never))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { data, error } = await supabase
    .from("lease_payments")
    .select("*, bank_account:landlord_bank_accounts(bank_name, account_number)")
    .eq("lease_id", id)
    .order("payment_month", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Resolve approved_by names
  const userIds = [...new Set((data || []).map((p) => p.approved_by).filter(Boolean))];
  const nameMap: Record<string, string> = {};
  if (userIds.length > 0) {
    const { data: users } = await supabase.from("users").select("id, full_name").in("id", userIds);
    for (const u of users || []) nameMap[u.id] = u.full_name;
  }

  const enriched = (data || []).map((p) => ({
    ...p,
    approved_by_name: p.approved_by ? nameMap[p.approved_by] : null,
  }));

  return NextResponse.json({ data: enriched });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "accounts"].includes(dbUser.role))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await request.json();
  const parsed = createPaymentSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });

  // Fetch lease for auto-approval check
  const { data: lease } = await supabase
    .from("property_leases")
    .select("tds_applicable, landlord_id")
    .eq("id", id)
    .single();

  if (!lease) return NextResponse.json({ error: "Lease not found" }, { status: 404 });

  // Fetch auto-approval threshold from app_settings
  const { data: setting } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "lease_auto_approve_threshold")
    .single();
  const threshold = parseFloat(setting?.value || "50000");

  const netAmount = parsed.data.gross_rent_amount - parsed.data.tds_amount;
  const autoApprove = netAmount <= threshold;

  // Check landlord has a verified primary bank account
  let hasVerifiedBank = false;
  if (lease.landlord_id) {
    const { data: bankAccounts } = await supabase
      .from("landlord_bank_accounts")
      .select("id")
      .eq("landlord_id", lease.landlord_id)
      .eq("is_verified", true)
      .eq("is_primary", true)
      .limit(1);
    hasVerifiedBank = (bankAccounts?.length || 0) > 0;
  }

  const shouldAutoApprove = autoApprove && hasVerifiedBank;

  const { data, error } = await supabase
    .from("lease_payments")
    .insert({
      lease_id: id,
      ...parsed.data,
      net_amount_paid: shouldAutoApprove ? netAmount : null,
      status: shouldAutoApprove ? "paid" : "pending",
      auto_approved: shouldAutoApprove,
      approved_by: shouldAutoApprove ? dbUser.id : null,
      approved_at: shouldAutoApprove ? new Date().toISOString() : null,
    })
    .select()
    .single();

  if (error) {
    if (error.code === "23505") return NextResponse.json({ error: "Payment for this month already exists" }, { status: 409 });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  logAudit(supabase, { entityType: "lease_payment", entityId: data.id, action: "create", performedBy: dbUser.id });
  return NextResponse.json({ data }, { status: 201 });
}
