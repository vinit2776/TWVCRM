import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { pollEvents, COSEC_EVENT, parseDirection } from "@/lib/cosec";

/**
 * GET /api/cron/cosec-events
 *
 * Runs every 5 minutes. For each enabled COSEC device:
 *   1. Polls new events since last_seq_number
 *   2. Detects enrollment events → activates user on device + updates DB
 *   3. Writes access_logs for all IN/OUT/DENIED events
 *   4. Updates device's last_seq_number
 */
export async function GET(request: NextRequest) {
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

  const summary: Record<string, { events: number; enrolled: number; access: number; error?: string }> = {};

  for (const dev of devices) {
    const device = { ip: dev.device_ip, port: dev.device_port, password: dev.device_password };
    summary[dev.id] = { events: 0, enrolled: 0, access: 0 };

    try {
      const { events, lastRollOverCount, lastSeqNumber } = await pollEvents(
        device,
        dev.last_roll_over_count,
        dev.last_seq_number + 1, // start from next event
        100
      );

      if (events.length === 0) continue;

      summary[dev.id].events = events.length;

      // Build a ref_id → access_user map for this device
      const refIds = [...new Set(events.map(e => e.refUserId).filter(Boolean))];
      const { data: accessUsers } = await admin
        .from("cosec_access_users")
        .select("id, cosec_ref_id, cosec_user_id, entity_id, user_type, enrollment_status")
        .eq("device_id", dev.id)
        .in("cosec_ref_id", refIds);

      const refMap = new Map((accessUsers || []).map(u => [u.cosec_ref_id, u]));

      const accessLogsToInsert: Record<string, unknown>[] = [];

      for (const event of events) {
        const accessUser = refMap.get(event.refUserId);

        // ── Enrollment event ─────────────────────────────────────────────────
        if (event.eventId === COSEC_EVENT.ENROLLMENT_COMPLETE && accessUser) {
          // Activate user on device now that they have a biometric credential
          try {
            await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/cosec/activate-after-enroll`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${process.env.CRON_SECRET}`,
              },
              body: JSON.stringify({ access_user_id: accessUser.id, device_id: dev.id }),
            });
          } catch {
            // Non-fatal — will retry next poll cycle
          }

          await admin
            .from("cosec_access_users")
            .update({
              enrollment_status: "biometric_enrolled",
              biometric_enrolled_at: event.eventTime.toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq("id", accessUser.id);

          summary[dev.id].enrolled++;
          continue;
        }

        // ── Access events ─────────────────────────────────────────────────────
        const isAccessGranted = event.eventId === COSEC_EVENT.ACCESS_GRANTED;
        const isDenied = [
          COSEC_EVENT.ACCESS_DENIED_INVALID_CREDENTIAL,
          COSEC_EVENT.ACCESS_DENIED_INACTIVE,
          COSEC_EVENT.ACCESS_DENIED_VALIDITY_EXPIRED,
          COSEC_EVENT.ACCESS_DENIED_TIMEZONE,
        ].includes(event.eventId as 1 | 2 | 3 | 6);

        if (isAccessGranted || isDenied) {
          const direction = isAccessGranted ? parseDirection(event.detail3) : "DENIED";
          accessLogsToInsert.push({
            device_id: dev.id,
            cosec_ref_id: event.refUserId,
            user_type: accessUser?.user_type ?? null,
            entity_id: accessUser?.entity_id ?? null,
            direction,
            raw_event_id: event.eventId,
            event_time: event.eventTime.toISOString(),
            device_seq_number: event.seqNumber,
            roll_over_count: event.rollOverCount,
          });
          summary[dev.id].access++;
        }
      }

      if (accessLogsToInsert.length > 0) {
        await admin.from("access_logs").insert(accessLogsToInsert);
      }

      // Update device polling cursor
      await admin
        .from("cosec_devices")
        .update({
          last_roll_over_count: lastRollOverCount,
          last_seq_number: lastSeqNumber,
          last_polled_at: new Date().toISOString(),
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
