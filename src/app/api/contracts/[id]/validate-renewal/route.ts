import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

/**
 * POST /api/contracts/[id]/validate-renewal
 *
 * A person confirms an auto-created renewal draft (rate, seats, dates) is
 * right. Until this is called the draft cannot be e-mailed, sent for e-sign,
 * or moved past draft. Edits go through the normal Edit Terms flow first.
 */
export async function POST(
  _request: NextRequest,
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
    return NextResponse.json({ error: "You do not have permission to validate renewals." }, { status: 403 });
  }

  const admin = createAdminClient();
  const { data: contract } = await admin
    .from("contracts")
    .select("id, status, is_renewal, renewal_auto_created, renewal_validated_at, escalation_approval_status")
    .eq("id", id)
    .single();
  if (!contract) return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  if (!contract.is_renewal || !contract.renewal_auto_created) {
    return NextResponse.json({ error: "This is not an auto-created renewal." }, { status: 400 });
  }
  if (contract.status !== "draft") {
    return NextResponse.json({ error: `Only a draft can be validated. This one is "${contract.status}".` }, { status: 400 });
  }
  if (contract.renewal_validated_at) {
    return NextResponse.json({ error: "Already validated." }, { status: 409 });
  }

  const now = new Date().toISOString();
  const { error } = await admin
    .from("contracts")
    .update({ renewal_validated_at: now, renewal_validated_by: dbUser.id })
    .eq("id", id)
    .is("renewal_validated_at", null);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(admin, {
    entityType: "contract",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: { renewal_validated: { old: false, new: true } },
  });

  return NextResponse.json({ message: "Renewal validated", renewal_validated_at: now });
}
