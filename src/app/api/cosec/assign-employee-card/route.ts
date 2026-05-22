import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { readCardFromDevice, setCardNumber, employeeCosecId } from "@/lib/cosec";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

const schema = z.object({
  employee_id: z.string().uuid(),
  scan_device_id: z.string().uuid(), // which device to physically scan on
});

/**
 * POST /api/cosec/assign-employee-card
 *
 * Reads an NFC card from the chosen device, then propagates the CSN to:
 *   1. employees.nfc_card_number (canonical)
 *   2. All cosec_access_users rows for the employee (all devices)
 *
 * The caller blocks for up to 20 seconds while waiting for card tap.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const { employee_id, scan_device_id } = parsed.data;
  const admin = createAdminClient();

  // Load scan device
  const { data: scanDev } = await admin
    .from("cosec_devices")
    .select("device_ip, device_port, device_password, label")
    .eq("id", scan_device_id)
    .single();

  if (!scanDev) return NextResponse.json({ error: "Scan device not found" }, { status: 404 });

  // Load employee + all their enrollments
  const [{ data: emp }, { data: enrollments }] = await Promise.all([
    admin.from("employees").select("id, full_name, cosec_ref_id").eq("id", employee_id).single(),
    admin
      .from("cosec_access_users")
      .select("id, cosec_user_id, device_id, enrollment_status, device:cosec_devices(device_ip, device_port, device_password)")
      .eq("entity_id", employee_id)
      .eq("user_type", "employee")
      .neq("enrollment_status", "deleted"),
  ]);

  if (!emp) return NextResponse.json({ error: "Employee not found" }, { status: 404 });

  const scanDevice = { ip: scanDev.device_ip, port: scanDev.device_port as number, password: scanDev.device_password };

  // Block up to 20s waiting for physical card tap
  let cardNumber: string;
  try {
    const result = await readCardFromDevice(scanDevice);
    cardNumber = result.cardNumber;
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "No card detected. Tap card on the device reader." },
      { status: 408 }
    );
  }

  const cosecUserId = employeeCosecId(employee_id);
  const now = new Date().toISOString();

  // Update canonical employee record
  await admin
    .from("employees")
    .update({ nfc_card_number: cardNumber, updated_at: now })
    .eq("id", employee_id);

  // Propagate card to all enrolled devices
  const propagated: string[] = [];
  const propagationFailed: string[] = [];

  for (const enrollment of enrollments ?? []) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dev = enrollment.device as any;
    if (!dev) continue;

    const device = { ip: dev.device_ip, port: dev.device_port, password: dev.device_password };

    try {
      await setCardNumber(device, cosecUserId, cardNumber);
      propagated.push(enrollment.device_id);
    } catch {
      propagationFailed.push(enrollment.device_id);
    }

    // Update DB row
    const currentStatus = enrollment.enrollment_status as string;
    const newStatus =
      currentStatus === "biometric_enrolled" || currentStatus === "fully_enrolled"
        ? "fully_enrolled"
        : "card_enrolled";

    await admin
      .from("cosec_access_users")
      .update({
        nfc_card_number: cardNumber,
        enrollment_status: newStatus,
        card_enrolled_at: now,
        updated_at: now,
      })
      .eq("id", enrollment.id);
  }

  logAudit(admin, {
    entityType: "employee",
    entityId: employee_id,
    action: "update",
    performedBy: user.id,
    changes: {
      nfc_card_number: { old: null, new: cardNumber },
      propagated_to_devices: { old: null, new: propagated.length },
    },
  });

  return NextResponse.json({
    ok: true,
    cardNumber,
    propagatedToDevices: propagated.length,
    failedDevices: propagationFailed.length,
  });
}
