import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { provisionUser, contractCosecId, employeeCosecId } from "@/lib/cosec";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

const schema = z.object({
  access_user_id: z.string().uuid(),
});

/**
 * POST /api/cosec/provision-user
 *
 * Manually trigger provisioning of a cosec_access_users row onto the device.
 * Normally called automatically on contract activation, but exposed for
 * manual re-provision from the admin UI (e.g. after a device reset).
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const admin = createAdminClient();

  const { data: accessUser, error: auErr } = await admin
    .from("cosec_access_users")
    .select("*, device:cosec_devices(device_ip, device_port, device_password)")
    .eq("id", parsed.data.access_user_id)
    .single();

  if (auErr || !accessUser) {
    return NextResponse.json({ error: "Access user not found" }, { status: 404 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dev = accessUser.device as any;
  const device = { ip: dev.device_ip, port: dev.device_port, password: dev.device_password };

  // Load the entity to get name and validity
  let name = "User";
  let validUntil: Date | undefined;

  if (accessUser.user_type === "contract") {
    const { data: contract } = await admin
      .from("contracts")
      .select("contract_number, end_date, lead:leads!contracts_lead_id_fkey(company, first_name, last_name)")
      .eq("id", accessUser.entity_id)
      .single();
    if (contract) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lead = contract.lead as any;
      name = (lead?.company || `${lead?.first_name || ""} ${lead?.last_name || ""}`.trim() || contract.contract_number).slice(0, 15);
      if (contract.end_date) validUntil = new Date(contract.end_date);
    }
  } else if (accessUser.user_type === "employee") {
    const { data: emp } = await admin
      .from("employees")
      .select("full_name")
      .eq("id", accessUser.entity_id)
      .single();
    if (emp) name = emp.full_name.slice(0, 15);
  }

  try {
    await provisionUser(device, {
      cosecUserId: accessUser.cosec_user_id,
      cosecRefId: accessUser.cosec_ref_id,
      name,
      userActive: false, // stays inactive until biometric enrolled
      validUntil,
      selfEnrollmentEnable: true,
      pin: accessUser.access_pin || undefined,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Provision failed" },
      { status: 422 }
    );
  }

  await admin
    .from("cosec_access_users")
    .update({
      enrollment_status: "provisioned",
      provisioned_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", parsed.data.access_user_id);

  logAudit(admin, {
    entityType: "contract",
    entityId: accessUser.entity_id,
    action: "update",
    performedBy: user.id,
    changes: { cosec_provisioned: { old: null, new: accessUser.cosec_user_id } },
  });

  return NextResponse.json({ ok: true, cosecUserId: accessUser.cosec_user_id });
}
