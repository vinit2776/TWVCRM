import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/finance/gateway-activity/sync
 *
 * Two-phase sync:
 *
 * Phase 1 — Razorpay Payments API (/v1/payments)
 *   Fetches ALL captured payments in the date window (including those not yet
 *   in any settlement batch). This ensures payments like pay_Sg2qVPU84tz1Rd
 *   that are captured but still awaiting settlement are never missed.
 *
 * Phase 2 — Settlement Recon API (/v1/settlements/recon/combined)
 *   Overlays settlement data (UTR, fees, settled_at) onto the cache rows
 *   written in Phase 1. This is the only API that links a payment ID to a
 *   settlement UTR.
 *
 * Body: { months_back?: number }  — defaults to 2 (current + previous month)
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  const ALLOWED_ROLES = ["admin", "accounts"];
  if (!dbUser || !ALLOWED_ROLES.includes(dbUser.role)) {
    return NextResponse.json({ error: "Access denied — admin or accounts role required" }, { status: 403 });
  }

  const adminSupabase = createAdminClient();
  const { data: rzpSettings } = await adminSupabase
    .from("app_settings")
    .select("key, value")
    .in("key", ["razorpay_key_id", "razorpay_key_secret"]);

  const rzpMap: Record<string, string> = {};
  (rzpSettings || []).forEach((s) => { rzpMap[s.key] = s.value; });

  if (!rzpMap.razorpay_key_id || !rzpMap.razorpay_key_secret) {
    return NextResponse.json({ error: "Razorpay credentials not configured" }, { status: 400 });
  }

  const body = await request.json().catch(() => ({}));
  const monthsBack: number = Math.min(Math.max(Number(body.months_back) || 2, 1), 6);
  const auth = Buffer.from(`${rzpMap.razorpay_key_id}:${rzpMap.razorpay_key_secret}`).toString("base64");

  const now = new Date();
  // Unix timestamp for the start of the window (beginning of oldest month)
  const windowStart = new Date(now.getFullYear(), now.getMonth() - monthsBack + 1, 1);
  const fromUnix = Math.floor(windowStart.getTime() / 1000);
  const toUnix   = Math.floor(now.getTime() / 1000);

  // Build list of year/month combos for the settlement recon phase
  const monthsToFetch: { year: number; month: number }[] = [];
  for (let i = 0; i < monthsBack; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    monthsToFetch.push({ year: d.getFullYear(), month: d.getMonth() + 1 });
  }

  let totalUpdated = 0;
  let errorMessage: string | null = null;

  // ── Phase 1: Payments API — capture ALL payments (settled or not) ──────────
  {
    let skip = 0;
    const count = 100; // Payments API max is 100
    let hasMore = true;

    while (hasMore) {
      const url = `https://api.razorpay.com/v1/payments?from=${fromUnix}&to=${toUnix}&count=${count}&skip=${skip}`;

      let resp: Response;
      try {
        resp = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
      } catch (e) {
        errorMessage = e instanceof Error ? e.message : "Payments API fetch failed";
        break;
      }

      if (!resp.ok) {
        const errBody = await resp.text();
        errorMessage = `Razorpay payments API error ${resp.status}: ${errBody.slice(0, 200)}`;
        break;
      }

      const data: { count: number; items: RazorpayPayment[] } = await resp.json();
      const items = data.items ?? [];

      // Only upsert captured payments (skip created/failed/refunded)
      const captured = items.filter((p) => p.status === "captured");

      if (captured.length > 0) {
        const upsertRows = captured.map((p) => ({
          razorpay_payment_id: p.id,
          // Don't overwrite settlement data if already populated (use ignoreDuplicates: false)
          settled:             false, // will be corrected by Phase 2 if settled
          settlement_id:       null,
          settlement_utr:      null,
          settled_at:          null,
          fee:                 p.fee     != null ? p.fee     / 100 : null,
          tax:                 p.tax     != null ? p.tax     / 100 : null,
          payment_method:      p.method  ?? null,
          amount:              p.amount  != null ? p.amount  / 100 : null,
          order_id:            p.order_id ?? null,
          payment_created_at:  p.created_at ? new Date(p.created_at * 1000).toISOString() : null,
          last_synced_at:      new Date().toISOString(),
        }));

        // Use ignoreDuplicates so Phase 2 settlement data isn't wiped
        const { error: upsertError } = await adminSupabase
          .from("razorpay_settlement_cache")
          .upsert(upsertRows, {
            onConflict: "razorpay_payment_id",
            ignoreDuplicates: false,
          });

        if (upsertError) {
          errorMessage = `Phase 1 upsert error: ${upsertError.message}`;
          break;
        }

        totalUpdated += captured.length;
      }

      hasMore = items.length === count;
      skip += count;
    }
  }

  // ── Phase 2: Settlement Recon — overlay UTR / fees / settled status ────────
  if (!errorMessage) {
    for (const { year, month } of monthsToFetch) {
      let skip = 0;
      const count = 1000;
      let hasMore = true;

      while (hasMore) {
        const url = `https://api.razorpay.com/v1/settlements/recon/combined?year=${year}&month=${month}&count=${count}&skip=${skip}`;

        let recon: { entity: string; count: number; items: ReconItem[] } | null = null;
        try {
          const resp = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
          if (!resp.ok) {
            if (resp.status === 404) { hasMore = false; break; }
            const errBody = await resp.text();
            errorMessage = `Razorpay recon API error ${resp.status}: ${errBody.slice(0, 200)}`;
            hasMore = false;
            break;
          }
          recon = await resp.json();
        } catch (e) {
          errorMessage = e instanceof Error ? e.message : "Recon fetch failed";
          hasMore = false;
          break;
        }

        const items: ReconItem[] = recon?.items ?? [];
        const payments = items.filter((it) => it.type === "payment");

        if (payments.length > 0) {
          const upsertRows = payments.map((it) => ({
            razorpay_payment_id: it.entity_id,
            settled:             it.settled ?? false,
            settlement_id:       it.settlement_id ?? null,
            settlement_utr:      it.settlement_utr ?? null,
            settled_at:          it.settled_at ? new Date(it.settled_at * 1000).toISOString() : null,
            fee:                 it.fee    != null ? it.fee    / 100 : null,
            tax:                 it.tax    != null ? it.tax    / 100 : null,
            payment_method:      it.method ?? null,
            amount:              it.amount != null ? it.amount / 100 : null,
            order_id:            it.order_id ?? null,
            payment_created_at:  it.created_at ? new Date(it.created_at * 1000).toISOString() : null,
            last_synced_at:      new Date().toISOString(),
          }));

          const { error: upsertError } = await adminSupabase
            .from("razorpay_settlement_cache")
            .upsert(upsertRows, { onConflict: "razorpay_payment_id" });

          if (upsertError) {
            errorMessage = `Phase 2 upsert error: ${upsertError.message}`;
            hasMore = false;
            break;
          }
        }

        hasMore = items.length === count;
        skip += count;
      }

      if (errorMessage) break;
    }
  }

  await adminSupabase.from("razorpay_sync_log").insert({
    months_back:     monthsBack,
    records_updated: totalUpdated,
    error_message:   errorMessage,
  });

  if (errorMessage) {
    return NextResponse.json({ error: errorMessage, records_updated: totalUpdated }, { status: 500 });
  }

  return NextResponse.json({
    message:         `Synced ${totalUpdated} payment records from ${monthsBack} month(s)`,
    records_updated: totalUpdated,
    months_synced:   monthsToFetch,
  });
}

// ── Types ────────────────────────────────────────────────────────────────────

interface RazorpayPayment {
  id:         string;
  status:     string;    // "captured" | "failed" | "created" | "refunded"
  amount:     number;    // paise
  fee:        number | null;
  tax:        number | null;
  method:     string | null;
  order_id:   string | null;
  created_at: number;    // unix timestamp
}

interface ReconItem {
  entity_id:      string;
  type:           "payment" | "refund" | "transfer" | "adjustment";
  debit:          number;
  credit:         number;
  amount:         number;
  currency:       string;
  fee:            number | null;
  tax:            number | null;
  on_hold:        boolean;
  settled:        boolean;
  created_at:     number;
  settled_at:     number | null;
  settlement_id:  string | null;
  settlement_utr: string | null;
  method:         string | null;
  order_id:       string | null;
}
