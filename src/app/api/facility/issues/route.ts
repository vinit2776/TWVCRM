import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import {
  generateIssueNumber,
  computeSlaTarget,
  computeClaimSlaTarget,
  canDelegateTo,
  logIssueEvent,
} from "@/lib/facility";
import { notifyIssueAssignee, notifyAdminsStaleAssignee } from "@/lib/facility-notifications";
import { createAdminClient } from "@/lib/supabase/server";
import type { FacilityScope, FacilityIssuePriority, FacilityReportedVia, FacilityTaskType } from "@/types";

const VALID_PRIORITY: FacilityIssuePriority[] = ["low", "medium", "high", "critical"];
const VALID_VIA: FacilityReportedVia[] = ["walk_in", "phone", "whatsapp", "email", "self_service", "proactive", "feedback"];
const VALID_TASK_TYPE: FacilityTaskType[] = ["reported_problem", "delegated_task"];

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const scope = searchParams.get("scope");
  const status = searchParams.getAll("status");
  const priority = searchParams.get("priority");
  const locationId = searchParams.get("location_id");
  const assignedTo = searchParams.get("assigned_to");
  const reportedBy = searchParams.get("reported_by");
  const categoryId = searchParams.get("category_id");
  const assetId = searchParams.get("asset_id");
  const slaBreached = searchParams.get("sla_breached");
  const search = searchParams.get("search");
  const dateFrom = searchParams.get("date_from");
  const dateTo = searchParams.get("date_to");
  const limit = Math.min(Number(searchParams.get("limit") ?? 100), 500);
  const onlyOpen = searchParams.get("only_open") === "true";

  let query = supabase
    .from("facility_issues")
    .select(`
      *,
      location:locations(id, name, code),
      floor:location_floors(id, name),
      space_unit:space_units(id, name, code),
      asset:facility_assets(id, name, asset_code),
      category:facility_asset_categories(id, name, slug, scope, icon),
      reporter:users!facility_issues_reported_by_fkey(id, full_name),
      assignee:users!facility_issues_assigned_to_fkey(id, full_name)
    `)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (scope) query = query.eq("scope", scope);
  if (status.length) query = query.in("status", status);
  else if (onlyOpen) query = query.in("status", ["new", "acknowledged", "in_progress", "reopened"]);
  if (priority) query = query.eq("priority", priority);
  if (locationId) query = query.eq("location_id", locationId);
  let currentDbUserId: string | null = null;
  if (assignedTo === "me" || reportedBy === "me") {
    const { data: dbUser } = await supabase.from("users").select("id").eq("auth_id", user.id).single();
    currentDbUserId = dbUser?.id ?? null;
  }
  if (assignedTo === "me") {
    if (currentDbUserId) query = query.eq("assigned_to", currentDbUserId);
  } else if (assignedTo === "unassigned") {
    query = query.is("assigned_to", null);
  } else if (assignedTo) {
    query = query.eq("assigned_to", assignedTo);
  }
  if (reportedBy === "me") {
    if (currentDbUserId) query = query.eq("reported_by", currentDbUserId);
  } else if (reportedBy) {
    query = query.eq("reported_by", reportedBy);
  }
  if (categoryId) query = query.eq("category_id", categoryId);
  if (assetId) query = query.eq("asset_id", assetId);
  if (slaBreached === "true") query = query.eq("sla_breached", true);
  if (dateFrom) query = query.gte("created_at", dateFrom);
  if (dateTo) query = query.lte("created_at", dateTo);
  if (search) {
    const s = `%${search}%`;
    query = query.or(`title.ilike.${s},issue_number.ilike.${s},description.ilike.${s}`);
  }

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data: data || [] });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, full_name, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const body = await request.json();
  const {
    task_type = "reported_problem",
    scope = "it",
    category_id,
    location_id, floor_id, space_unit_id, asset_id,
    title, description,
    priority = "medium",
    reported_via = "walk_in",
    reporter_name, reporter_email, reporter_phone,
    linked_feedback_id,
    assigned_to: delegateAssignedTo,   // delegated_task only — the person being delegated to
    due_date,                          // delegated_task only — manual TAT, required (D4)
    tat_hours: manualTatHours,         // reported_problem only — manual override of the computed TAT
    attachments,           // optional array of { file_url, file_path, file_type, caption }
  } = body;

  if (!title || typeof title !== "string" || title.trim() === "") {
    return NextResponse.json({ error: "Title is required" }, { status: 400 });
  }
  if (!location_id) return NextResponse.json({ error: "location_id is required" }, { status: 400 });
  if (!VALID_PRIORITY.includes(priority)) {
    return NextResponse.json({ error: `Invalid priority. Use one of: ${VALID_PRIORITY.join(", ")}` }, { status: 400 });
  }
  if (!VALID_VIA.includes(reported_via)) {
    return NextResponse.json({ error: `Invalid reported_via` }, { status: 400 });
  }
  if (!VALID_TASK_TYPE.includes(task_type)) {
    return NextResponse.json({ error: `Invalid task_type. Use one of: ${VALID_TASK_TYPE.join(", ")}` }, { status: 400 });
  }

  // Delegated tasks: required assignee + TAT, validated before any DB writes.
  let delegatedAssignee: { id: string; full_name: string; is_active: boolean } | null = null;
  if (task_type === "delegated_task") {
    if (!delegateAssignedTo) {
      return NextResponse.json({ error: "assigned_to is required when delegating a task" }, { status: 400 });
    }
    if (!due_date || isNaN(new Date(due_date).getTime())) {
      return NextResponse.json({ error: "due_date is required when delegating a task" }, { status: 400 });
    }
    const adminClient = createAdminClient();
    const { data: assignee } = await adminClient
      .from("users")
      .select("id, full_name, is_active")
      .eq("id", delegateAssignedTo)
      .single();
    if (!canDelegateTo(assignee)) {
      return NextResponse.json({ error: "Selected assignee is not an active user" }, { status: 403 });
    }
    delegatedAssignee = assignee;
  }

  // Look up category for SLA computation (optional — reporters may only pick scope)
  let slaSource: Parameters<typeof computeSlaTarget>[0] = {
    default_sla_critical_hrs: 0, default_sla_high_hrs: 0,
    default_sla_medium_hrs: 0, default_sla_low_hrs: 0,
  };
  let categoryDefaultAssigneeId: string | null = null;
  if (category_id) {
    const { data: category, error: catErr } = await supabase
      .from("facility_asset_categories")
      .select("id, scope, default_assignee_id, default_sla_critical_hrs, default_sla_high_hrs, default_sla_medium_hrs, default_sla_low_hrs")
      .eq("id", category_id)
      .single();
    if (catErr || !category) {
      return NextResponse.json({ error: "Category not found" }, { status: 404 });
    }
    slaSource = category;
    categoryDefaultAssigneeId = category.default_assignee_id ?? null;
  }

  const issueNumber = await generateIssueNumber(supabase, scope as FacilityScope);
  // Delegated tasks use the caller-supplied due date directly as the TAT — they
  // bypass computeSlaTarget() (category/priority-derived), which still runs
  // unchanged for reported_problem unless a manual TAT override was supplied.
  const hasManualTat = task_type === "reported_problem" && manualTatHours != null && manualTatHours !== "";
  const computedTatHours = task_type === "delegated_task"
    ? null // delegated tasks track TAT via due_date, not tat_hours
    : hasManualTat
      ? Number(manualTatHours)
      : (() => {
          const hoursMap: Record<FacilityIssuePriority, number> = {
            critical: Number(slaSource.default_sla_critical_hrs) || 2,
            high: Number(slaSource.default_sla_high_hrs) || 8,
            medium: Number(slaSource.default_sla_medium_hrs) || 24,
            low: Number(slaSource.default_sla_low_hrs) || 72,
          };
          return hoursMap[priority as FacilityIssuePriority];
        })();
  const slaTargetAt = task_type === "delegated_task"
    ? new Date(due_date).toISOString()
    : hasManualTat
      ? new Date(Date.now() + Number(manualTatHours) * 3600 * 1000).toISOString()
      : computeSlaTarget(slaSource, priority);
  const claimSlaTargetAt = computeClaimSlaTarget(priority);

  // Auto-assign, reported_problem only. Delegated tasks are assigned explicitly
  // (delegatedAssignee above), not via category/department defaults. Priority
  // order: category's default_assignee_id (most specific) → department head
  // for the ticket's scope (broader fallback) → left unassigned for manual claim.
  let autoAssignee: { id: string; full_name: string } | null = null;
  if (task_type === "reported_problem") {
    const adminClient = createAdminClient();
    if (categoryDefaultAssigneeId) {
      const { data: assignee } = await adminClient
        .from("users")
        .select("id, full_name")
        .eq("id", categoryDefaultAssigneeId)
        .eq("is_active", true)
        .single();
      autoAssignee = assignee ?? null;
      if (!autoAssignee) {
        // UUID set but user is inactive — alert admins so they fix the routing in /facility/settings
        notifyAdminsStaleAssignee({ categoryId: category_id!, issueNumber, issueTitle: title.trim() });
      }
    }
    if (!autoAssignee) {
      const { data: department } = await adminClient
        .from("facility_departments")
        .select("head_user_id, head:users!facility_departments_head_user_id_fkey(id, full_name, is_active)")
        .eq("scope", scope)
        .single();
      const head = department?.head as unknown as { id: string; full_name: string; is_active: boolean } | null;
      if (head?.is_active) autoAssignee = { id: head.id, full_name: head.full_name };
    }
  }

  const now = new Date().toISOString();
  const finalAssignee = delegatedAssignee ?? autoAssignee;
  const { data: issue, error } = await supabase
    .from("facility_issues")
    .insert({
      issue_number: issueNumber,
      task_type,
      scope,
      category_id: category_id || null,
      location_id,
      floor_id: floor_id || null,
      space_unit_id: space_unit_id || null,
      asset_id: asset_id || null,
      title: title.trim(),
      description: description || null,
      priority,
      status: "new",
      reported_by: dbUser.id,
      reporter_name: reporter_name || null,
      reporter_email: reporter_email || null,
      reporter_phone: reporter_phone || null,
      reported_via,
      linked_feedback_id: linked_feedback_id || null,
      sla_target_at: slaTargetAt,
      claim_sla_target_at: claimSlaTargetAt,
      tat_hours: computedTatHours,
      tat_manual_override: hasManualTat,
      ...(finalAssignee ? {
        assigned_to: finalAssignee.id,
        assigned_at: now,
        assigned_by: dbUser.id,
        claimed_at: now,
      } : {}),
    })
    .select(`
      *,
      location:locations(id, name, code),
      category:facility_asset_categories(id, name, slug, scope, icon)
    `)
    .single();

  if (error) {
    if (error.code === "23505") {
      // Race on issue_number — the caller can retry
      return NextResponse.json({ error: "Conflict — please retry" }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Optional attachments uploaded ahead of issue creation
  if (Array.isArray(attachments) && attachments.length > 0) {
    const rows = attachments
      .filter((a) => a && a.file_url && a.file_path)
      .map((a) => ({
        issue_id: issue.id,
        file_url: a.file_url,
        file_path: a.file_path,
        file_type: a.file_type || "image",
        caption: a.caption || null,
        phase: "report",
        uploaded_by: dbUser.id,
      }));
    if (rows.length > 0) await supabase.from("facility_issue_attachments").insert(rows);
  }

  // Timeline + audit
  await logIssueEvent(supabase, {
    issueId: issue.id,
    eventType: "created",
    actorId: dbUser.id,
    actorLabel: dbUser.full_name,
    message: task_type === "delegated_task"
      ? `Delegated to ${delegatedAssignee?.full_name ?? "assignee"} by ${dbUser.full_name}`
      : `Reported via ${reported_via}`,
    payload: { priority, scope, category_id, task_type },
  });

  logAudit(supabase, {
    entityType: "facility_issue", entityId: issue.id, action: "create",
    performedBy: dbUser.id, changes: { record: { old: null, new: issue } },
  });

  await notifyIssueAssignee(issue, {
    type: "created",
    priority,
    reportedBy: dbUser.full_name,
  });

  return NextResponse.json({ data: issue }, { status: 201 });
}
