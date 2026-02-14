import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Only admins can view audit logs
  const { data: currentUser } = await supabase
    .from("users")
    .select("role")
    .eq("auth_id", user.id)
    .single();

  if (!currentUser || currentUser.role !== "admin") {
    return NextResponse.json(
      { error: "Only admins can view audit logs" },
      { status: 403 }
    );
  }

  const { searchParams } = new URL(request.url);
  const page = parseInt(searchParams.get("page") || "1");
  const limit = parseInt(searchParams.get("limit") || "50");
  const entityType = searchParams.get("entity_type");
  const action = searchParams.get("action");
  const performedBy = searchParams.get("performed_by");
  const search = searchParams.get("search");

  const offset = (page - 1) * limit;

  let query = supabase
    .from("audit_trail")
    .select("*, performer:users!audit_trail_performed_by_fkey(id, full_name, email, role)", {
      count: "exact",
    });

  if (entityType) query = query.eq("entity_type", entityType);
  if (action) query = query.eq("action", action);
  if (performedBy) query = query.eq("performed_by", performedBy);
  if (search) query = query.ilike("entity_type", `%${search}%`);

  query = query
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  const { data, error, count } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    data,
    pagination: {
      page,
      limit,
      total: count || 0,
      totalPages: Math.ceil((count || 0) / limit),
    },
  });
}
