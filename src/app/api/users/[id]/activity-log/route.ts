import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/users/[id]/activity-log
 *
 * Returns paginated audit trail entries for a specific user.
 * Lightweight read-only — no new data capture, just filters existing audit_trail.
 *
 * Query params:
 *   limit   — max rows (default 50, max 100)
 *   offset  — pagination offset (default 0)
 *   entity_type — optional filter (e.g., "lead", "contract")
 *   action  — optional filter (e.g., "create", "update", "delete")
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: userId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const limit = Math.min(Number(searchParams.get("limit") || 50), 100);
  const offset = Number(searchParams.get("offset") || 0);
  const entityType = searchParams.get("entity_type");
  const action = searchParams.get("action");

  let query = supabase
    .from("audit_trail")
    .select("id, entity_type, entity_id, action, changes, created_at", { count: "exact" })
    .eq("performed_by", userId)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (entityType) query = query.eq("entity_type", entityType);
  if (action) query = query.eq("action", action);

  const { data, error, count } = await query;

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    data: data || [],
    total: count ?? 0,
    limit,
    offset,
  });
}
