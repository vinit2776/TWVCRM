import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { ENQUIRY_VIEWER_ROLE } from "@/lib/restricted-roles";
import { sendComplaintReply, type ReplyOutcome } from "@/lib/complaint-messages";
import { REQUEST_TYPE_LABEL, requestTaskTitle, type RequestType } from "@/lib/requests";

const bodySchema = z.object({
  decision: z.enum(["task", "enquiry", "done", "needs_info", "not_a_request"]),
  assigned_to: z.string().uuid().optional(),
  due_date: z.string().optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  // The message sent to the customer: the question (needs_info) or the closing message (done).
  reply_text: z.string().trim().max(600).optional(),
  // Send the "we have logged your request" acknowledgement when a task or enquiry is raised.
  notify_customer: z.boolean().optional(),
});

// POST /api/complaints/[id]/handle   (customer REQUESTS; complaints go through /assess)
// One decision per request: hand it to someone as a task, convert it into a sales enquiry
// (add seats), mark it done with a message to the customer, ask the customer a question, or
// reject it as not a request.
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
  if (!parsed.success) return NextResponse.json({ error: "Invalid decision" }, { status: 400 });
  const b = parsed.data;

  const admin = await createAdminClient();
  const { data: row } = await admin
    .from("customer_complaints")
    .select("id, reference, kind, request_type, status, lead_id, customer_name, customer_phone, messages, due_at")
    .eq("id", id)
    .single();
  if (!row) return NextResponse.json({ error: "Request not found" }, { status: 404 });
  const r = row as unknown as {
    id: string; reference: string; kind: string; request_type: RequestType | null; status: string; lead_id: string | null;
    customer_name: string | null; customer_phone: string | null; messages: { at?: string; text?: string }[]; due_at: string | null;
  };
  if (r.kind !== "request" || !r.request_type) {
    return NextResponse.json({ error: "This is a complaint: assess it instead" }, { status: 400 });
  }
  if (r.status !== "new" && r.status !== "needs_info") {
    return NextResponse.json({ error: "This request has already been handled" }, { status: 409 });
  }

  const now = new Date().toISOString();
  const base = { assessed_by: dbUser.id, assessed_at: now, updated_at: now };
  let update: Record<string, unknown>;
  let taskId: string | null = null;

  if (b.decision === "needs_info") {
    if (!b.reply_text) return NextResponse.json({ error: "Write the question to ask the customer" }, { status: 400 });
    update = { ...base, status: "needs_info" };
  } else if (b.decision === "not_a_request") {
    update = { ...base, status: "not_a_complaint" };
  } else if (b.decision === "done") {
    if (!b.reply_text) return NextResponse.json({ error: "Write the message to send the customer" }, { status: 400 });
    update = { ...base, status: "closed", outcome: "reply_only" };
  } else if (b.decision === "enquiry") {
    if (!r.lead_id) return NextResponse.json({ error: "This request has no customer to open an enquiry for" }, { status: 409 });
    // The same customer asking for more: a sales enquiry, claimed by whoever will follow it up, so
    // it gets next steps, history and conversion tracking like any other.
    const { data: enq, error: enqErr } = await admin
      .from("lead_enquiries")
      .insert({
        lead_id: r.lead_id,
        source: "whatsapp",
        is_re_enquiry: true,
        ...(b.assigned_to ? { claimed_by: b.assigned_to, claimed_at: now } : {}),
        payload: {
          name: r.customer_name,
          messages: r.messages,
          note: `Converted from request ${r.reference} (${REQUEST_TYPE_LABEL[r.request_type]})`,
        },
      })
      .select("id")
      .single();
    if (enqErr || !enq) return NextResponse.json({ error: enqErr?.message ?? "Could not create the enquiry" }, { status: 500 });
    update = { ...base, status: "closed", outcome: "enquiry", enquiry_id: enq.id };
  } else {
    if (!b.assigned_to) return NextResponse.json({ error: "Choose who will do it" }, { status: 400 });
    // The task lives on the existing Tasks module (and on the customer's Tasks tab).
    const { data: task, error: taskErr } = await admin
      .from("tasks")
      .insert({
        title: requestTaskTitle(r.request_type, r.reference, r.customer_name),
        description: `Customer request ${r.reference} (WhatsApp):\n${r.messages.map((m) => `- ${(m.text ?? "").trim()}`).join("\n")}`,
        status: "todo",
        priority: b.priority ?? (r.request_type === "add_seats" ? "high" : "medium"),
        lead_id: r.lead_id,
        assigned_to: b.assigned_to,
        due_date: b.due_date ?? r.due_at ?? new Date(Date.now() + 24 * 3_600_000).toISOString(),
        tags: ["request", r.reference],
        created_by: dbUser.id,
      })
      .select("id")
      .single();
    if (taskErr || !task) return NextResponse.json({ error: taskErr?.message ?? "Could not create the task" }, { status: 500 });
    taskId = task.id as string;
    void logAudit(admin, { entityType: "task", entityId: taskId, action: "create", performedBy: dbUser.id });
    update = { ...base, status: "qualified", outcome: "task", task_id: taskId };
  }

  const { error } = await admin.from("customer_complaints").update(update).eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (r.lead_id) {
    await admin.from("activities").insert({
      lead_id: r.lead_id,
      type: "note",
      subject: `Request ${r.reference} ${
        b.decision === "task" ? "handed to a task" : b.decision === "enquiry" ? "converted to an enquiry" : b.decision === "done" ? "marked done" : b.decision === "needs_info" ? "more information requested" : "marked not a request"
      }`,
      description: `Handled by a team member. Decision: ${b.decision}.`,
    });
    logAudit(supabase, {
      entityType: "lead",
      entityId: r.lead_id,
      action: "update",
      performedBy: dbUser.id,
      changes: {
        request: { old: r.reference, new: r.reference },
        request_decision: { old: r.status, new: (update.status as string) ?? b.decision },
        ...(taskId ? { task: { old: null, new: taskId } } : {}),
      },
    });
  }

  // Tell the customer, after the decision is safely saved. A message that can't be sent never
  // undoes the decision: the outcome is returned so the handler knows to reply by hand.
  let reply: ReplyOutcome | null = null;
  if (b.decision === "needs_info" || b.decision === "done") {
    reply = await sendComplaintReply(admin, { complaintId: id, kind: "update", text: b.reply_text, sentBy: dbUser.id });
  } else if ((b.decision === "task" || b.decision === "enquiry") && b.notify_customer !== false) {
    reply = await sendComplaintReply(admin, { complaintId: id, kind: "received", sentBy: dbUser.id });
  }

  return NextResponse.json({ success: true, task_id: taskId, reply });
}
