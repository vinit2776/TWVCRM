import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { updateSupportTicketSchema } from "@/lib/validations";

// GET — single ticket with notes (admin only)
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Check admin role
  const { data: currentUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!currentUser || currentUser.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data: ticket, error } = await supabase
    .from("support_tickets")
    .select(
      `*, reporter:reported_by(id, full_name, email, role), assignee:assigned_to(id, full_name, email)`
    )
    .eq("id", id)
    .single();

  if (error || !ticket) {
    return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
  }

  // Get notes
  const { data: notes } = await supabase
    .from("support_ticket_notes")
    .select(`*, author:created_by(id, full_name, email)`)
    .eq("ticket_id", id)
    .order("created_at", { ascending: true });

  // Get screenshot signed URL if present
  let screenshotUrl = null;
  if (ticket.screenshot_path) {
    const { data: urlData } = await supabase.storage
      .from("crm-documents")
      .createSignedUrl(ticket.screenshot_path, 3600);
    screenshotUrl = urlData?.signedUrl || null;
  }

  return NextResponse.json({
    data: { ...ticket, notes: notes || [], screenshot_url: screenshotUrl },
  });
}

// PATCH — update ticket (admin only)
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Check admin role
  const { data: currentUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!currentUser || currentUser.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json();
  const parsed = updateSupportTicketSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0].message },
      { status: 400 }
    );
  }

  const updates: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };

  if (parsed.data.status !== undefined) {
    updates.status = parsed.data.status;
    if (parsed.data.status === "resolved" || parsed.data.status === "closed") {
      updates.resolved_at = new Date().toISOString();
    }
  }
  if (parsed.data.priority !== undefined) {
    updates.priority = parsed.data.priority;
  }
  if (parsed.data.assigned_to !== undefined) {
    updates.assigned_to = parsed.data.assigned_to;
  }

  const { data: ticket, error } = await supabase
    .from("support_tickets")
    .update(updates)
    .eq("id", id)
    .select(
      `*, reporter:reported_by(id, full_name, email, role), assignee:assigned_to(id, full_name, email)`
    )
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ data: ticket });
}
