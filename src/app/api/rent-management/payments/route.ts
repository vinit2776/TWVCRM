import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { RENT_MANAGEMENT_ROLES } from "@/lib/constants";

// GET /api/rent-management/payments — cross-lease payment list
// Query params: status, due_days (payments due within N days)
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("role").eq("auth_id", user.id).single();
  if (!dbUser || !RENT_MANAGEMENT_ROLES.includes(dbUser.role as never))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");
  const dueDays = searchParams.get("due_days") ? parseInt(searchParams.get("due_days")!) : null;

  let query = supabase
    .from("lease_payments")
    .select(`
      *,
      lease:property_leases(
        id, base_rent_amount, status,
        location:locations(id, name)
      )
    `)
    .order("due_date", { ascending: true });

  if (status) query = query.eq("status", status);

  if (dueDays !== null) {
    const today = new Date().toISOString().split("T")[0];
    const future = new Date(Date.now() + dueDays * 86400000).toISOString().split("T")[0];
    query = query.gte("due_date", today).lte("due_date", future);
  }

  const { data, error } = await query.limit(50);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data });
}
