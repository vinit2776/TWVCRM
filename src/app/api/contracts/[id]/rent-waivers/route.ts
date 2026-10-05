import { NextRequest, NextResponse } from "next/server";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import { createRentWaiver } from "@/lib/rent-waivers";
import { z } from "zod";
import { zodErrorResponse } from "@/lib/validations";

/**
 * Rent waivers — an admin marks a missed rent month as "not billed through the
 * CRM". The month drops off the rent-gap list and the contract page's missing
 * rent prompt; it can still be billed from the contract page, and a real
 * statement for the month always wins. See migration 00575.
 */

const CreateSchema = z.object({
  waived_month: z.string().regex(/^\d{4}-\d{2}-01$/, "Must be first of month (YYYY-MM-01)"),
  reason: z.string().trim().min(5, "Give a short reason (at least 5 characters)"),
});

// GET /api/contracts/[id]/rent-waivers — live (un-revoked) waivers for a contract
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: contractId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("contract_rent_waivers")
    .select("id, waived_month, reason, waived_at, waived_by_user:users!contract_rent_waivers_waived_by_fkey(full_name)")
    .eq("contract_id", contractId)
    .is("revoked_at", null)
    .order("waived_month", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data ?? []);
}

// POST /api/contracts/[id]/rent-waivers — waive one month (admin only)
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: contractId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: dbUser } = await admin.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || dbUser.role !== "admin") {
    return NextResponse.json({ error: "Only an admin can waive billing" }, { status: 403 });
  }

  const parsed = CreateSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  const { waived_month, reason } = parsed.data;

  const result = await createRentWaiver(admin, { contractId, waivedMonth: waived_month, reason, userId: dbUser.id });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json(result.waiver, { status: 201 });
}
