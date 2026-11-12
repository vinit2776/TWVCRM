import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { pollEvents, COSEC_EVENT, COSEC_DENIAL_REASON, parseDirection } from "@/lib/cosec";
import { withCronHealth } from "@/lib/cron-ping";

/**
 * GET /api/cron/cosec-events
 *
 * Runs every 5 minutes. For each enabled COSEC device:
 *   1. Polls new events since last_seq_number
 *   2. ENROLLMENT_COMPLETE (405) → activate user on device
 *   3. CARD_ENROLLED (406) → update card_enrolled status
 *   4. ACCESS_GRANTED / DENIED → write to access_logs with entity_name + denial_reason
 *   5. IN/OUT events → upsert cosec_presence (live presence state)
 *   6. Updates device polling cursors
 */
async function handler(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();

  const { data: devices, error: devErr } = await admin
    .from("cosec_devices")
    .select("id, device_ip, device_port, device_password, last_roll_over_count, last_seq_number")
    .eq("is_enabled", true);

  if (devErr) {
    console.error("[cosec-events] fetch devices error:", devErr);
    return NextResponse.json({ error: devErr.message }, { status: 500 });
  }

  if (!devices || devices.length === 0) {
    return NextResponse.json({ message: "No enabled devices", processed: 0 });
  }

  const summary: Record<string, {
    events: number; enrolled: number; cardEnrolled: number;
    access: number; denied: number; error?: string;
  }> = {};

  for (const dev of devices) {
    const device = { ip: dev.device_ip, port: dev.device_port, password: dev.device_password };
    summary[dev.id] = { events: 0, enrolled: 0, cardEnrolled: 0, access: 0, denied: 0 };

    try {
      const { events, lastRollOverCount, lastSeqNumber } = await pollEvents(
        device,
        dev.last_roll_over_count,
        dev.last_seq_number + 1,
        100
      );

      if (events.length === 0) {
        // Still update last_polled_at
        await admin
          .from("cosec_devices")
          .update({ last_polled_at: new Date().toISOString() })
          .eq("id", dev.id);
        continue;
      }

      summary[dev.id].events = events.length;

      // Build ref_id → access_user map for this device (include entity_name lookup joins)
      const refIds = [...new Set(events.map(e => e.refUserId).filter(Boolean))];

      const { data: accessUsers } = await admin
        .from("cosec_access_users")
        .select("id, cosec_ref_id, cosec_user_id, entity_id, user_type, enrollment_status, nfc_card_number")
        .eq("device_id", dev.id)
        .in("cosec_ref_id", refIds);

      const refMap = new Map((accessUsers ?? []).map(u => [u.cosec_ref_id, u]));

      // Resolve entity names in batch (one query per user_type present)
      const entityNames = await resolveEntityNames(admin, accessUsers ?? []);

      const accessLogsToInsert: Record<string, unknown>[] = [];
      const presenceUpserts: Record<string, unknown>[] = [];
      const now = new Date().toISOString();

      for (const event of events) {
        const accessUser = refMap.get(event.refUserId);
        const entityName = accessUser
          ? (entityNames.get(accessUser.entity_id) ?? `Ref #${event.refUserId}`)
          : `Ref #${event.refUserId}`;

        // ── Biometric enrollment complete ─────────────────────────────────────
        if (event.eventId === COSEC_EVENT.ENROLLMENT_COMPLETE && accessUser) {
          try {
            await fetch(`${process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL}/api/cosec/activate-after-enroll`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${process.env.CRON_SECRET}`,
              },
              body: JSON.stringify({ access_user_id: accessUser.id, device_id: dev.id }),
            });
          } catch { /* non-fatal — retry next poll */ }

          await admin
            .from("cosec_access_users")
            .update({
              enrollment_status: "biometric_enrolled",
              biometric_enrolled_at: event.eventTime.toISOString(),
              updated_at: now,
            })
            .eq("id", accessUser.id);

          summary[dev.id].enrolled++;
          continue;
        }

        // ── Card enrollment complete (event 406) ──────────────────────────────
        if (event.eventId === 406 && accessUser) {
          // detail-1 from card event carries card CSN in some firmware versions
          const cardNumber = event.detail1 ? String(event.detail1) : null;
          await admin
            .from("cosec_access_users")
            .update({
              enrollment_status: accessUser.enrollment_status === "biometric_enrolled"
                ? "fully_enrolled"
                : "card_enrolled",
              nfc_card_number: cardNumber ?? accessUser.nfc_card_number,
              card_enrolled_at: event.eventTime.toISOString(),
              updated_at: now,
            })
            .eq("id", accessUser.id);

          summary[dev.id].cardEnrolled++;
          continue;
        }

        // ── Access granted / denied ───────────────────────────────────────────
        // Device emits: 101 = access granted, 201 = access denied
        const isGranted = event.eventId === COSEC_EVENT.ACCESS_GRANTED;
        const isDenied  = event.eventId === COSEC_EVENT.ACCESS_DENIED;

        if (!isGranted && !isDenied) continue;

        const direction = isGranted ? parseDirection(event.detail3) : "DENIED";
        // For denied events (201), detail1 = denial reason code (not a user ref ID)
        const denialReason = isDenied ? (COSEC_DENIAL_REASON[event.detail1] ?? "Access denied") : null;

        accessLogsToInsert.push({
          device_id: dev.id,
          // For denied events (201), detail1 = denial reason code, not a user ref
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

        if (isDenied) {
          summary[dev.id].denied++;
        } else {
          summary[dev.id].access++;

          // Update presence state for IN / OUT
          if (accessUser?.entity_id) {
            presenceUpserts.push({
              device_id: dev.id,
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
      }

      // Batch write access logs
      if (accessLogsToInsert.length > 0) {
        await admin.from("access_logs").insert(accessLogsToInsert);
      }

      // Upsert presence — for each entity keep only the latest event per direction
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
        if (u.last_exit_at) patch.last_exit_at = u.last_exit_at;

        await admin
          .from("cosec_presence")
          .upsert({ device_id: u.device_id, entity_id: u.entity_id, ...patch },
            { onConflict: "device_id,entity_id" });
      }

      // Update device polling cursor
      await admin
        .from("cosec_devices")
        .update({
          last_roll_over_count: lastRollOverCount,
          last_seq_number: lastSeqNumber,
          last_polled_at: now,
        })
        .eq("id", dev.id);

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[cosec-events] device ${dev.id} error:`, msg);
      summary[dev.id].error = msg;
    }
  }

  return NextResponse.json({ ok: true, summary });
}

// ── Entity name resolution ────────────────────────────────────────────────────

type AccessUserRow = {
  id: string;
  cosec_ref_id: number;
  cosec_user_id: string;
  entity_id: string;
  user_type: string;
  enrollment_status: string;
  nfc_card_number: string | null;
};

async function resolveEntityNames(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: any,
  users: AccessUserRow[]
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
      const { data } = await admin
        .from("contracts")
        .select("id, contract_number, lead:leads!contracts_lead_id_fkey(first_name, last_name, company)")
        .in("id", byType.get("contract")!);
      for (const c of data ?? []) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const lead = c.lead as any;
        const name = lead?.company
          || (lead ? `${lead.first_name ?? ""} ${lead.last_name ?? ""}`.trim() : "")
          || c.contract_number;
        names.set(c.id, name);
      }
    })());
  }

  if (byType.has("employee")) {
    tasks.push((async () => {
      const { data } = await admin
        .from("employees")
        .select("id, full_name")
        .in("id", byType.get("employee")!);
      for (const e of data ?? []) names.set(e.id, e.full_name);
    })());
  }

  if (byType.has("booking")) {
    tasks.push((async () => {
      const { data } = await admin
        .from("bookings")
        .select("id, booking_number, guest_name")
        .in("id", byType.get("booking")!);
      for (const b of data ?? []) {
        names.set(b.id, b.guest_name || `Booking #${b.booking_number}`);
      }
    })());
  }

  if (byType.has("member")) {
    tasks.push((async () => {
      const { data } = await admin
        .from("contract_members")
        .select("id, name")
        .in("id", byType.get("member")!);
      for (const m of data ?? []) names.set(m.id, m.name);
    })());
  }

  await Promise.all(tasks);
  return names;
}

export const GET = withCronHealth("cron/cosec-events", handler);
