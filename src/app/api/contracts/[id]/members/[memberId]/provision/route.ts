import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { provisionMemberAccess } from "@/lib/cosec";
import { logAudit } from "@/lib/audit";

/**
 * POST /api/contracts/[id]/members/[memberId]/provision
 *
 * Manually (re-)provision a contract member onto their location's COSEC
 * devices. Safety net for members that never got auto-provisioned — e.g.
 * added while the contract was still draft, before the activation backfill
 * existed, or where the device call failed the first time.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; memberId: string }> }
) {
  const { id: contractId, memberId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  const { data: contract } = await admin
    .from("contracts")
    .select("id, location_id, end_date")
    .eq("id", contractId)
    .single();
  if (!contract) return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  if (!contract.location_id) {
    return NextResponse.json({ error: "Contract has no location — cannot determine which devices to provision" }, { status: 400 });
  }

  const { data: member } = await admin
    .from("contract_members")
    .select("id, name, phone, is_active")
    .eq("id", memberId)
    .eq("contract_id", contractId)
    .single();
  if (!member) return NextResponse.json({ error: "Member not found" }, { status: 404 });
  if (!member.is_active) return NextResponse.json({ error: "Member is no longer active on this contract" }, { status: 400 });

  const result = await provisionMemberAccess(admin, {
    memberId: member.id,
    memberName: member.name,
    memberPhone: member.phone,
    locationId: contract.location_id,
    contractEndDate: contract.end_date,
  });

  if (result.provisionedDeviceCount === 0) {
    return NextResponse.json({ error: result.skippedReason ?? "Provisioning failed" }, { status: 422 });
  }

  const { data: dbUser } = await supabase.from("users").select("id").eq("auth_id", user.id).single();
  logAudit(admin, {
    entityType: "contract",
    entityId: contractId,
    action: "update",
    performedBy: dbUser?.id ?? null,
    changes: { cosec_provisioned: { old: null, new: `member:${member.id}` } },
  });

  return NextResponse.json({ ok: true, deviceCount: result.provisionedDeviceCount });
}
