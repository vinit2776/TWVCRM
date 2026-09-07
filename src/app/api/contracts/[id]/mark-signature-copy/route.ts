import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

const CONTRACT_MANAGE_ROLES = ["admin", "manager", "sales_rep"];

/**
 * POST /api/contracts/[id]/mark-signature-copy
 *
 * Records that a watermark-free "Download for signature" copy was just
 * generated for this contract while start_date isn't confirmed yet, and
 * snapshots the start_date baked into that copy (read server-side, never
 * trusted from the client). If start_date later changes before the
 * contract activates, the UI compares it against this snapshot to warn
 * staff that the signed copy is now stale and needs to be re-sent.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: contractId } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser || !CONTRACT_MANAGE_ROLES.includes(dbUser.role)) {
    return NextResponse.json(
      { error: "Not allowed to download a signature copy for this contract" },
      { status: 403 }
    );
  }

  const { data: contract } = await supabase
    .from("contracts")
    .select("id, start_date")
    .eq("id", contractId)
    .single();

  if (!contract) {
    return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  }

  const now = new Date().toISOString();
  const { data: updated, error: updateErr } = await supabase
    .from("contracts")
    .update({
      signature_copy_generated_at: now,
      signature_copy_start_date: contract.start_date,
    })
    .eq("id", contractId)
    .select("signature_copy_generated_at, signature_copy_start_date")
    .single();

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  logAudit(supabase, {
    entityType: "contract",
    entityId: contractId,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      action: { old: null, new: "signature_copy_downloaded" },
      signature_copy_start_date: { old: null, new: contract.start_date },
    },
  });

  return NextResponse.json({ data: updated });
}
