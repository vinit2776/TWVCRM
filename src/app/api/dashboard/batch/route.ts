import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { runInDashboardBatch } from "@/lib/dashboard-auth";
import { GET as stats } from "@/app/api/dashboard/route";
import { GET as aggregatorPerformance } from "@/app/api/dashboard/aggregator-performance/route";
import { GET as bookings } from "@/app/api/dashboard/bookings/route";
import { GET as cashAging } from "@/app/api/dashboard/cash-aging/route";
import { GET as financial } from "@/app/api/dashboard/financial/route";
import { GET as leadFunnel } from "@/app/api/dashboard/lead-funnel/route";
import { GET as memberHealth } from "@/app/api/dashboard/member-health/route";
import { GET as mtdBookings } from "@/app/api/dashboard/mtd-bookings/route";
import { GET as occupancy } from "@/app/api/dashboard/occupancy/route";
import { GET as pendingActions } from "@/app/api/dashboard/pending-actions/route";
import { GET as pendingOvertimeCharges } from "@/app/api/dashboard/pending-overtime-charges/route";
import { GET as procurement } from "@/app/api/dashboard/procurement/route";
import { GET as procurementSpend } from "@/app/api/dashboard/procurement-spend/route";
import { GET as quotaOveruse } from "@/app/api/dashboard/quota-overuse/route";
import { GET as recentLeads } from "@/app/api/dashboard/recent-leads/route";
import { GET as renewals } from "@/app/api/dashboard/renewals/route";
import { GET as rentRevenue } from "@/app/api/dashboard/rent-revenue/route";
import { GET as revenuePulse } from "@/app/api/dashboard/revenue-pulse/route";
import { GET as schedule } from "@/app/api/dashboard/schedule/route";
import { GET as slaRisk } from "@/app/api/dashboard/sla-risk/route";
import { GET as sourceRoi } from "@/app/api/dashboard/source-roi/route";
import { GET as support } from "@/app/api/dashboard/support/route";
import { GET as team } from "@/app/api/dashboard/team/route";
import { GET as weekInReview } from "@/app/api/dashboard/week-in-review/route";

/**
 * POST /api/dashboard/batch
 * Body: { requests: ["/api/dashboard/occupancy?location_id=…", …] }
 *
 * Runs several dashboard widget routes in one serverless invocation so a page
 * load costs one request instead of one per widget. Each route still does its
 * own role check; they share one session lookup via runInDashboardBatch.
 *
 * Responds with NDJSON, one line per request as it finishes, so a fast widget
 * isn't held back by a slow one: {"i":<index>,"status":<code>,"body":<json>}
 */

type Handler = (request: NextRequest) => Promise<Response>;

// Allowlist — only these routes can be reached through the batch.
const HANDLERS: Record<string, Handler> = {
  "/api/dashboard": stats,
  "/api/dashboard/aggregator-performance": aggregatorPerformance,
  "/api/dashboard/bookings": bookings,
  "/api/dashboard/cash-aging": cashAging,
  "/api/dashboard/financial": financial,
  "/api/dashboard/lead-funnel": leadFunnel,
  "/api/dashboard/member-health": memberHealth,
  "/api/dashboard/mtd-bookings": mtdBookings,
  "/api/dashboard/occupancy": occupancy,
  "/api/dashboard/pending-actions": pendingActions,
  "/api/dashboard/pending-overtime-charges": pendingOvertimeCharges,
  "/api/dashboard/procurement": procurement,
  "/api/dashboard/procurement-spend": procurementSpend,
  "/api/dashboard/quota-overuse": quotaOveruse,
  "/api/dashboard/recent-leads": recentLeads,
  "/api/dashboard/renewals": renewals,
  "/api/dashboard/rent-revenue": rentRevenue,
  "/api/dashboard/revenue-pulse": revenuePulse,
  "/api/dashboard/schedule": schedule,
  "/api/dashboard/sla-risk": slaRisk,
  "/api/dashboard/source-roi": sourceRoi,
  "/api/dashboard/support": support,
  "/api/dashboard/team": team,
  "/api/dashboard/week-in-review": weekInReview,
};

const bodySchema = z.object({
  requests: z.array(z.string().startsWith("/api/dashboard")).min(1).max(40),
});

export async function POST(request: NextRequest) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const targets = parsed.data.requests.map((path) => {
    const url = new URL(path, request.url);
    return { url, handler: HANDLERS[url.pathname] };
  });
  if (targets.some((t) => !t.handler)) {
    return NextResponse.json({ error: "Unknown dashboard route" }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      runInDashboardBatch(() =>
        Promise.all(
          targets.map(async ({ url, handler }, i) => {
            let status = 500;
            let body: unknown = { error: "Internal error" };
            try {
              const res = await handler(new NextRequest(url, { headers: request.headers }));
              status = res.status;
              body = await res.json();
            } catch (err) {
              console.error(`[dashboard/batch] ${url.pathname} failed:`, err instanceof Error ? err.message : err);
            }
            controller.enqueue(encoder.encode(JSON.stringify({ i, status, body }) + "\n"));
          })
        )
      ).finally(() => controller.close());
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-store",
    },
  });
}
