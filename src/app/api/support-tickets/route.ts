import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { createSupportTicketSchema } from "@/lib/validations";

// GET — list all tickets (admin only)
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const adminSupabase = await createAdminClient();

  // Check admin role
  const { data: currentUser } = await adminSupabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!currentUser || currentUser.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");
  const type = searchParams.get("type");

  let query = adminSupabase
    .from("support_tickets")
    .select(
      `*, reporter:reported_by(id, full_name, email, role), assignee:assigned_to(id, full_name, email)`
    )
    .order("created_at", { ascending: false });

  if (status) query = query.eq("status", status);
  if (type) query = query.eq("type", type);

  const { data, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ data });
}

// POST — create a new ticket (any authenticated user)
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const adminSupabase = await createAdminClient();

  // Get current user record
  const { data: currentUser, error: userError } = await adminSupabase
    .from("users")
    .select("id, location_id")
    .eq("auth_id", user.id)
    .single();

  console.log("[support-tickets POST] auth user id:", user.id);
  console.log("[support-tickets POST] currentUser:", currentUser);
  console.log("[support-tickets POST] userError:", userError);

  if (!currentUser) {
    return NextResponse.json(
      { error: "User not found", debug: { auth_id: user.id, userError: userError?.message } },
      { status: 404 }
    );
  }

  const body = await request.json();
  const parsed = createSupportTicketSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0].message },
      { status: 400 }
    );
  }

  const { data: ticket, error } = await adminSupabase
    .from("support_tickets")
    .insert({
      subject: parsed.data.subject,
      description: parsed.data.description || null,
      type: parsed.data.type,
      priority: parsed.data.priority,
      page_url: parsed.data.page_url || null,
      user_agent: parsed.data.user_agent || null,
      screen_resolution: parsed.data.screen_resolution || null,
      reported_by: currentUser.id,
      location_id: currentUser.location_id || null,
    })
    .select("*")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ data: ticket }, { status: 201 });
}
