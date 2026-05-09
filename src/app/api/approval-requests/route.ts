import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/approval-requests
 *
 * List approval requests. Supports filters:
 *   ?status=pending          — filter by status
 *   ?entity_type=contract    — filter by entity type
 *   ?entity_id=<uuid>        — filter by specific entity
 *   ?requested_by=<uuid>     — filter by requester
 *   ?limit=25                — pagination
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");
  const entityType = searchParams.get("entity_type");
  const entityId = searchParams.get("entity_id");
  const requestedBy = searchParams.get("requested_by");
  const limit = parseInt(searchParams.get("limit") || "50");

  let query = supabase
    .from("approval_requests")
    .select("*, requester:users!approval_requests_requested_by_fkey(id, full_name, email, role), actor:users!approval_requests_acted_by_fkey(id, full_name, email, role)", { count: "exact" });

  if (status) query = query.eq("status", status);
  if (entityType) query = query.eq("entity_type", entityType);
  if (entityId) query = query.eq("entity_id", entityId);
  if (requestedBy) query = query.eq("requested_by", requestedBy);

  query = query.order("created_at", { ascending: false }).limit(limit);

  const { data, error, count } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ data: data || [], total: count || 0 });
}
