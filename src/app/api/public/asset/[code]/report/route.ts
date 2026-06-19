import { NextRequest, NextResponse } from "next/server";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import { z } from "zod";
import { generateIssueNumber, computeSlaTarget, logIssueEvent } from "@/lib/facility";
import { notifyItTeam, getItPrimaryAssignee } from "@/lib/facility-notifications";
import type { FacilityScope } from "@/types";

const reportSchema = z.object({
  title: z.string().min(3).max(200),
  description: z.string().max(2000).optional(),
  reporter_name: z.string().min(1).max(100),
  reporter_phone: z.string().max(20).optional(),
  reporter_email: z.string().email().optional().or(z.literal("")),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;
  const admin = createAdminClient();

  const { data: asset } = await admin
    .from("facility_assets")
    .select(`
      id, name, asset_code, location_id,
      floor_id, space_unit_id,
      category:facility_asset_categories(id, scope,
        default_sla_critical_hrs, default_sla_high_hrs,
        default_sla_medium_hrs, default_sla_low_hrs)
    `)
    .eq("asset_code", code)
    .single();

  if (!asset) {
    return NextResponse.json({ error: "Asset not found" }, { status: 404 });
  }

  const body = await request.json();
  const parsed = reportSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  // Check if the request comes from an authenticated user
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  let reportedBy: string | null = null;

  if (user) {
    const { data: dbUser } = await admin
      .from("users")
      .select("id")
      .eq("auth_id", user.id)
      .single();
    reportedBy = dbUser?.id || null;
  }

  const categoryRaw = asset.category as unknown as {
    id: string; scope: string;
    default_sla_critical_hrs: number | null;
    default_sla_high_hrs: number | null;
    default_sla_medium_hrs: number | null;
    default_sla_low_hrs: number | null;
  } | null;
  const category = Array.isArray(categoryRaw) ? categoryRaw[0] ?? null : categoryRaw;

  const scope = (category?.scope || "facility") as FacilityScope;
  const issueNumber = await generateIssueNumber(admin, scope);
  const slaTargetAt = category ? computeSlaTarget(category, "medium") : null;

  let autoAssignee: { id: string; full_name: string } | null = null;
  if (scope === "it") {
    autoAssignee = await getItPrimaryAssignee();
  }

  const now = new Date().toISOString();

  const { data: issue, error } = await admin
    .from("facility_issues")
    .insert({
      issue_number: issueNumber,
      scope,
      category_id: category?.id || null,
      location_id: asset.location_id,
      floor_id: asset.floor_id || null,
      space_unit_id: asset.space_unit_id || null,
      asset_id: asset.id,
      title: parsed.data.title.trim(),
      description: parsed.data.description || null,
      priority: "medium",
      status: "new",
      reported_by: reportedBy,
      reporter_name: parsed.data.reporter_name,
      reporter_email: parsed.data.reporter_email || null,
      reporter_phone: parsed.data.reporter_phone || null,
      reported_via: "self_service",
      sla_target_at: slaTargetAt,
      ...(autoAssignee ? { assigned_to: autoAssignee.id, assigned_at: now, assigned_by: reportedBy } : {}),
    })
    .select("id, issue_number")
    .single();

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ error: "Conflict — please retry" }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  await logIssueEvent(admin, {
    issueId: issue.id,
    eventType: "created",
    actorId: reportedBy,
    actorLabel: parsed.data.reporter_name,
    message: `Reported via QR scan (self-service)`,
    payload: { priority: "medium", scope, asset_code: code },
  });

  await notifyItTeam({
    type: "created",
    issueId: issue.id,
    issueNumber: issue.issue_number,
    title: parsed.data.title.trim(),
    priority: "medium",
    reportedBy: parsed.data.reporter_name,
    assigneeId: autoAssignee?.id,
  });

  return NextResponse.json({
    data: { id: issue.id, issue_number: issue.issue_number },
  }, { status: 201 });
}
