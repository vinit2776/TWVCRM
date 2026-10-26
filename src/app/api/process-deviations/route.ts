import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { summarizeDeviations, type DeviationRow } from "@/lib/process-deviation-summary";

export const dynamic = "force-dynamic";

/**
 * GET /api/process-deviations?days=30
 *
 * The Staff exceptions page: who deviated from the standard path, why, and
 * whether anyone has looked at it. Admin and manager only. It is a coaching
 * record, so individual staff don't get a league table of each other.
 */
const READ_ROLES = ["admin", "manager"];

const RECENT_SELECT = `
  id, process_key, deviation_type, entity_type, entity_id, location_id, due_on,
  recorded_at, reason_code, comment, counts_against_person, amount_at_stake, details,
  accountable_user_id, reviewed_at, review_outcome, review_note,
  accountable:users!process_deviations_accountable_user_id_fkey(id, full_name, role),
  recorder:users!process_deviations_recorded_by_fkey(id, full_name, role),
  location:locations!process_deviations_location_id_fkey(id, name)
`;

export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !READ_ROLES.includes(dbUser.role)) {
    return NextResponse.json({ error: "Only admins and managers can see this" }, { status: 403 });
  }

  const days = Math.min(365, Math.max(1, Number(new URL(req.url).searchParams.get("days")) || 30));
  const now = Date.now();
  const since = new Date(now - days * 86_400_000).toISOString();
  const prevSince = new Date(now - 2 * days * 86_400_000).toISOString();

  const admin = createAdminClient();

  const [currentRes, prevRes] = await Promise.all([
    admin.from("process_deviations").select(RECENT_SELECT).gte("recorded_at", since).order("recorded_at", { ascending: false }).limit(1000),
    admin.from("process_deviations")
      .select("id, deviation_type, entity_id, accountable_user_id, reason_code, counts_against_person, amount_at_stake, recorded_at, reviewed_at")
      .gte("recorded_at", prevSince).lt("recorded_at", since).limit(1000),
  ]);
  if (currentRes.error) return NextResponse.json({ error: currentRes.error.message }, { status: 500 });

  const current = (currentRes.data ?? []) as unknown as Array<DeviationRow & {
    accountable: { full_name: string; role: string } | null;
  }>;
  const summary = summarizeDeviations(current, (prevRes.data ?? []) as DeviationRow[]);

  const names = new Map<string, { full_name: string; role: string }>();
  for (const r of current) {
    if (r.accountable_user_id && r.accountable) names.set(r.accountable_user_id, r.accountable);
  }

  return NextResponse.json({
    days,
    summary: {
      ...summary,
      people: summary.people.map((p) => ({
        ...p,
        full_name: (p.user_id && names.get(p.user_id)?.full_name) || "Unassigned",
        role: (p.user_id && names.get(p.user_id)?.role) || null,
      })),
    },
    items: current.slice(0, 100),
  });
}
