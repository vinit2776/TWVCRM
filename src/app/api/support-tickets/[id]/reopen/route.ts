import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

// POST — reopen a resolved or closed ticket (ticket owner only)
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const adminSupabase = await createAdminClient();

  const { data: currentUser } = await adminSupabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!currentUser) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const { data: ticket } = await adminSupabase
    .from("support_tickets")
    .select("id, reported_by, status")
    .eq("id", id)
    .single();

  if (!ticket) {
    return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
  }

  // Only the ticket owner (or admin) can reopen
  if (currentUser.role !== "admin" && ticket.reported_by !== currentUser.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Can only reopen resolved or closed tickets
  if (!["resolved", "closed"].includes(ticket.status)) {
    return NextResponse.json(
      { error: "Only resolved or closed tickets can be reopened" },
      { status: 422 }
    );
  }

  const { data: updated, error } = await adminSupabase
    .from("support_tickets")
    .update({
      status: "open",
      resolved_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select(
      `*, reporter:reported_by(id, full_name, email, role), assignee:assigned_to(id, full_name, email)`
    )
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ data: updated });
}
