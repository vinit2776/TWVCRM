import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAggregatorSchema } from "@/lib/validations";
import { logAudit } from "@/lib/audit";

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
  const status = searchParams.get("status");
  const search = searchParams.get("search");
  const sort_by = searchParams.get("sort_by") || "created_at";
  const sort_order = searchParams.get("sort_order") || "desc";

  const offset = (page - 1) * limit;

  let query = supabase
    .from("aggregators")
    .select("*", { count: "exact" });

  if (status) query = query.eq("status", status);
  if (search)
    query = query.or(
      `name.ilike.%${search}%,company_name.ilike.%${search}%,code.ilike.%${search}%,primary_email.ilike.%${search}%,gst_number.ilike.%${search}%`
    );

  const ascending = sort_order === "asc";
  query = query
    .order(sort_by, { ascending })
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

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const result = createAggregatorSchema.safeParse(body);

  if (!result.success) {
    return NextResponse.json(
      { error: "Validation failed", details: result.error.issues },
      { status: 400 }
    );
  }

  const { data: dbUser } = await supabase
    .from("users")
    .select("id")
    .eq("auth_id", user.id)
    .single();

  // Extract contacts from the payload — they go into a separate table
  const { contacts, ...aggregatorData } = result.data;

  const { data, error } = await supabase
    .from("aggregators")
    .insert({
      ...aggregatorData,
      created_by: dbUser?.id,
    })
    .select("*")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Insert contacts if provided
  if (contacts && contacts.length > 0 && data) {
    const contactRows = contacts.map((c) => ({
      aggregator_id: data.id,
      name: c.name,
      email: c.email || null,
      phone: c.phone || null,
      designation: c.designation || null,
      is_primary: c.is_primary ?? false,
    }));

    await supabase.from("aggregator_contacts").insert(contactRows);
  }

  if (data && dbUser?.id) {
    logAudit(supabase, {
      entityType: "aggregator",
      entityId: data.id,
      action: "create",
      performedBy: dbUser.id,
      changes: { record: { old: null, new: data } },
    });
  }

  return NextResponse.json({ data }, { status: 201 });
}
