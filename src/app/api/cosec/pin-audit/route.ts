import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { getUserPin } from "@/lib/cosec";

export const maxDuration = 60;

/**
 * GET /api/cosec/pin-audit
 *
 * Checks every CRM-known user (including deleted/blocked) against the device
 * to see if they still have an active PIN. Surfaces users whose PIN was never
 * cleared after access was revoked — the most common source of orphaned PINs.
 *
 * Note: COSEC action=list is not supported by this device firmware.
 * We enumerate via CRM cosec_ref_id records instead.
 */
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  // Fetch devices and ALL CRM enrollments (including deleted/blocked) in parallel
  const [{ data: devices }, { data: crmRows }] = await Promise.all([
    admin.from("cosec_devices")
      .select("id, label, device_ip, device_port, device_password, location:locations(name)"),
    admin.from("cosec_access_users")
      .select("id, cosec_user_id, cosec_ref_id, user_type, entity_id, device_id, enrollment_status, pin_issued_at"),
  ]);

  if (!devices?.length || !crmRows?.length) {
    return NextResponse.json({ data: [], total: 0, device_errors: [] });
  }

  // Build device lookup map
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const deviceMap = new Map(devices.map((d: any) => [d.id, d]));

  // Collect entity IDs by type for name resolution
  const byType: Record<string, string[]> = { contract: [], member: [], employee: [], booking: [] };
  for (const r of crmRows) {
    if (r.user_type in byType) byType[r.user_type].push(r.entity_id);
  }

  const [contracts, employees, bookings, members] = await Promise.all([
    byType.contract.length
      ? admin.from("contracts")
          .select("id, contract_number, status, lead:leads!contracts_lead_id_fkey(company, first_name, last_name)")
          .in("id", byType.contract)
      : { data: [] },
    byType.employee.length
      ? admin.from("employees").select("id, full_name").in("id", byType.employee)
      : { data: [] },
    byType.booking.length
      ? admin.from("bookings").select("id, booking_number, guest_name, status").in("id", byType.booking)
      : { data: [] },
    byType.member.length
      ? admin.from("contract_members")
          .select("id, name, contract:contracts(contract_number, status)")
          .in("id", byType.member)
      : { data: [] },
  ]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const entityMap = new Map<string, { name: string; ref: string; status?: string }>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (contracts.data ?? []).forEach((c: any) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lead = Array.isArray(c.lead) ? c.lead[0] : (c.lead as any);
    entityMap.set(c.id, {
      name: lead?.company || `${lead?.first_name ?? ""} ${lead?.last_name ?? ""}`.trim() || c.contract_number,
      ref: c.contract_number,
      status: c.status,
    });
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (employees.data ?? []).forEach((e: any) => entityMap.set(e.id, { name: e.full_name, ref: "Employee" }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (bookings.data ?? []).forEach((b: any) => entityMap.set(b.id, {
    name: b.guest_name || `Booking #${b.booking_number}`, ref: `#${b.booking_number}`, status: b.status,
  }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (members.data ?? []).forEach((m: any) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contract = Array.isArray(m.contract) ? m.contract[0] : (m.contract as any);
    entityMap.set(m.id, { name: m.name, ref: contract?.contract_number, status: contract?.status });
  });

  type PinAuditRow = {
    device_id: string;
    device_label: string;
    location_name: string;
    cosec_user_id: string;
    crm_name: string | null;
    crm_ref: string | null;
    crm_type: string | null;
    crm_status: string | null;
    enrollment_status: string;
    pin_issued_at: string | null;
    is_stale: boolean;
  };

  const results: PinAuditRow[] = [];
  const device_errors: { device_label: string; error: string }[] = [];
  const deviceErrorSet = new Set<string>();

  // Filter to rows that have a cosec_ref_id and a known device
  const checkableRows = crmRows.filter(r => r.cosec_ref_id != null && deviceMap.has(r.device_id));

  // Check all users in parallel
  await Promise.allSettled(
    checkableRows.map(async (r) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dev = deviceMap.get(r.device_id) as any;
      const deviceObj = { ip: dev.device_ip, port: dev.device_port, password: dev.device_password };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const loc = Array.isArray(dev.location) ? dev.location[0] : (dev.location as any);

      let pin: string;
      try {
        pin = await getUserPin(deviceObj, r.cosec_ref_id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!deviceErrorSet.has(dev.id)) {
          deviceErrorSet.add(dev.id);
          device_errors.push({ device_label: dev.label, error: msg });
        }
        return;
      }

      if (!pin) return; // no PIN on device

      const entity = entityMap.get(r.entity_id);
      const isStale = r.enrollment_status === "deleted" || r.enrollment_status === "blocked";

      results.push({
        device_id: dev.id,
        device_label: dev.label,
        location_name: loc?.name ?? "",
        cosec_user_id: r.cosec_user_id,
        crm_name: entity?.name ?? null,
        crm_ref: entity?.ref ?? null,
        crm_type: r.user_type ?? null,
        crm_status: entity?.status ?? null,
        enrollment_status: r.enrollment_status,
        pin_issued_at: r.pin_issued_at ?? null,
        is_stale: isStale,
      });
    })
  );

  results.sort((a, b) => {
    if (a.is_stale !== b.is_stale) return a.is_stale ? -1 : 1;
    return a.device_label.localeCompare(b.device_label) || (a.crm_name ?? "").localeCompare(b.crm_name ?? "");
  });

  return NextResponse.json({ data: results, total: results.length, device_errors });
}
