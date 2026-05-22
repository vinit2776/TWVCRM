import { NextRequest, NextResponse } from "next/server";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import { getUserByRefId, setUserActive } from "@/lib/cosec";
import { logAudit } from "@/lib/audit";

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    // Allow cookie-based admin session
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    // Check role
    const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
    if (!profile || !["admin", "manager"].includes(profile.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  const body = await request.json();
  const { device_id, cosec_ref_id, contract_id } = body as {
    device_id: string;
    cosec_ref_id: number;
    contract_id: string;
  };

  if (!device_id || !cosec_ref_id || !contract_id) {
    return NextResponse.json({ error: "device_id, cosec_ref_id, contract_id required" }, { status: 400 });
  }

  const admin = createAdminClient();

  // 1. Fetch device credentials
  const { data: dev, error: devErr } = await admin
    .from("cosec_devices")
    .select("id, device_ip, device_port, device_password")
    .eq("id", device_id)
    .single();
  if (devErr || !dev) return NextResponse.json({ error: "Device not found" }, { status: 404 });

  // 2. Fetch contract to get valid_until and entity name
  const { data: contract, error: contractErr } = await admin
    .from("contracts")
    .select("id, contract_number, valid_until, lead:leads!contracts_lead_id_fkey(first_name, last_name, company)")
    .eq("id", contract_id)
    .single();
  if (contractErr || !contract) return NextResponse.json({ error: "Contract not found" }, { status: 404 });

  // 3. Check if already linked
  const { data: existing } = await admin
    .from("cosec_access_users")
    .select("id")
    .eq("device_id", device_id)
    .eq("cosec_ref_id", cosec_ref_id)
    .maybeSingle();
  if (existing) return NextResponse.json({ error: "This ref ID is already linked" }, { status: 409 });

  // 4. Auto-query device for cosec_user_id
  const deviceCreds = { ip: dev.device_ip, port: dev.device_port, password: dev.device_password };
  const userInfo = await getUserByRefId(deviceCreds, cosec_ref_id);
  if (!userInfo?.userId) {
    return NextResponse.json(
      { error: `Cannot find user with ref #${cosec_ref_id} on device. Make sure this ref ID exists on the device.` },
      { status: 422 }
    );
  }

  // 5. Derive entity name
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lead = contract.lead as any;
  const entityName = lead?.company
    || (lead ? `${lead.first_name ?? ""} ${lead.last_name ?? ""}`.trim() : "")
    || contract.contract_number;

  // 6. Insert cosec_access_users record
  const now = new Date().toISOString();
  const { data: newUser, error: insertErr } = await admin
    .from("cosec_access_users")
    .insert({
      device_id,
      cosec_user_id: userInfo.userId,
      cosec_ref_id,
      user_type: "contract",
      entity_id: contract_id,
      enrollment_status: "biometric_enrolled", // already enrolled on device
      biometric_enrolled_at: now,
      valid_until: contract.valid_until,
      provisioned_at: now,
      updated_at: now,
    })
    .select("id")
    .single();

  if (insertErr || !newUser) {
    return NextResponse.json({ error: insertErr?.message || "Failed to create access user" }, { status: 500 });
  }

  // 7. Audit trail — linking a device user to a contract
  // Note: this endpoint accepts both cookie-auth and cron token. Only log when it's a human session.
  const sessionUser = await (async () => {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    return user;
  })().catch(() => null);
  if (sessionUser) {
    logAudit(admin, {
      entityType: "cosec_access_user",
      entityId: newUser.id,
      action: "create",
      performedBy: sessionUser.id,
      changes: {
        device_id: { old: null, new: device_id },
        contract_id: { old: null, new: contract_id },
        cosec_ref_id: { old: null, new: cosec_ref_id },
        cosec_user_id: { old: null, new: userInfo.userId },
      },
    });
  }

  // 8. Backfill access_logs — update entity_id and entity_name for this ref_id on this device
  await admin
    .from("access_logs")
    .update({ entity_id: contract_id, entity_name: entityName, user_type: "contract" })
    .eq("device_id", device_id)
    .eq("cosec_ref_id", cosec_ref_id)
    .is("entity_id", null);

  // 9. If device user is inactive, activate it (set valid_until on device)
  try {
    await setUserActive(deviceCreds, userInfo.userId, true);
  } catch { /* non-fatal — device may already be active */ }

  return NextResponse.json({ ok: true, cosec_user_id: userInfo.userId, entity_name: entityName });
}
