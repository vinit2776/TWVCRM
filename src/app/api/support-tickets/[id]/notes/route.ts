import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { createTicketNoteSchema } from "@/lib/validations";

// ── Shared ownership check helper ─────────────────────────────────────────
async function resolveUserAndTicket(
  adminSupabase: Awaited<ReturnType<typeof import("@/lib/supabase/server").createAdminClient>>,
  authUid: string,
  ticketId: string
) {
  const [{ data: currentUser }, { data: ticket }] = await Promise.all([
    adminSupabase.from("users").select("id, role").eq("auth_id", authUid).single(),
    adminSupabase.from("support_tickets").select("id, reported_by").eq("id", ticketId).single(),
  ]);
  return { currentUser, ticket };
}

// GET — list notes for a ticket (admin or ticket owner)
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

  const adminSupabase = await createAdminClient();
  const { currentUser, ticket } = await resolveUserAndTicket(adminSupabase, user.id, id);

  if (!currentUser) return NextResponse.json({ error: "User not found" }, { status: 404 });
  if (!ticket) return NextResponse.json({ error: "Ticket not found" }, { status: 404 });

  // Allow admin OR the ticket's reporter
  if (currentUser.role !== "admin" && ticket.reported_by !== currentUser.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data: notes, error } = await adminSupabase
    .from("support_ticket_notes")
    .select(`*, author:created_by(id, full_name, email)`)
    .eq("ticket_id", id)
    .order("created_at", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ data: notes });
}

// POST — add a note/reply to a ticket (admin or ticket owner)
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const adminSupabase = await createAdminClient();
  const { currentUser, ticket } = await resolveUserAndTicket(adminSupabase, user.id, id);

  if (!currentUser) return NextResponse.json({ error: "User not found" }, { status: 404 });

  // Allow admin OR the ticket's reporter (for clarification replies)
  if (!ticket || (currentUser.role !== "admin" && ticket.reported_by !== currentUser.id)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json();
  const parsed = createTicketNoteSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0].message },
      { status: 400 }
    );
  }

  const { data: note, error } = await adminSupabase
    .from("support_ticket_notes")
    .insert({
      ticket_id: id,
      note: parsed.data.note,
      created_by: currentUser.id,
    })
    .select(`*, author:created_by(id, full_name, email)`)
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Update ticket updated_at
  await adminSupabase
    .from("support_tickets")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", id);

  return NextResponse.json({ data: note }, { status: 201 });
}
