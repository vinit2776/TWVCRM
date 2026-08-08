import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { provisionUser, setCardNumber, employeeCosecId, generatePin } from "@/lib/cosec";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { zodErrorResponse } from "@/lib/validations";

const schema = z.object({
  employee_id: z.string().uuid(),
});

/**
 * POST /api/cosec/provision-employee-all-locations
 *
 * Provisions an employee on every enabled entry_point COSEC device across
 * all locations. Idempotent — skips devices where the employee is already
 * enrolled. Also sets the NFC card on all devices if the employee already
 * has a card assigned.
 *
 * Returns { provisioned, alreadyEnrolled, failed[] } summary.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });

  const { employee_id } = parsed.data;
  const admin = createAdminClient();

  // Load employee
  const { data: emp, error: empErr } = await admin
    .from("employees")
    .select("id, full_name, cosec_ref_id, nfc_card_number, is_active")
    .eq("id", employee_id)
    .single();

  if (empErr || !emp) return NextResponse.json({ error: "Employee not found" }, { status: 404 });
  if (!emp.is_active) return NextResponse.json({ error: "Employee is inactive" }, { status: 400 });
  if (!emp.cosec_ref_id) return NextResponse.json({ error: "Employee has no cosec_ref_id assigned" }, { status: 400 });

  // Load all enabled entry_point devices
  const { data: devices, error: devErr } = await admin
    .from("cosec_devices")
    .select("id, device_ip, device_port, device_password, label, location_id, location:locations(name)")
    .eq("is_enabled", true)
    .eq("device_category", "entry_point");

  if (devErr || !devices || devices.length === 0) {
    return NextResponse.json({ error: "No enabled entry_point devices found" }, { status: 404 });
  }

  // Load existing enrollments for this employee to skip already-provisioned devices
  const { data: existing } = await admin
    .from("cosec_access_users")
    .select("device_id, enrollment_status, id")
    .eq("entity_id", employee_id)
    .eq("user_type", "employee")
    .neq("enrollment_status", "deleted");

  const existingByDevice = new Map((existing ?? []).map(e => [e.device_id, e]));

  const cosecUserId = employeeCosecId(employee_id);
  const cosecRefId  = emp.cosec_ref_id;
  const name        = emp.full_name.slice(0, 15);
  const now         = new Date().toISOString();

  let provisioned    = 0;
  let alreadyEnrolled = 0;
  const failed: { device_id: string; label: string; error: string }[] = [];

  for (const dev of devices) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const loc = dev.location as any;
    const device = { ip: dev.device_ip, port: dev.device_port as number, password: dev.device_password };

    const existing = existingByDevice.get(dev.id);

    if (existing && existing.enrollment_status !== "blocked") {
      // Already enrolled — if card just became available, push it
      if (emp.nfc_card_number && !existing) {
        try {
          await setCardNumber(device, cosecUserId, emp.nfc_card_number);
        } catch {
          // Best-effort card sync — don't fail the whole operation
        }
      }
      alreadyEnrolled++;
      continue;
    }

    const pin = generatePin();

    try {
      await provisionUser(device, {
        cosecUserId,
        cosecRefId,
        name,
        userActive: true,
        pin,
        byPassFinger: true, // employees can use card or PIN without biometric requirement
        card1: emp.nfc_card_number ?? undefined,
        selfEnrollmentEnable: true,
      });
    } catch (err) {
      failed.push({
        device_id: dev.id,
        label: `${loc?.name ?? ""} – ${dev.label}`,
        error: err instanceof Error ? err.message : "Unknown error",
      });
      continue;
    }

    // Upsert cosec_access_users row
    await admin.from("cosec_access_users").upsert(
      {
        device_id:         dev.id,
        cosec_user_id:     cosecUserId,
        cosec_ref_id:      cosecRefId,
        user_type:         "employee",
        entity_id:         employee_id,
        enrollment_status: emp.nfc_card_number ? "card_enrolled" : "provisioned",
        access_pin:        pin,
        nfc_card_number:   emp.nfc_card_number ?? null,
        valid_until:       null,
        provisioned_at:    now,
        card_enrolled_at:  emp.nfc_card_number ? now : null,
        updated_at:        now,
      },
      { onConflict: "device_id,cosec_user_id" }
    );

    provisioned++;
  }

  logAudit(admin, {
    entityType: "employee",
    entityId: employee_id,
    action: "update",
    performedBy: user.id,
    changes: {
      cosec_provisioned_all_locations: {
        old: null,
        new: { provisioned, alreadyEnrolled, failed: failed.length },
      },
    },
  });

  return NextResponse.json({
    ok: true,
    provisioned,
    alreadyEnrolled,
    failed,
    totalDevices: devices.length,
  });
}
