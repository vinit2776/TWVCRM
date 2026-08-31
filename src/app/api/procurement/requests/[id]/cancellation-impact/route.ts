import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resolveCancellationImpact } from "@/lib/procurement/cancellation-plan";

/**
 * Read-only preview of what `revoke_approval` / `cancel` would do to a
 * Material Request and everything raised against it (POs, vendor bills,
 * delivery receipts, advances) — without writing anything. The UI uses this
 * to show blockers/effects and decide whether to enable the confirm button
 * (`requires_admin`) before the actual PATCH is sent.
 *
 * Auth mirrors GET /api/procurement/requests/[id] (any procurement role can
 * read) — the write actions themselves stay admin-only, enforced in the
 * PATCH handler.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });
  if (!["admin", "manager", "office_admin"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const outcomeParam = request.nextUrl.searchParams.get("outcome");
  const outcome = outcomeParam === "revoked" || outcomeParam === "cancelled" ? outcomeParam : null;
  if (!outcome) {
    return NextResponse.json({ error: "outcome must be 'revoked' or 'cancelled'" }, { status: 400 });
  }

  const { data: pr, error } = await supabase
    .from("purchase_requests")
    .select("id, pr_number, status")
    .eq("id", id)
    .single();
  if (error || !pr) return NextResponse.json({ error: "Request not found" }, { status: 404 });

  const impact = await resolveCancellationImpact(supabase, {
    rootType: "purchase_request",
    rootId: id,
    outcome,
    // Preview only — the RPC is never called here, so this placeholder reason
    // is never persisted. The real reason is supplied by the PATCH request.
    reason: `Preview of ${outcome} for MR ${pr.pr_number}`,
  });

  return NextResponse.json({
    blockers: impact.blockers,
    effects: impact.effects,
    requires_admin: impact.requires_admin,
  });
}
