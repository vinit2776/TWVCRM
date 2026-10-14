import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { istDate } from "@/lib/proposal-followups";

const extendSchema = z.object({
  valid_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a valid date"),
  reason: z.string().trim().min(1, "A reason is required"),
});

/**
 * POST /api/proposals/[id]/extend
 *
 * Pushes a proposal's valid_until forward. On an expired proposal this also
 * revives it (back to 'viewed' if the customer had opened it, else 'sent').
 * Terms are not touched here — if they change, the caller then uses the normal
 * Edit flow on the revived proposal, which carries the commitment-terms rules.
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
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 401 });

  if (!["admin", "manager", "sales_rep"].includes(dbUser.role)) {
    return NextResponse.json({ error: "You do not have permission to extend proposals." }, { status: 403 });
  }

  const parsed = extendSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || "Invalid request" }, { status: 400 });
  }
  const { valid_until, reason } = parsed.data;

  if (valid_until <= istDate(new Date())) {
    return NextResponse.json({ error: "The new date must be in the future." }, { status: 400 });
  }

  const { data: proposal } = await supabase
    .from("proposals")
    .select("id, status, valid_until, viewed_at, validity_extensions")
    .eq("id", id)
    .single();
  if (!proposal) return NextResponse.json({ error: "Proposal not found" }, { status: 404 });

  if (!["sent", "viewed", "expired"].includes(proposal.status)) {
    return NextResponse.json(
      { error: `Only sent, viewed or expired proposals can be extended. This one is "${proposal.status}".` },
      { status: 400 }
    );
  }
  if (proposal.valid_until && valid_until <= String(proposal.valid_until).slice(0, 10) && proposal.status !== "expired") {
    return NextResponse.json({ error: "The new date must be later than the current one." }, { status: 400 });
  }

  const revive = proposal.status === "expired";
  const update: Record<string, unknown> = {
    valid_until,
    validity_extensions: (proposal.validity_extensions ?? 0) + 1,
  };
  if (revive) {
    update.status = proposal.viewed_at ? "viewed" : "sent";
    update.expired_at = null;
  }

  const { error } = await supabase.from("proposals").update(update).eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(supabase, {
    entityType: "proposal",
    entityId: id,
    action: "proposal_extended",
    performedBy: dbUser.id,
    changes: {
      valid_until: { old: proposal.valid_until, new: valid_until },
      ...(revive ? { status: { old: "expired", new: update.status } } : {}),
      reason: { old: null, new: reason },
    },
  });

  return NextResponse.json({ message: revive ? "Proposal revived" : "Validity extended", status: update.status ?? proposal.status });
}
