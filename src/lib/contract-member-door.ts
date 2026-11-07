/**
 * Provision a contract member on every entry-point COSEC device at the
 * contract's location and text them their enrollment PIN.
 *
 * This is the "issue door access" step. It used to run inline when a member
 * was added; it is now its own action so a person can be recorded first and
 * have access issued afterwards. It sends a real SMS, so only call it from an
 * explicit user action (or the legacy add-member route, which always did).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { provisionUser, memberCosecId, uuidToRefId, generatePin } from "@/lib/cosec";

export interface ProvisionDoorResult {
  /** Devices at the location that were tried. 0 means there is nothing to provision on. */
  devices: number;
  /** Devices the member was actually provisioned on. */
  provisioned: number;
}

export async function provisionMemberDoor(
  admin: SupabaseClient,
  contract: { id: string; location_id: string | null; end_date: string | null },
  member: { id: string; name: string; phone: string }
): Promise<ProvisionDoorResult> {
  if (!contract.location_id) return { devices: 0, provisioned: 0 };

  const { data: devices } = await admin
    .from("cosec_devices")
    .select("id, device_ip, device_port, device_password")
    .eq("location_id", contract.location_id)
    .eq("is_enabled", true)
    .eq("device_category", "entry_point"); // business_centre devices (conference/meeting rooms) are excluded

  if (!devices || devices.length === 0) return { devices: 0, provisioned: 0 };

  const cosecUserId = memberCosecId(member.id);
  const cosecRefId = uuidToRefId(member.id, 1, 49999);
  const pin = generatePin();
  const validUntil = contract.end_date ? new Date(contract.end_date) : undefined;
  const now = new Date().toISOString();

  const results = await Promise.allSettled(
    devices.map(async (dev) => {
      await provisionUser(
        { ip: dev.device_ip, port: dev.device_port, password: dev.device_password },
        {
          cosecUserId,
          cosecRefId,
          name: member.name.slice(0, 15),
          userActive: false,
          validUntil,
          pin,
          selfEnrollmentEnable: true,
        }
      );
      await admin.from("cosec_access_users").upsert(
        {
          device_id: dev.id,
          cosec_user_id: cosecUserId,
          cosec_ref_id: cosecRefId,
          user_type: "member",
          entity_id: member.id,
          enrollment_status: "provisioned",
          access_pin: pin,
          valid_until: contract.end_date ?? null,
          provisioned_at: now,
          updated_at: now,
        },
        { onConflict: "device_id,cosec_user_id" }
      );
    })
  );
  results.forEach((r, i) => {
    if (r.status === "rejected") console.error(`[member-door] provision failed on device ${devices[i].id}:`, r.reason);
  });

  // Send enrollment PIN via WhatsApp + SMS (same as the original add-member flow)
  const { dltSms } = await import("@/lib/whatsapp");
  dltSms.otp(member.phone, pin, member.id).catch(() => null);

  return { devices: devices.length, provisioned: results.filter((r) => r.status === "fulfilled").length };
}
