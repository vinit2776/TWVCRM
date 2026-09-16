import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

const CONTRACT_MANAGE_ROLES = ["admin", "manager", "sales_rep"];

const bodySchema = z.object({
  signatureStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/**
 * POST /api/contracts/[id]/mark-signature-copy
 *
 * Records that a watermark-free copy was just downloaded (DRAFT watermark
 * unticked) while start_date isn't confirmed yet, and snapshots the start
 * date printed on it. This route never touches contract.start_date. If the
 * real start_date
 * later differs from this snapshot, the UI compares them to warn staff that
 * the signed copy is now stale and needs to be re-sent.
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

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "signatureStartDate (YYYY-MM-DD) is required" }, { status: 400 });
  }
  const { signatureStartDate } = parsed.data;

  const { data: contract } = await supabase
    .from("contracts")
    .select("id")
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
      signature_copy_start_date: signatureStartDate,
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
      signature_copy_start_date: { old: null, new: signatureStartDate },
    },
  });

  return NextResponse.json({ data: updated });
}
