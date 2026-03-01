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

  const { searchParams } = new URL(request.url);
  const page = parseInt(searchParams.get("page") || "1");
  const limit = parseInt(searchParams.get("limit") || "25");
  const type     = searchParams.get("type");
  const dateFrom = searchParams.get("date_from");
  const dateTo   = searchParams.get("date_to");
  const search   = searchParams.get("search");

  const offset = (page - 1) * limit;

  let query = supabase
    .from("activities")
    .select(
      "*, creator:users!activities_created_by_fkey(*), lead:leads!activities_lead_id_fkey(id, first_name, last_name, company)",
      { count: "exact" }
    );

  if (type)     query = query.eq("type", type);
  if (dateFrom) query = query.gte("created_at", dateFrom);
  if (dateTo)   query = query.lte("created_at", dateTo);
  if (search)   query = query.ilike("subject", `%${search}%`);

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
