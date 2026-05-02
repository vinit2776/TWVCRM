import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import {
  generateIssueNumber,
  computeSlaTarget,
  logIssueEvent,
} from "@/lib/facility";
import type { FacilityScope, FacilityIssuePriority, FacilityReportedVia } from "@/types";

const VALID_PRIORITY: FacilityIssuePriority[] = ["low", "medium", "high", "critical"];
const VALID_VIA: FacilityReportedVia[] = ["walk_in", "phone", "whatsapp", "email", "self_service", "proactive", "feedback"];

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
  if (assignedTo === "me") {
    const { data: dbUser } = await supabase.from("users").select("id").eq("auth_id", user.id).single();
    if (dbUser) query = query.eq("assigned_to", dbUser.id);
  } else if (assignedTo === "unassigned") {
    query = query.is("assigned_to", null);
  } else if (assignedTo) {
    query = query.eq("assigned_to", assignedTo);
  }
  if (reportedBy) query = query.eq("reported_by", reportedBy);
  if (categoryId) query = query.eq("category_id", categoryId);
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
    scope = "it",
    category_id,
    location_id, floor_id, space_unit_id, asset_id,
    title, description,
    priority = "medium",
    reported_via = "walk_in",
    reporter_name, reporter_email, reporter_phone,
    linked_feedback_id,
    attachments,           // optional array of { file_url, file_path, file_type, caption }
  } = body;

  if (!title || typeof title !== "string" || title.trim() === "") {
    return NextResponse.json({ error: "Title is required" }, { status: 400 });
  }
  if (!location_id) return NextResponse.json({ error: "location_id is required" }, { status: 400 });
  if (!category_id) return NextResponse.json({ error: "category_id is required" }, { status: 400 });
  if (!VALID_PRIORITY.includes(priority)) {
    return NextResponse.json({ error: `Invalid priority. Use one of: ${VALID_PRIORITY.join(", ")}` }, { status: 400 });
  }
  if (!VALID_VIA.includes(reported_via)) {
    return NextResponse.json({ error: `Invalid reported_via` }, { status: 400 });
  }

  // Look up category for SLA computation
  const { data: category, error: catErr } = await supabase
    .from("facility_asset_categories")
    .select("id, scope, default_sla_critical_hrs, default_sla_high_hrs, default_sla_medium_hrs, default_sla_low_hrs")
    .eq("id", category_id)
    .single();
  if (catErr || !category) {
    return NextResponse.json({ error: "Category not found" }, { status: 404 });
  }

  const issueNumber = await generateIssueNumber(supabase, scope as FacilityScope);
  const slaTargetAt = computeSlaTarget(category, priority);

  const { data: issue, error } = await supabase
    .from("facility_issues")
    .insert({
      issue_number: issueNumber,
      scope,
      category_id,
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
    message: `Reported via ${reported_via}`,
    payload: { priority, scope, category_id },
  });

  logAudit(supabase, {
    entityType: "facility_issue", entityId: issue.id, action: "create",
    performedBy: dbUser.id, changes: { record: { old: null, new: issue } },
  });

  return NextResponse.json({ data: issue }, { status: 201 });
}
