/**
 * POST /api/cosec/employee-device-access
 *
 * Provisions an employee on one specific COSEC device using a given access
 * profile. Sets the COSEC user-group from the profile so the device enforces
 * the configured time-zone restrictions.
 *
 * Body: { employee_id, device_id, access_profile_id, valid_from?, valid_until? }
 *
 * DELETE /api/cosec/employee-device-access
 *
 * Removes an employee's access from one specific device.
 * Body: { employee_id, device_id }
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { provisionUser, setUserActive, deleteUserFromDevice, employeeCosecId } from "@/lib/cosec";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { zodErrorResponse } from "@/lib/validations";

const grantSchema = z.object({
  employee_id:       z.string().uuid(),
  device_id:         z.string().uuid(),
  access_profile_id: z.string().uuid(),
  valid_from:        z.string().optional(),  // ISO date string
  valid_until:       z.string().optional(),  // ISO date string — null = no expiry
});

const revokeSchema = z.object({
  employee_id: z.string().uuid(),
  device_id:   z.string().uuid(),
});

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = grantSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });

  const { employee_id, device_id, access_profile_id, valid_from, valid_until } = parsed.data;
  const admin = createAdminClient();

  // Load employee
  const { data: emp } = await admin
    .from("employees")
    .select("id, full_name, cosec_ref_id, nfc_card_number, is_active")
    .eq("id", employee_id)
    .single();
  if (!emp) return NextResponse.json({ error: "Employee not found" }, { status: 404 });
  if (!emp.is_active) return NextResponse.json({ error: "Employee is inactive" }, { status: 400 });
  if (!emp.cosec_ref_id) return NextResponse.json({ error: "Employee has no COSEC ref ID" }, { status: 400 });

  // Load device
  const { data: dev } = await admin
    .from("cosec_devices")
    .select("id, device_ip, device_port, device_password, label, is_enabled")
    .eq("id", device_id)
    .single();
  if (!dev || !dev.is_enabled) return NextResponse.json({ error: "Device not found or disabled" }, { status: 404 });

  // Load profile
  const { data: profile } = await admin
    .from("employee_access_profiles")
    .select("*")
    .eq("id", access_profile_id)
    .single();
  if (!profile) return NextResponse.json({ error: "Access profile not found" }, { status: 404 });

  const cosecUserId = employeeCosecId(employee_id);
  const cosecRefId  = emp.cosec_ref_id;
  const device      = { ip: dev.device_ip, port: dev.device_port as number, password: dev.device_password };
  const validUntil  = valid_until ? new Date(valid_until) : null;

  try {
    // Check for existing enrollment
    const { data: existing } = await admin
      .from("cosec_access_users")
      .select("id, enrollment_status")
      .eq("entity_id", employee_id)
      .eq("device_id", device_id)
      .eq("user_type", "employee")
      .maybeSingle();

    if (existing && existing.enrollment_status !== "deleted") {
      // Re-activate and update profile
      await setUserActive(device, cosecUserId, true);
      await admin
        .from("cosec_access_users")
        .update({
          access_profile_id,
          valid_from: valid_from ?? null,
          valid_until: valid_until ?? null,
          enrollment_status: "provisioned",
          blocked_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id);
    } else {
      // Fresh provision
      await provisionUser(device, {
        cosecUserId,
        cosecRefId,
        name: emp.full_name.slice(0, 15),
        userActive: true,
        validUntil: validUntil ?? undefined,
        userGroup: profile.cosec_user_group,
        byPassFinger: true, // card-only until biometric enrolled
        ...(emp.nfc_card_number ? { card1: emp.nfc_card_number } : {}),
      });

      // Upsert cosec_access_users
      await admin.from("cosec_access_users").upsert(
        {
          device_id,
          entity_id: employee_id,
          user_type: "employee",
          cosec_user_id: cosecUserId,
          cosec_ref_id: cosecRefId,
          enrollment_status: emp.nfc_card_number ? "card_enrolled" : "provisioned",
          nfc_card_number: emp.nfc_card_number ?? null,
          access_profile_id,
          valid_from: valid_from ?? null,
          valid_until: valid_until ?? null,
          provisioned_at: new Date().toISOString(),
        },
        { onConflict: "entity_id,device_id,user_type" }
      );
    }

    await logAudit(admin, {
      entityType:  "employee",
      entityId:    employee_id,
      action:      "create",
      performedBy: user.id,
      changes: {
        device_access: { old: null, new: `${dev.label} (${profile.name})${valid_until ? ` until ${valid_until}` : ""}` },
      },
    });

    return NextResponse.json({ ok: true, device: dev.label, profile: profile.name });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Provisioning failed" },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = revokeSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });

  const { employee_id, device_id } = parsed.data;
  const admin = createAdminClient();

  const [{ data: emp }, { data: dev }, { data: enrollment }] = await Promise.all([
    admin.from("employees").select("id, full_name").eq("id", employee_id).single(),
    admin.from("cosec_devices").select("id, device_ip, device_port, device_password, label").eq("id", device_id).single(),
    admin.from("cosec_access_users")
      .select("id, cosec_user_id")
      .eq("entity_id", employee_id).eq("device_id", device_id).eq("user_type", "employee")
      .neq("enrollment_status", "deleted").maybeSingle(),
  ]);

  if (!emp || !dev) return NextResponse.json({ error: "Employee or device not found" }, { status: 404 });
  if (!enrollment) return NextResponse.json({ error: "No active enrollment found" }, { status: 404 });

  try {
    const device = { ip: dev.device_ip, port: dev.device_port as number, password: dev.device_password };
    await deleteUserFromDevice(device, enrollment.cosec_user_id);

    await admin
      .from("cosec_access_users")
      .update({ enrollment_status: "deleted", deleted_at: new Date().toISOString() })
      .eq("id", enrollment.id);

    await logAudit(admin, {
      entityType:  "employee",
      entityId:    employee_id,
      action:      "delete",
      performedBy: user.id,
      changes: {
        device_access: { old: dev.label, new: null },
      },
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Revocation failed" },
      { status: 500 }
    );
  }
}
