import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

const VALID_TYPES = [
  "maintenance", "inspection", "fault_observed", "part_replaced",
  "cleaning", "installation", "relocation", "other",
];

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("facility_asset_events")
    .select("*")
    .eq("asset_id", id)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const authIds = [...new Set((data || []).map((e) => e.logged_by).filter(Boolean))];
  let userMap: Record<string, string> = {};
  if (authIds.length > 0) {
    const { data: users } = await supabase
      .from("users")
      .select("auth_id, full_name")
      .in("auth_id", authIds);
    if (users) {
      userMap = Object.fromEntries(users.map((u) => [u.auth_id, u.full_name]));
    }
  }

  const issueIds = [...new Set((data || []).map((e) => e.issue_id).filter(Boolean))];
  let issueMap: Record<string, { id: string; issue_number: string; title: string; status: string }> = {};
  if (issueIds.length > 0) {
    const { data: issues } = await supabase
      .from("facility_issues")
      .select("id, issue_number, title, status")
      .in("id", issueIds);
    if (issues) {
      issueMap = Object.fromEntries(issues.map((i) => [i.id, i]));
    }
  }

  const enriched = (data || []).map((e) => ({
    ...e,
    logger: e.logged_by ? { id: e.logged_by, full_name: userMap[e.logged_by] || null } : null,
    issue: e.issue_id ? issueMap[e.issue_id] || null : null,
  }));

  return NextResponse.json({ data: enriched });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { event_type, note, photo_urls, issue_id, resolve_issue } = body;

  if (!event_type || !VALID_TYPES.includes(event_type)) {
    return NextResponse.json({ error: "Invalid event_type" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("facility_asset_events")
    .insert({
      asset_id: id,
      event_type,
      note: note?.trim() || null,
      photo_urls: photo_urls || [],
      logged_by: user.id,
      issue_id: issue_id || null,
    })
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (issue_id && resolve_issue) {
    await supabase
      .from("facility_issues")
      .update({
        status: "resolved",
        resolved_at: new Date().toISOString(),
        resolution_notes: note?.trim() || `Resolved via event log on asset`,
      })
      .eq("id", issue_id);

    logAudit(supabase, {
      action: "update",
      entityType: "facility_issue",
      entityId: issue_id,
      performedBy: user.id,
      changes: { status: { old: null, new: "resolved" }, resolved_via: { old: null, new: "asset_event" } },
    });
  }

  logAudit(supabase, {
    action: "create",
    entityType: "facility_asset",
    entityId: id,
    performedBy: user.id,
    changes: { event: { old: null, new: { id: data.id, event_type, issue_id: issue_id || null } } },
  });

  return NextResponse.json({ data }, { status: 201 });
}
