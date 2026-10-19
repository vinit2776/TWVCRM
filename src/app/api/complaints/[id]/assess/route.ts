import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { ENQUIRY_VIEWER_ROLE } from "@/lib/restricted-roles";
// The existing work order endpoint is reused as-is, so numbering, SLA timers, department
// routing, collaborators, notifications and the audit trail behave exactly as for any ticket.
import { POST as createFacilityIssue } from "@/app/api/facility/issues/route";
import { COMPLAINT_OUTCOMES, buildWorkOrderDescription, buildWorkOrderTitle } from "@/lib/complaints";
import { sendComplaintReply, type ReplyOutcome } from "@/lib/complaint-messages";

const SCOPES = ["it", "hvac", "plumbing", "electrical", "housekeeping", "security", "other", "facility"] as const;

const bodySchema = z.object({
  decision: z.enum(["qualify", "needs_info", "not_a_complaint"]),
  outcome: z.enum(COMPLAINT_OUTCOMES).optional(),
  scope: z.enum(SCOPES).optional(),
  priority: z.enum(["low", "medium", "high", "critical"]).optional(),
  location_id: z.string().uuid().optional(),
  assigned_to: z.string().uuid().optional(),
  due_date: z.string().optional(),
  title: z.string().trim().max(120).optional(),
  // The question (needs_info) or the reply (reply only) sent to the customer.
  reply_text: z.string().trim().max(600).optional(),
  // Send the "we have logged your request" acknowledgement when a work order or task is raised.
  notify_customer: z.boolean().optional(),
});

// POST /api/complaints/[id]/assess
// One decision per complaint: qualify it (into a work order, a task, or a reply-only close),
// ask the customer for more information, or reject it as not a complaint.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });
  if (dbUser.role === ENQUIRY_VIEWER_ROLE) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid assessment" }, { status: 400 });
  const b = parsed.data;

  const admin = await createAdminClient();
  const { data: c } = await admin
    .from("customer_complaints")
    .select(
      "id, reference, status, lead_id, customer_name, customer_phone, messages, suggested_scope, suggested_priority, " +
        "contract:contracts!customer_complaints_contract_id_fkey(id, contract_number, location_id), " +
        "lead:leads!customer_complaints_lead_id_fkey(location_id)"
    )
    .eq("id", id)
    .single();
  if (!c) return NextResponse.json({ error: "Complaint not found" }, { status: 404 });
  const complaint = c as unknown as {
    id: string; reference: string; status: string; lead_id: string | null; customer_name: string | null;
    customer_phone: string | null; messages: { at?: string; text?: string }[]; suggested_scope: string | null;
    suggested_priority: string | null;
    contract: { id: string; contract_number: string; location_id: string | null } | null;
    lead: { location_id: string | null } | null;
  };
  if (complaint.status !== "new" && complaint.status !== "needs_info") {
    return NextResponse.json({ error: "This complaint has already been assessed" }, { status: 409 });
  }

  const now = new Date().toISOString();
  const base = { assessed_by: dbUser.id, assessed_at: now, updated_at: now };
  let update: Record<string, unknown>;
  let issueNumber: string | null = null;

  if (b.decision === "needs_info") {
    if (!b.reply_text) return NextResponse.json({ error: "Write the question to ask the customer" }, { status: 400 });
    update = { ...base, status: "needs_info" };
  } else if (b.decision === "not_a_complaint") {
    update = { ...base, status: "not_a_complaint" };
  } else {
    if (!b.outcome) return NextResponse.json({ error: "Choose what to do: work order, task or reply only" }, { status: 400 });
    if (b.outcome === "reply_only") {
      if (!b.reply_text) return NextResponse.json({ error: "Write the reply to send the customer" }, { status: 400 });
      update = { ...base, status: "closed", outcome: "reply_only" };
    } else {
      const scope = b.scope ?? complaint.suggested_scope;
      if (!scope) return NextResponse.json({ error: "Choose the department (scope)" }, { status: 400 });
      const locationId = b.location_id ?? complaint.contract?.location_id ?? complaint.lead?.location_id ?? null;
      if (!locationId) return NextResponse.json({ error: "Choose the location" }, { status: 400 });
      const task = b.outcome === "task";
      if (task && (!b.assigned_to || !b.due_date)) {
        return NextResponse.json({ error: "A task needs someone to do it and a due date" }, { status: 400 });
      }
      const first = complaint.messages[0]?.text ?? "Customer complaint";

      const res = await createFacilityIssue(
        new NextRequest(new URL("/api/facility/issues", request.url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            task_type: task ? "delegated_task" : "reported_problem",
            scope,
            location_id: locationId,
            title: b.title || buildWorkOrderTitle(first),
            description: buildWorkOrderDescription({
              reference: complaint.reference,
              messages: complaint.messages,
              customerName: complaint.customer_name,
              contractNumber: complaint.contract?.contract_number ?? null,
            }),
            priority: b.priority ?? complaint.suggested_priority ?? "medium",
            reported_via: "whatsapp",
            reporter_name: complaint.customer_name,
            reporter_phone: complaint.customer_phone,
            ...(complaint.contract ? { contract_id: complaint.contract.id } : {}),
            ...(task ? { assigned_to: b.assigned_to, due_date: b.due_date } : {}),
          }),
        })
      );
      const json = (await res.json().catch(() => null)) as { data?: { id: string; issue_number: string }; error?: string } | null;
      if (!res.ok || !json?.data) {
        return NextResponse.json({ error: json?.error ?? "Could not create the work order" }, { status: res.status >= 400 ? res.status : 500 });
      }
      issueNumber = json.data.issue_number;
      update = { ...base, status: "qualified", outcome: b.outcome, issue_id: json.data.id };
    }
  }

  const { error } = await admin.from("customer_complaints").update(update).eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (complaint.lead_id) {
    const summary =
      b.decision === "qualify"
        ? issueNumber
          ? `raised as ${issueNumber}`
          : "closed (reply only)"
        : b.decision === "needs_info"
          ? "more information requested"
          : "marked not a complaint";
    await admin.from("activities").insert({
      lead_id: complaint.lead_id,
      type: "note",
      subject: `Complaint ${complaint.reference} ${summary}`,
      description: `Assessed by a team member. Decision: ${b.decision}${b.outcome ? ` / ${b.outcome}` : ""}.`,
    });
    logAudit(supabase, {
      entityType: "lead",
      entityId: complaint.lead_id,
      action: "update",
      performedBy: dbUser.id,
      changes: {
        complaint: { old: complaint.reference, new: complaint.reference },
        complaint_decision: { old: complaint.status, new: (update.status as string) ?? b.decision },
        ...(issueNumber ? { work_order: { old: null, new: issueNumber } } : {}),
      },
    });
  }

  // Tell the customer, after the decision is safely saved. A message that can't be sent never
  // undoes the assessment: the outcome is returned so the assessor knows to reply by hand.
  let reply: ReplyOutcome | null = null;
  if (b.decision === "needs_info" || (b.decision === "qualify" && b.outcome === "reply_only")) {
    reply = await sendComplaintReply(admin, { complaintId: id, kind: "update", text: b.reply_text, sentBy: dbUser.id });
  } else if (b.decision === "qualify" && issueNumber && b.notify_customer !== false) {
    reply = await sendComplaintReply(admin, { complaintId: id, kind: "received", sentBy: dbUser.id });
  }

  return NextResponse.json({ success: true, issue_number: issueNumber, reply });
}
