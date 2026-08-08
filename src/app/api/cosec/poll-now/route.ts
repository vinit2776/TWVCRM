import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { pollEvents, COSEC_EVENT, COSEC_DENIAL_REASON, parseDirection } from "@/lib/cosec";
import { z } from "zod";
import { zodErrorResponse } from "@/lib/validations";

const schema = z.object({
  device_id: z.string().uuid(),
  // If true, drain without writing to access_logs — just advances the cursor
  skip_history: z.boolean().optional().default(false),
});

/**
 * POST /api/cosec/poll-now
 *
 * Manual trigger for one poll cycle on a specific device.
 * Identical to the cron logic but callable by an authenticated admin.
 * Use skip_history=true to fast-forward the cursor past old events
 * without writing them to access_logs.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  }
  const { device_id, skip_history } = parsed.data;

  const admin = createAdminClient();

  const { data: dev, error: devErr } = await admin
    .from("cosec_devices")
    .select("id, device_ip, device_port, device_password, last_roll_over_count, last_seq_number, is_enabled")
    .eq("id", device_id)
    .single();

  if (devErr || !dev) {
    return NextResponse.json({ error: "Device not found" }, { status: 404 });
  }
  if (!dev.is_enabled) {
    return NextResponse.json({ error: "Device is disabled" }, { status: 400 });
  }

  const device = { ip: dev.device_ip, port: dev.device_port, password: dev.device_password };

  try {
    // When skipping history, drain in large batches (1000) without writing logs
    const maxEvents = skip_history ? 1000 : 100;
    let totalEvents = 0;
    let logsWritten = 0;
    let currentRollOver = dev.last_roll_over_count;
    let currentSeq = dev.last_seq_number;
    let rounds = 0;
    const maxRounds = skip_history ? 200 : 1; // up to 200k events for skip, 100 for normal poll

    do {
      const { events, lastRollOverCount, lastSeqNumber } = await pollEvents(
        device,
        currentRollOver,
        currentSeq + 1,
        maxEvents,
      );

      if (events.length === 0) break;

      totalEvents += events.length;
      currentRollOver = lastRollOverCount;
      currentSeq = lastSeqNumber;
      rounds++;

      if (!skip_history) {
        // Same entity resolution + log writing logic as the cron
        const refIds = [...new Set(events.map(e => e.refUserId).filter(Boolean))];
        const { data: accessUsers } = await admin
          .from("cosec_access_users")
          .select("id, cosec_ref_id, entity_id, user_type, enrollment_status, nfc_card_number")
          .eq("device_id", device_id)
          .in("cosec_ref_id", refIds);

        const refMap = new Map((accessUsers ?? []).map(u => [u.cosec_ref_id, u]));
        const entityNames = await resolveEntityNames(admin, accessUsers ?? []);

        const accessLogsToInsert: Record<string, unknown>[] = [];
        const presenceUpserts: Record<string, unknown>[] = [];
        const now = new Date().toISOString();

        for (const event of events) {
          const accessUser = refMap.get(event.refUserId);
          const entityName = accessUser
            ? (entityNames.get(accessUser.entity_id) ?? `Ref #${event.refUserId}`)
            : `Ref #${event.refUserId}`;

          if (event.eventId === COSEC_EVENT.ENROLLMENT_COMPLETE && accessUser) {
            await admin.from("cosec_access_users").update({
              enrollment_status: "biometric_enrolled",
              biometric_enrolled_at: event.eventTime.toISOString(),
              updated_at: now,
            }).eq("id", accessUser.id);
            continue;
          }

          if (event.eventId === 406 && accessUser) {
            await admin.from("cosec_access_users").update({
              enrollment_status: accessUser.enrollment_status === "biometric_enrolled"
                ? "fully_enrolled" : "card_enrolled",
              card_enrolled_at: event.eventTime.toISOString(),
              updated_at: now,
            }).eq("id", accessUser.id);
            continue;
          }

          const isGranted = event.eventId === COSEC_EVENT.ACCESS_GRANTED;
          const isDenied  = event.eventId === COSEC_EVENT.ACCESS_DENIED;
          if (!isGranted && !isDenied) continue;

          const direction = isGranted ? parseDirection(event.detail3) : "DENIED";
          const denialReason = isDenied ? (COSEC_DENIAL_REASON[event.detail1] ?? "Access denied") : null;

          accessLogsToInsert.push({
            device_id,
            cosec_ref_id: isGranted ? event.refUserId : null,
            user_type: accessUser?.user_type ?? null,
            entity_id: accessUser?.entity_id ?? null,
            entity_name: entityName,
            direction,
            denial_reason: denialReason,
            raw_event_id: event.eventId,
            event_time: event.eventTime.toISOString(),
            device_seq_number: event.seqNumber,
            roll_over_count: event.rollOverCount,
          });

          if (isGranted && accessUser?.entity_id) {
            presenceUpserts.push({
              device_id,
              entity_id: accessUser.entity_id,
              entity_name: entityName,
              user_type: accessUser.user_type,
              is_inside: direction === "IN",
              last_entry_at: direction === "IN" ? event.eventTime.toISOString() : undefined,
              last_exit_at: direction === "OUT" ? event.eventTime.toISOString() : undefined,
              updated_at: now,
            });
          }
        }

        if (accessLogsToInsert.length > 0) {
          await admin.from("access_logs").insert(accessLogsToInsert);
          logsWritten += accessLogsToInsert.length;
        }

        for (const upsert of presenceUpserts) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const u = upsert as any;
          const patch: Record<string, unknown> = {
            entity_name: u.entity_name,
            user_type: u.user_type,
            is_inside: u.is_inside,
            updated_at: u.updated_at,
          };
          if (u.last_entry_at) patch.last_entry_at = u.last_entry_at;
          if (u.last_exit_at)  patch.last_exit_at  = u.last_exit_at;
          await admin.from("cosec_presence").upsert(
            { device_id, entity_id: u.entity_id, ...patch },
            { onConflict: "device_id,entity_id" },
          );
        }
      }
    } while (skip_history && rounds < maxRounds);

    // Save cursor
    await admin.from("cosec_devices").update({
      last_roll_over_count: currentRollOver,
      last_seq_number: currentSeq,
      last_polled_at: new Date().toISOString(),
    }).eq("id", device_id);

    return NextResponse.json({
      ok: true,
      eventsFound: totalEvents,
      logsWritten,
      newSeqNumber: currentSeq,
      skippedHistory: skip_history,
      exhausted: rounds < (skip_history ? 200 : 1) || totalEvents === 0,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// ── Entity name resolution (same as cron) ────────────────────────────────────

type AccessUserRow = {
  id: string;
  entity_id: string;
  user_type: string;
};

async function resolveEntityNames(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: any,
  users: AccessUserRow[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (users.length === 0) return names;

  const byType = new Map<string, string[]>();
  for (const u of users) {
    if (!u.entity_id || !u.user_type) continue;
    if (!byType.has(u.user_type)) byType.set(u.user_type, []);
    byType.get(u.user_type)!.push(u.entity_id);
  }

  const tasks: Promise<void>[] = [];

  if (byType.has("contract")) {
    tasks.push((async () => {
      const { data } = await admin.from("contracts")
        .select("id, contract_number, lead:leads!contracts_lead_id_fkey(first_name, last_name, company)")
        .in("id", byType.get("contract")!);
      for (const c of data ?? []) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const lead = c.lead as any;
        names.set(c.id, lead?.company || `${lead?.first_name ?? ""} ${lead?.last_name ?? ""}`.trim() || c.contract_number);
      }
    })());
  }

  if (byType.has("employee")) {
    tasks.push((async () => {
      const { data } = await admin.from("employees").select("id, full_name").in("id", byType.get("employee")!);
      for (const e of data ?? []) names.set(e.id, e.full_name);
    })());
  }

  if (byType.has("booking")) {
    tasks.push((async () => {
      const { data } = await admin.from("bookings").select("id, booking_number, guest_name").in("id", byType.get("booking")!);
      for (const b of data ?? []) names.set(b.id, b.guest_name || `Booking #${b.booking_number}`);
    })());
  }

  if (byType.has("member")) {
    tasks.push((async () => {
      const { data } = await admin.from("contract_members").select("id, name").in("id", byType.get("member")!);
      for (const m of data ?? []) names.set(m.id, m.name);
    })());
  }

  await Promise.all(tasks);
  return names;
}
