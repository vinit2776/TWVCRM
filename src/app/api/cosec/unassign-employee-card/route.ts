import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { setCardNumber, employeeCosecId } from "@/lib/cosec";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { zodErrorResponse } from "@/lib/validations";

const schema = z.object({
  employee_id: z.string().uuid(),
});

/**
 * POST /api/cosec/unassign-employee-card
 *
 * Clears the NFC card from an employee:
 *   1. Sets employees.nfc_card_number = null
 *   2. Calls setCardNumber("") on every enrolled device to unbind the card
 *   3. Clears nfc_card_number on all cosec_access_users rows
 *
 * Must be called before reassigning the card to another employee, otherwise
 * the UNIQUE constraint on employees.nfc_card_number will block the new assignment.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });

  const { employee_id } = parsed.data;
  const admin = createAdminClient();

  const { data: emp } = await admin
    .from("employees")
    .select("id, full_name, nfc_card_number")
    .eq("id", employee_id)
    .single();

  if (!emp) return NextResponse.json({ error: "Employee not found" }, { status: 404 });
  if (!emp.nfc_card_number) return NextResponse.json({ error: "Employee has no card assigned" }, { status: 400 });

  const previousCard = emp.nfc_card_number;
  const cosecUserId  = employeeCosecId(employee_id);
  const now          = new Date().toISOString();

  // Load all active enrollments
  const { data: enrollments } = await admin
    .from("cosec_access_users")
    .select("id, device_id, enrollment_status, device:cosec_devices(device_ip, device_port, device_password)")
    .eq("entity_id", employee_id)
    .eq("user_type", "employee")
    .neq("enrollment_status", "deleted");

  let unbound = 0;
  const failedDevices: string[] = [];

  for (const enrollment of enrollments ?? []) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dev = enrollment.device as any;
    if (!dev) continue;

    const device = { ip: dev.device_ip, port: dev.device_port, password: dev.device_password };

    try {
      // Pass empty string to clear card binding on COSEC device
      await setCardNumber(device, cosecUserId, "");
      unbound++;
    } catch {
      failedDevices.push(enrollment.device_id);
    }

    // Downgrade status from card_enrolled / fully_enrolled back to provisioned
    const currentStatus = enrollment.enrollment_status as string;
    const newStatus = currentStatus === "fully_enrolled" ? "biometric_enrolled"
      : currentStatus === "card_enrolled" ? "provisioned"
      : currentStatus;

    await admin
      .from("cosec_access_users")
      .update({ nfc_card_number: null, enrollment_status: newStatus, updated_at: now })
      .eq("id", enrollment.id);
  }

  // Clear canonical card from employee record
  await admin
    .from("employees")
    .update({ nfc_card_number: null, updated_at: now })
    .eq("id", employee_id);

  logAudit(admin, {
    entityType: "employee",
    entityId: employee_id,
    action: "update",
    performedBy: user.id,
    changes: {
      nfc_card_number: { old: previousCard, new: null },
      unbound_devices: { old: null, new: unbound },
    },
  });

  return NextResponse.json({
    ok: true,
    previousCard,
    unboundDevices: unbound,
    failedDevices: failedDevices.length,
  });
}
