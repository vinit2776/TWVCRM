import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { hasRole, FACILITY_ROLES } from "@/lib/facility";
import { resolveIssue } from "@/lib/facility-resolve";

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

  // audit_trail.performed_by references public.users(id); facility_asset_events
  // .logged_by references auth.users(id). Two different ids, both needed here.
  const { data: dbUser } = await supabase
    .from("users").select("id, full_name, role").eq("auth_id", user.id).single();

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

  // Resolving from here used to hand-roll a three-column update, which skipped
  // SLA evaluation, KPI points, the satisfaction request, the timeline entry
  // and every notification — and its audit write passed an auth id into a
  // column that references public.users, so it silently failed too. Go through
  // the same helper the status route uses instead (issue #759).
  let resolveError: string | null = null;
  if (issue_id && resolve_issue) {
    if (!hasRole(dbUser?.role, FACILITY_ROLES.workOnIssues)) {
      // Logging the event is open to any authenticated user, as before.
      // Resolving a ticket through it is not — that now matches the status
      // endpoint, which this path was quietly bypassing.
      resolveError = "You don't have permission to resolve this ticket";
    } else {
      const result = await resolveIssue(supabase, {
        issueId: issue_id,
        actor: { id: dbUser!.id, authId: user.id, fullName: dbUser!.full_name },
        resolutionNotes: note?.trim() || `Resolved via event log on asset`,
        // The event this request just created is the asset-side record; a
        // second one from the helper would duplicate it.
        logAssetEvent: false,
      });
      if (!result.ok) resolveError = result.error;
    }
  }

  logAudit(supabase, {
    action: "create",
    entityType: "facility_asset",
    entityId: id,
    performedBy: dbUser?.id ?? null,
    changes: { event: { old: null, new: { id: data.id, event_type, issue_id: issue_id || null } } },
  });

  // The event itself was written, so this is a 201 either way — but the caller
  // has to know the ticket did not actually move, or the dialog will say
  // "Event logged & issue resolved" when only half of that happened.
  return NextResponse.json(
    resolveError ? { data, resolve_error: resolveError } : { data },
    { status: 201 },
  );
}
