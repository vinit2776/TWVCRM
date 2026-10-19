import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { ENQUIRY_VIEWER_ROLE } from "@/lib/restricted-roles";
import { complaintTemplateStatus } from "@/lib/complaint-messages";
import { effectiveComplaintStatus, isOpenComplaint, type ComplaintStatus } from "@/lib/complaints";

// GET /api/complaints
//   ?view=open|done|all   (default open: new, waiting on info, or work order not yet closed)
//   &issue_id=UUID        (the complaint behind one work order)
// Also returns openCount so the Facility Issues tab can show its badge from one call.
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: me } = await supabase.from("users").select("role").eq("auth_id", user.id).single();
  if (me?.role === ENQUIRY_VIEWER_ROLE) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const sp = request.nextUrl.searchParams;
  const view = sp.get("view") ?? "open";
  const kind = sp.get("kind"); // complaint | request
  const issueId = sp.get("issue_id");

  let query = supabase
    .from("customer_complaints")
    .select(
      "id, reference, kind, request_type, owner_role, due_at, status, outcome, customer_name, customer_phone, messages, suggested_scope, suggested_priority, " +
        "repeat_count, created_at, assessed_at, " +
        "lead:leads!customer_complaints_lead_id_fkey(id), " +
        "contract:contracts!customer_complaints_contract_id_fkey(id, contract_number, location_id, location:locations!contracts_location_id_fkey(id, name)), " +
        "issue:facility_issues!customer_complaints_issue_id_fkey(id, issue_number, status, assignee:users!facility_issues_assigned_to_fkey(full_name)), " +
        "task:tasks!customer_complaints_task_id_fkey(id, status, due_date, assignee:users!tasks_assigned_to_fkey(full_name)), " +
        "enquiry:lead_enquiries!customer_complaints_enquiry_id_fkey(id, reference), " +
        "assessor:users!customer_complaints_assessed_by_fkey(full_name), " +
        "replies:complaint_replies(id, kind, message, status, detail, created_at)"
    )
    .order("created_at", { ascending: false })
    .limit(300);
  if (issueId) query = query.eq("issue_id", issueId);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  type Row = {
    status: ComplaintStatus;
    kind: string;
    issue: { status: string } | null;
    task: { status: string } | null;
  } & Record<string, unknown>;
  const all = ((data ?? []) as unknown as Row[]).map((r) => ({
    ...r,
    status: effectiveComplaintStatus(r.status, r.issue?.status ?? null, r.task?.status ?? null),
  }));
  const openCount = all.filter((r) => isOpenComplaint(r.status)).length;
  const openRequests = all.filter((r) => r.kind === "request" && isOpenComplaint(r.status)).length;
  const byKind = kind === "complaint" || kind === "request" ? all.filter((r) => r.kind === kind) : all;
  const rows = issueId
    ? all
    : byKind.filter((r) => (view === "all" ? true : view === "done" ? !isOpenComplaint(r.status) : isOpenComplaint(r.status)));

  return NextResponse.json({ data: rows, openCount, openRequests, templates: complaintTemplateStatus() });
}
