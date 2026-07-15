import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logIssueEvent } from "@/lib/facility";
import { TAT_REASON_EXEMPT, TAT_REASON_LABEL } from "@/lib/facility-ui";
import type { FacilityTatReason } from "@/types";

const MAX_EXTENSIONS = 2;
const VALID_REASONS = Object.keys(TAT_REASON_LABEL) as FacilityTatReason[];

/**
 * GET /api/facility/issues/[id]/extend
 * Lists the extension history for a ticket.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("facility_issue_tat_extensions")
    .select("*, requester:users!facility_issue_tat_extensions_requested_by_fkey(id, full_name)")
    .eq("issue_id", id)
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data: data ?? [] });
}

/**
 * POST /api/facility/issues/[id]/extend
 * Self-service TAT/due-date extension — the current assignee only, up to
 * MAX_EXTENSIONS times per ticket. Body: { hours, reason_category, explanation }.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, full_name").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const { data: issue } = await supabase
    .from("facility_issues")
    .select("id, issue_number, title, assigned_to, sla_target_at, tat_extension_count, status")
    .eq("id", id)
    .single();
  if (!issue) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (issue.assigned_to !== dbUser.id) {
    return NextResponse.json({ error: "Only the current assignee can request an extension" }, { status: 403 });
  }
  if (!["new", "acknowledged", "in_progress", "reopened"].includes(issue.status)) {
    return NextResponse.json({ error: "Ticket is not open" }, { status: 400 });
  }
  if ((issue.tat_extension_count ?? 0) >= MAX_EXTENSIONS) {
    return NextResponse.json({ error: `Extension limit reached (${MAX_EXTENSIONS} per ticket)` }, { status: 400 });
  }

  const body = await request.json();
  const hours = Number(body.hours);
  const reasonCategory = body.reason_category as FacilityTatReason;
  const explanation = typeof body.explanation === "string" ? body.explanation.trim() : "";

  if (!isFinite(hours) || hours <= 0) {
    return NextResponse.json({ error: "hours must be a positive number" }, { status: 400 });
  }
  if (!VALID_REASONS.includes(reasonCategory)) {
    return NextResponse.json({ error: `Invalid reason_category. Use one of: ${VALID_REASONS.join(", ")}` }, { status: 400 });
  }
  if (!explanation) {
    return NextResponse.json({ error: "explanation is required" }, { status: 400 });
  }

  const previousTargetAt = issue.sla_target_at ?? new Date().toISOString();
  const newTargetAt = new Date(new Date(previousTargetAt).getTime() + hours * 3600 * 1000).toISOString();
  const kpiExempt = TAT_REASON_EXEMPT[reasonCategory];

  const { data: extension, error } = await supabase
    .from("facility_issue_tat_extensions")
    .insert({
      issue_id: id,
      requested_by: dbUser.id,
      reason_category: reasonCategory,
      explanation,
      added_hours: hours,
      previous_target_at: previousTargetAt,
      new_target_at: newTargetAt,
      kpi_exempt: kpiExempt,
    })
    .select("*, requester:users!facility_issue_tat_extensions_requested_by_fkey(id, full_name)")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const { error: updErr } = await supabase
    .from("facility_issues")
    .update({
      sla_target_at: newTargetAt,
      sla_breached: false,
      tat_extension_count: (issue.tat_extension_count ?? 0) + 1,
    })
    .eq("id", id);
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  await logIssueEvent(supabase, {
    issueId: id,
    eventType: "tat_extended",
    actorId: dbUser.id,
    actorLabel: dbUser.full_name,
    message: `Extended by ${hours}h (${TAT_REASON_LABEL[reasonCategory]}): ${explanation}`,
    payload: { hours, reason_category: reasonCategory, kpi_exempt: kpiExempt, extension_number: (issue.tat_extension_count ?? 0) + 1 },
  });

  return NextResponse.json({ data: extension }, { status: 201 });
}
