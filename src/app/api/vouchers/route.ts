import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const page = parseInt(searchParams.get("page") || "1");
  const limit = parseInt(searchParams.get("limit") || "50");
  const status = searchParams.get("status");

  const offset = (page - 1) * limit;

  let query = supabase
    .from("voucher_repository")
    .select("*", { count: "exact" });

  if (status) query = query.eq("status", status);
  query = query.order("uploaded_at", { ascending: false }).range(offset, offset + limit - 1);

  const { data, error, count } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    data,
    pagination: { page, limit, total: count || 0, totalPages: Math.ceil((count || 0) / limit) },
  });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Check if current user is admin
  const { data: currentUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!currentUser || currentUser.role !== "admin") {
    return NextResponse.json({ error: "Only admins can upload vouchers" }, { status: 403 });
  }

  const body = await request.json();
  const { vouchers } = body as {
    vouchers: Array<{ voucher_code: string; metadata?: Record<string, unknown> }>;
  };

  if (!vouchers || !Array.isArray(vouchers) || vouchers.length === 0) {
    return NextResponse.json(
      { error: "A non-empty vouchers array is required" },
      { status: 400 }
    );
  }

  const rows = vouchers.map((v) => ({
    voucher_code: v.voucher_code,
    status: "available" as const,
    metadata: v.metadata || {},
    uploaded_by: currentUser.id,
  }));

  const { data, error } = await supabase
    .from("voucher_repository")
    .insert(rows)
    .select("*");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (data && data.length > 0) {
    logAudit(supabase, {
      entityType: "voucher",
      entityId: data[0].id,
      action: "create",
      performedBy: currentUser.id,
      changes: { count: { old: null, new: data.length } },
    });
  }

  return NextResponse.json(
    { message: `${data?.length || 0} vouchers uploaded`, count: data?.length || 0 },
    { status: 201 }
  );
}
