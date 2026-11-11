/**
 * GET /api/cron/attendance-punchin-reminder
 *
 * Pokes the attendance gateway so it can send punch-in reminder emails.
 *
 * The gateway decides everything — who is due, whether the feature is on at all,
 * and whether today is a holiday. This route holds no attendance logic and
 * touches no table; it exists only because the gateway cannot schedule itself.
 *
 * Why it lives here. Reminders are per person, 10 minutes after each employee's
 * own shift starts, so each person is due for a five-minute window and something
 * has to ask "who is due now?" every few minutes. The gateway is a Vercel Hobby
 * project, where cron runs at most once a day and lands anywhere inside the hour
 * — useless for a five-minute window. This project already runs five-minute crons,
 * so the schedule lives here and the gateway stays the thing that knows the rules.
 *
 * Why the schedule is narrow. Everyone currently starts at 09:30, and in the
 * gateway's default "fixed" window mode it refuses to send outside 09:30-10:00 IST
 * however often it is asked. So the cron runs only 04:00-04:30 UTC (09:30-10:00
 * IST), Mon-Sat: 7 runs a day instead of 48, covering the gateway's whole window
 * twice over with nothing lost.
 *
 * If shift timings ever spread out, this schedule becomes the binding constraint
 * and must be widened FIRST. Switching the gateway to "shifts" window mode alone
 * will not help — anyone whose reminder falls outside 09:30-10:00 IST silently
 * never gets one, because this route is not awake to ask.
 *
 * ATTENDANCE_CRON_SECRET is the *gateway's* CRON_SECRET, which is a different
 * value from this project's. Unset, the route no-ops rather than failing, so a
 * deploy before the variable is configured doesn't light up the health monitor.
 */

import { NextRequest, NextResponse } from "next/server";
import { withCronHealth } from "@/lib/cron-ping";

const GATEWAY_URL =
  process.env.ATTENDANCE_GATEWAY_URL || "https://twv-attendance.vercel.app";

// Comfortably longer than the gateway's own 15s-per-email Resend timeout would
// need for a normal morning, and short enough that a hung gateway can't hold a
// serverless invocation open to its own limit.
const TIMEOUT_MS = 25_000;

async function handler(request: NextRequest) {
  if (request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const secret = process.env.ATTENDANCE_CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ skipped: "ATTENDANCE_CRON_SECRET not set" });
  }

  let res: Response;
  try {
    res = await fetch(`${GATEWAY_URL}/internal/punchin-reminder`, {
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (err) {
    // Reported as a failure, not swallowed: reminders going quiet is the whole
    // failure mode worth catching, and it is invisible from this side otherwise.
    const reason = err instanceof Error ? err.message : String(err);
    console.error("[cron/attendance-punchin-reminder] gateway unreachable:", reason);
    return NextResponse.json({ error: "Gateway unreachable", reason }, { status: 502 });
  }

  // The gateway answers { ok, ran, outcome, sent?, failed? }. Pass its own words
  // through so a bad run is diagnosable from this project's logs alone.
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    console.error(`[cron/attendance-punchin-reminder] gateway ${res.status}:`, body);
    return NextResponse.json({ error: "Gateway refused", status: res.status, body }, { status: 502 });
  }

  return NextResponse.json({ gateway: body });
}

export const GET = withCronHealth("cron/attendance-punchin-reminder", handler);
