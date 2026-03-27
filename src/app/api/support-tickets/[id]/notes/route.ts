import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { createTicketNoteSchema } from "@/lib/validations";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { TICKET_STATUS_LABELS } from "@/lib/constants";

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

  // Send email notification to ticket creator (skip if note author is the creator)
  if (ticket.reported_by !== currentUser.id) {
    // Fire-and-forget — don't block the response
    (async () => {
      try {
        const { data: fullTicket } = await adminSupabase
          .from("support_tickets")
          .select("ticket_number, subject, status, priority, reported_by")
          .eq("id", id)
          .single();
        if (!fullTicket) return;

        const { data: reporter } = await adminSupabase
          .from("users")
          .select("full_name, email")
          .eq("id", fullTicket.reported_by)
          .single();
        if (!reporter?.email) return;

        const { data: noteAuthor } = await adminSupabase
          .from("users")
          .select("full_name")
          .eq("id", currentUser.id)
          .single();

        const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "https://twv-crm.vercel.app").trim();
        const statusLabel = TICKET_STATUS_LABELS[fullTicket.status] || fullTicket.status;
        const priorityLabel = (fullTicket.priority || "").charAt(0).toUpperCase() + (fullTicket.priority || "").slice(1);

        await resend.emails.send({
          from: EMAIL_FROM,
          replyTo: EMAIL_REPLY_TO,
          to: reporter.email,
          subject: `Re: [${fullTicket.ticket_number}] ${fullTicket.subject} — New reply`,
          html: `
            <div style="font-family:sans-serif;max-width:600px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
              <div style="background:#015E65;padding:20px 32px;">
                <h1 style="color:white;margin:0;font-size:20px;">The WorkVilla</h1>
                <p style="color:#00AE6C;margin:4px 0 0;font-size:12px;">Support Ticket Update</p>
              </div>
              <div style="padding:32px;">
                <p style="color:#1a1b1e;font-size:15px;">Hi ${reporter.full_name},</p>
                <p style="color:#333;font-size:14px;"><strong>${noteAuthor?.full_name || "Support Team"}</strong> replied to your ticket:</p>
                <div style="background:#f8fafc;border-left:4px solid #015E65;padding:12px 16px;margin:16px 0;border-radius:0 6px 6px 0;">
                  <p style="color:#333;font-size:14px;margin:0;white-space:pre-wrap;">${parsed.data.note.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>
                </div>
                <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px;">
                  <tr><td style="padding:6px 0;color:#666;">Ticket</td><td style="padding:6px 0;font-weight:600;">${fullTicket.ticket_number}</td></tr>
                  <tr><td style="padding:6px 0;color:#666;">Subject</td><td style="padding:6px 0;">${fullTicket.subject}</td></tr>
                  <tr><td style="padding:6px 0;color:#666;">Status</td><td style="padding:6px 0;">${statusLabel}</td></tr>
                  <tr><td style="padding:6px 0;color:#666;">Priority</td><td style="padding:6px 0;">${priorityLabel}</td></tr>
                </table>
                <div style="text-align:center;margin:24px 0;">
                  <a href="${appUrl}/my-tickets" style="background:#015E65;color:white;padding:10px 24px;text-decoration:none;border-radius:6px;font-weight:bold;display:inline-block;font-size:14px;">View Ticket</a>
                </div>
                <p style="color:#666;font-size:12px;">If a response is needed, reply directly from the ticket page.</p>
              </div>
              <div style="background:#015E65;padding:12px 32px;text-align:center;">
                <p style="color:#fff;margin:0;font-size:10px;">SREE DESIGN INFRASTRUCTURE PVT LTD | The WorkVilla</p>
                <p style="color:rgba(255,255,255,0.6);margin:4px 0 0;font-size:9px;">Prakash Presidium, 110, MG Road, Nungambakkam, Chennai - 600034</p>
              </div>
            </div>`,
        });
      } catch (err) {
        console.error("Failed to send ticket note notification:", err);
      }
    })();
  }

  return NextResponse.json({ data: note }, { status: 201 });
}
