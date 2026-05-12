import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/finance/gateway-activity/sync
 *
 * Calls Razorpay's settlements/recon/combined endpoint for the past N months
 * and upserts per-payment settlement data into razorpay_settlement_cache.
 *
 * The recon endpoint is the ONLY Razorpay API that links a payment ID to a
 * settlement UTR — the payment object itself has no settlement_id field.
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

  // Razorpay credentials
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

  // Build list of year/month combos to fetch
  const monthsToFetch: { year: number; month: number }[] = [];
  const now = new Date();
  for (let i = 0; i < monthsBack; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    monthsToFetch.push({ year: d.getFullYear(), month: d.getMonth() + 1 });
  }

  let totalUpdated = 0;
  let errorMessage: string | null = null;

  for (const { year, month } of monthsToFetch) {
    // Paginate — Razorpay returns max 1000 items per call
    let skip = 0;
    const count = 1000;
    let hasMore = true;

    while (hasMore) {
      const url = `https://api.razorpay.com/v1/settlements/recon/combined?year=${year}&month=${month}&count=${count}&skip=${skip}`;

      let recon: { entity: string; count: number; items: ReconItem[] } | null = null;
      try {
        const resp = await fetch(url, {
          headers: { Authorization: `Basic ${auth}` },
        });

        if (!resp.ok) {
          const errBody = await resp.text();
          // 404 just means no settlements for that month — not a real error
          if (resp.status === 404) { hasMore = false; break; }
          errorMessage = `Razorpay recon API error ${resp.status}: ${errBody.slice(0, 200)}`;
          hasMore = false;
          break;
        }

        recon = await resp.json();
      } catch (e) {
        errorMessage = e instanceof Error ? e.message : "Fetch failed";
        hasMore = false;
        break;
      }

      const items: ReconItem[] = recon?.items ?? [];
      // Only process "payment" type rows (not refunds / transfers)
      const payments = items.filter((it) => it.type === "payment");

      if (payments.length > 0) {
        const upsertRows = payments.map((it) => ({
          razorpay_payment_id: it.entity_id,
          settled:             it.settled ?? false,
          settlement_id:       it.settlement_id ?? null,
          settlement_utr:      it.settlement_utr ?? null,
          settled_at:          it.settled_at ? new Date(it.settled_at * 1000).toISOString() : null,
          fee:                 it.fee   != null ? it.fee   / 100 : null,
          tax:                 it.tax   != null ? it.tax   / 100 : null,
          payment_method:      it.method ?? null,
          last_synced_at:      new Date().toISOString(),
        }));

        const { error: upsertError } = await adminSupabase
          .from("razorpay_settlement_cache")
          .upsert(upsertRows, { onConflict: "razorpay_payment_id" });

        if (upsertError) {
          errorMessage = upsertError.message;
          hasMore = false;
          break;
        }

        totalUpdated += payments.length;
      }

      // If we got fewer than count, we're done with this month
      hasMore = items.length === count;
      skip += count;
    }

    if (errorMessage) break;
  }

  // Record this sync attempt
  await adminSupabase.from("razorpay_sync_log").insert({
    months_back:     monthsBack,
    records_updated: totalUpdated,
    error_message:   errorMessage,
  });

  if (errorMessage) {
    return NextResponse.json({
      error:           errorMessage,
      records_updated: totalUpdated,
    }, { status: 500 });
  }

  return NextResponse.json({
    message:         `Synced ${totalUpdated} payment records from ${monthsBack} month(s)`,
    records_updated: totalUpdated,
    months_synced:   monthsToFetch,
  });
}

// ── Razorpay recon item type ─────────────────────────────────────────────────
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
