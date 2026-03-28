import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { updateSupportTicketSchema } from "@/lib/validations";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { TICKET_STATUS_LABELS } from "@/lib/constants";
import { logAudit } from "@/lib/audit";

// GET — single ticket with notes (admin or ticket owner)
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

  const { data: currentUser } = await adminSupabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!currentUser) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const { data: ticket, error } = await adminSupabase
    .from("support_tickets")
    .select(
      `*, reporter:reported_by(id, full_name, email, role), assignee:assigned_to(id, full_name, email)`
    )
    .eq("id", id)
    .single();

  if (error || !ticket) {
    return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
  }

  // Allow admin OR the ticket's reporter (owner self-service)
  if (currentUser.role !== "admin" && ticket.reported_by !== currentUser.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Get notes
  const { data: notes } = await adminSupabase
    .from("support_ticket_notes")
    .select(`*, author:created_by(id, full_name, email)`)
    .eq("ticket_id", id)
    .order("created_at", { ascending: true });

  // Get screenshot signed URL if present
  let screenshotUrl = null;
  if (ticket.screenshot_path) {
    const { data: urlData } = await adminSupabase.storage
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

  const body = await request.json();
  const parsed = updateSupportTicketSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0].message },
      { status: 400 }
    );
  }

  // build_approved can only be set by admin (already checked above), but guard explicitly
  if (parsed.data.status === "build_approved" && currentUser.role !== "admin") {
    return NextResponse.json(
      { error: "Only admins can approve tickets for build" },
      { status: 403 }
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
    if (parsed.data.status === "build_approved") {
      updates.build_approved_at = new Date().toISOString();
      updates.build_approved_by = currentUser.id;
      updates.build_approved_notes = parsed.data.build_approved_notes!;
    }
  }
  if (parsed.data.priority !== undefined) {
    updates.priority = parsed.data.priority;
  }
  if (parsed.data.assigned_to !== undefined) {
    updates.assigned_to = parsed.data.assigned_to;
  }

  const { data: ticket, error } = await adminSupabase
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

  // Audit log
  const auditChanges: Record<string, { old: unknown; new: unknown }> = {};
  if (parsed.data.status !== undefined) auditChanges.status = { old: null, new: parsed.data.status };
  if (parsed.data.priority !== undefined) auditChanges.priority = { old: null, new: parsed.data.priority };
  if (parsed.data.assigned_to !== undefined) auditChanges.assigned_to = { old: null, new: parsed.data.assigned_to };
  logAudit(adminSupabase, { entityType: "support_ticket", entityId: id, action: "update", performedBy: currentUser.id, changes: auditChanges });

  // Send email notification to ticket creator for status/assignment changes
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reporter = ticket.reporter as any;
  if (reporter?.email && ticket.reported_by !== currentUser.id) {
    const statusChanged = parsed.data.status !== undefined;
    const assignmentChanged = parsed.data.assigned_to !== undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const assignee = ticket.assignee as any;

    if (statusChanged || assignmentChanged) {
      // Fire-and-forget
      (async () => {
        try {
          const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "https://twv-crm.vercel.app").trim();
          const statusLabel = TICKET_STATUS_LABELS[ticket.status] || ticket.status;

          let actionText = "";
          if (statusChanged && assignmentChanged) {
            actionText = `Status changed to <strong>${statusLabel}</strong> and assigned to <strong>${assignee?.full_name || "a team member"}</strong>.`;
          } else if (statusChanged) {
            actionText = `Status has been updated to <strong>${statusLabel}</strong>.`;
          } else {
            actionText = `Ticket has been assigned to <strong>${assignee?.full_name || "a team member"}</strong>.`;
          }

          const buildNotes = parsed.data.status === "build_approved" && parsed.data.build_approved_notes
            ? `<div style="background:#f0faf5;border-left:4px solid #00AE6C;padding:12px 16px;margin:12px 0;border-radius:0 6px 6px 0;"><p style="color:#333;font-size:13px;margin:0;"><strong>Build Notes:</strong> ${parsed.data.build_approved_notes.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p></div>`
            : "";

          await resend.emails.send({
            from: EMAIL_FROM,
            replyTo: EMAIL_REPLY_TO,
            to: reporter.email,
            subject: `[${ticket.ticket_number}] ${ticket.subject} — ${statusChanged ? "Status: " + statusLabel : "Assigned"}`,
            html: `
              <div style="font-family:sans-serif;max-width:600px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
                <div style="background:#015E65;padding:20px 32px;">
                  <h1 style="color:white;margin:0;font-size:20px;">The WorkVilla</h1>
                  <p style="color:#00AE6C;margin:4px 0 0;font-size:12px;">Support Ticket Update</p>
                </div>
                <div style="padding:32px;">
                  <p style="color:#1a1b1e;font-size:15px;">Hi ${reporter.full_name},</p>
                  <p style="color:#333;font-size:14px;">Your ticket <strong>${ticket.ticket_number}</strong> has been updated:</p>
                  <p style="color:#333;font-size:14px;">${actionText}</p>
                  ${buildNotes}
                  <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px;">
                    <tr><td style="padding:6px 0;color:#666;">Ticket</td><td style="padding:6px 0;font-weight:600;">${ticket.ticket_number}</td></tr>
                    <tr><td style="padding:6px 0;color:#666;">Subject</td><td style="padding:6px 0;">${ticket.subject}</td></tr>
                    <tr><td style="padding:6px 0;color:#666;">Status</td><td style="padding:6px 0;font-weight:600;">${statusLabel}</td></tr>
                    ${assignee?.full_name ? `<tr><td style="padding:6px 0;color:#666;">Assigned To</td><td style="padding:6px 0;">${assignee.full_name}</td></tr>` : ""}
                  </table>
                  <div style="text-align:center;margin:24px 0;">
                    <a href="${appUrl}/my-tickets" style="background:#015E65;color:white;padding:10px 24px;text-decoration:none;border-radius:6px;font-weight:bold;display:inline-block;font-size:14px;">View Ticket</a>
                  </div>
                </div>
                <div style="background:#015E65;padding:12px 32px;text-align:center;">
                  <p style="color:#fff;margin:0;font-size:10px;">SREE DESIGN INFRASTRUCTURE PVT LTD | The WorkVilla</p>
                  <p style="color:rgba(255,255,255,0.6);margin:4px 0 0;font-size:9px;">Prakash Presidium, 110, MG Road, Nungambakkam, Chennai - 600034</p>
                </div>
              </div>`,
          });
        } catch (err) {
          console.error("Failed to send ticket status notification:", err);
        }
      })();
    }
  }

  return NextResponse.json({ data: ticket });
}
