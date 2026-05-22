import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

/**
 * GET /api/contracts/[id]/cosec-wizard
 *
 * Returns all COSEC access users for this contract (both contract-level and
 * member-level), enriched with member info, device label, and first access
 * event. Powers the CosecAccessWizard lifecycle component.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: contractId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  // Fetch active members for this contract
  const { data: members } = await admin
    .from("contract_members")
    .select("id, name, phone")
    .eq("contract_id", contractId)
    .eq("is_active", true);

  const memberIds = (members ?? []).map((m) => m.id);
  const memberMap = new Map((members ?? []).map((m) => [m.id, m]));

  // All entity IDs: the contract itself + its members
  const entityIds = [contractId, ...memberIds];

  // Fetch all cosec_access_users for these entities.
  // Only entry_point devices belong in the onboarding wizard —
  // business_centre devices are booking-driven and excluded here.
  const { data: accessUsers } = await admin
    .from("cosec_access_users")
    .select(
      "id, entity_id, user_type, cosec_ref_id, enrollment_status, access_pin, nfc_card_number, provisioned_at, biometric_enrolled_at, card_enrolled_at, device_id, cosec_user_id, device:cosec_devices(id, label, device_category)"
    )
    .in("entity_id", entityIds)
    .not("enrollment_status", "in", "(blocked,deleted)")
    .order("provisioned_at", { ascending: true });

  if (!accessUsers || accessUsers.length === 0) {
    return NextResponse.json({ data: [] });
  }

  // Exclude business_centre devices — those are booking-only and not part of
  // the permanent member onboarding flow.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const entryPointUsers = (accessUsers as any[]).filter(
    (au) => (au.device as any)?.device_category !== "business_centre"
  );

  // First access (IN event) per entity — used for "Verified" step
  const { data: firstLogs } = await admin
    .from("access_logs")
    .select("entity_id, event_time")
    .in("entity_id", entityIds)
    .eq("direction", "IN")
    .order("event_time", { ascending: true })
    .limit(entityIds.length * 3);

  const firstLogMap = new Map<string, string>();
  for (const log of firstLogs ?? []) {
    if (log.entity_id && !firstLogMap.has(log.entity_id)) {
      firstLogMap.set(log.entity_id, log.event_time);
    }
  }

  // Latest presence per entity — used for "last seen"
  const { data: presence } = await admin
    .from("cosec_presence")
    .select("entity_id, is_inside, updated_at")
    .in("entity_id", entityIds);

  const presenceMap = new Map(
    (presence ?? []).map((p) => [p.entity_id, p])
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const enriched = (entryPointUsers as any[]).map((au) => {
    const member =
      au.user_type === "member" ? memberMap.get(au.entity_id) : null;
    const p = presenceMap.get(au.entity_id);
    return {
      id: au.id,
      entity_id: au.entity_id,
      user_type: au.user_type,
      cosec_ref_id: au.cosec_ref_id,
      enrollment_status: au.enrollment_status,
      access_pin: au.access_pin,
      nfc_card_number: au.nfc_card_number,
      provisioned_at: au.provisioned_at,
      biometric_enrolled_at: au.biometric_enrolled_at,
      card_enrolled_at: au.card_enrolled_at,
      device_id: au.device_id,
      device_label: au.device?.label ?? "Device",
      device_category: au.device?.device_category ?? "entry_point",
      entity_name: member?.name ?? null,
      phone: member?.phone ?? null,
      first_access_at: firstLogMap.get(au.entity_id) ?? null,
      last_seen_at: p?.updated_at ?? null,
      is_inside: p?.is_inside ?? null,
    };
  });

  return NextResponse.json({ data: enriched });
}
