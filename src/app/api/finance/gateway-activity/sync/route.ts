import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/finance/gateway-activity/sync
 *
 * Two-phase sync that guarantees zero gaps in the gateway activity list.
 *
 * Window determination (whichever is earlier):
 *   - Requested window via body.months_back (default 3, max 24)
 *   - Oldest payment_created_at already in the cache  ← extends automatically
 *     so re-syncing never loses data from prior runs
 *
 * Phase 1 — Razorpay Payments API (/v1/payments, chunked by month)
 *   Fetches ALL captured payments regardless of settlement status.
 *   Payments not yet in any settlement batch would be missed by Phase 2
 *   alone; this phase ensures they still appear in the list.
 *
 * Phase 2 — Settlement Recon API (/v1/settlements/recon/combined)
 *   Overlays the UTR / settlement ID / fees / settled_at onto Phase 1 rows.
 *   Uses the same month-chunked window so the two phases are always in sync.
 *
 * Body: { months_back?: number }  — 1–24, defaults to 3
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
  const requestedMonthsBack = Math.min(Math.max(Number(body.months_back) || 3, 1), 24);
  const auth = Buffer.from(`${rzpMap.razorpay_key_id}:${rzpMap.razorpay_key_secret}`).toString("base64");

  const now = new Date();

  // ── Determine effective start of window ───────────────────────────────────
  // Use whichever is earlier: the requested window OR the oldest payment
  // already in the cache (so subsequent syncs never leave gaps).
  const requestedStart = new Date(now.getFullYear(), now.getMonth() - requestedMonthsBack + 1, 1);

  const { data: oldestRow } = await adminSupabase
    .from("razorpay_settlement_cache")
    .select("payment_created_at")
    .not("payment_created_at", "is", null)
    .order("payment_created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  let windowStart = requestedStart;
  if (oldestRow?.payment_created_at) {
    // Go one day before the oldest cached payment to catch any edge-case gaps
    const oldest = new Date(oldestRow.payment_created_at);
    oldest.setDate(oldest.getDate() - 1);
    if (oldest < windowStart) windowStart = oldest;
  }

  // ── Build month list for the full window ──────────────────────────────────
  const monthsToFetch: { year: number; month: number }[] = [];
  {
    const d = new Date(windowStart.getFullYear(), windowStart.getMonth(), 1);
    while (d <= now) {
      monthsToFetch.push({ year: d.getFullYear(), month: d.getMonth() + 1 });
      d.setMonth(d.getMonth() + 1);
    }
  }

  let totalCaptured = 0;
  let errorMessage: string | null = null;

  // ── Phase 1: Payments API — ALL captured payments, chunked by month ────────
  // Chunking by month keeps skip values small and avoids API pagination limits.
  for (const { year, month } of monthsToFetch) {
    if (errorMessage) break;

    const monthFrom = Math.floor(new Date(year, month - 1, 1).getTime() / 1000);
    const monthTo   = Math.floor(new Date(year, month, 0, 23, 59, 59).getTime() / 1000);

    let skip = 0;
    const count = 100; // Payments API max per page
    let hasMore = true;

    while (hasMore) {
      const url = `https://api.razorpay.com/v1/payments?from=${monthFrom}&to=${monthTo}&count=${count}&skip=${skip}`;

      let resp: Response;
      try {
        resp = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
      } catch (e) {
        errorMessage = `Payments API network error: ${e instanceof Error ? e.message : "unknown"}`;
        hasMore = false;
        break;
      }

      if (!resp.ok) {
        const body = await resp.text();
        // 404 means no payments for this period — not an error
        if (resp.status === 404) { hasMore = false; break; }
        errorMessage = `Payments API ${resp.status} (${year}/${month}): ${body.slice(0, 200)}`;
        hasMore = false;
        break;
      }

      const data: { count: number; items: RazorpayPayment[] } = await resp.json();
      const items = data.items ?? [];
      const captured = items.filter((p) => p.status === "captured");

      if (captured.length > 0) {
        const rows = captured.map((p) => ({
          razorpay_payment_id: p.id,
          // Settlement fields start as null — Phase 2 overlays real values.
          // ignoreDuplicates: false so Phase 2 upsert can update them later,
          // but here we only write payment-level fields we're sure about.
          amount:              p.amount   != null ? p.amount   / 100 : null,
          fee:                 p.fee      != null ? p.fee      / 100 : null,
          tax:                 p.tax      != null ? p.tax      / 100 : null,
          payment_method:      p.method   ?? null,
          order_id:            p.order_id ?? null,
          payment_created_at:  p.created_at ? new Date(p.created_at * 1000).toISOString() : null,
          last_synced_at:      new Date().toISOString(),
        }));

        // Only insert if not already present — don't overwrite settlement data
        const { error: upsertErr } = await adminSupabase
          .from("razorpay_settlement_cache")
          .upsert(rows, { onConflict: "razorpay_payment_id", ignoreDuplicates: true });

        if (upsertErr) {
          errorMessage = `Phase 1 upsert (${year}/${month}): ${upsertErr.message}`;
          hasMore = false;
          break;
        }

        totalCaptured += captured.length;
      }

      hasMore = items.length === count;
      skip   += count;
    }
  }

  // ── Phase 2: Settlement Recon — overlay UTR / fees / settled status ────────
  // Runs over the same month window so new payments from Phase 1 also get
  // their settlement data if they've already been settled.
  for (const { year, month } of monthsToFetch) {
    if (errorMessage) break;

    let skip = 0;
    const count = 1000;
    let hasMore = true;

    while (hasMore) {
      const url = `https://api.razorpay.com/v1/settlements/recon/combined?year=${year}&month=${month}&count=${count}&skip=${skip}`;

      let recon: { count: number; items: ReconItem[] } | null = null;
      try {
        const resp = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
        if (!resp.ok) {
          if (resp.status === 404) { hasMore = false; break; }
          const body = await resp.text();
          errorMessage = `Recon API ${resp.status} (${year}/${month}): ${body.slice(0, 200)}`;
          hasMore = false;
          break;
        }
        recon = await resp.json();
      } catch (e) {
        errorMessage = `Recon API network error: ${e instanceof Error ? e.message : "unknown"}`;
        hasMore = false;
        break;
      }

      const items: ReconItem[] = recon?.items ?? [];
      const payments = items.filter((it) => it.type === "payment");

      if (payments.length > 0) {
        const rows = payments.map((it) => ({
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

        const { error: upsertErr } = await adminSupabase
          .from("razorpay_settlement_cache")
          .upsert(rows, { onConflict: "razorpay_payment_id" });

        if (upsertErr) {
          errorMessage = `Phase 2 upsert (${year}/${month}): ${upsertErr.message}`;
          hasMore = false;
          break;
        }
      }

      hasMore = items.length === count;
      skip   += count;
    }
  }

  // ── Record sync attempt ───────────────────────────────────────────────────
  await adminSupabase.from("razorpay_sync_log").insert({
    months_back:     monthsToFetch.length,
    records_updated: totalCaptured,
    error_message:   errorMessage,
  });

  if (errorMessage) {
    return NextResponse.json({ error: errorMessage, records_updated: totalCaptured }, { status: 500 });
  }

  return NextResponse.json({
    message:         `Synced ${totalCaptured} payment records across ${monthsToFetch.length} month(s)`,
    records_updated: totalCaptured,
    window_start:    windowStart.toISOString().slice(0, 10),
    window_end:      now.toISOString().slice(0, 10),
    months_synced:   monthsToFetch,
  });
}

// ── Types ────────────────────────────────────────────────────────────────────

interface RazorpayPayment {
  id:         string;
  status:     string;
  amount:     number;
  fee:        number | null;
  tax:        number | null;
  method:     string | null;
  order_id:   string | null;
  created_at: number;
}

interface ReconItem {
  entity_id:      string;
  type:           "payment" | "refund" | "transfer" | "adjustment";
  amount:         number;
  fee:            number | null;
  tax:            number | null;
  settled:        boolean;
  created_at:     number;
  settled_at:     number | null;
  settlement_id:  string | null;
  settlement_utr: string | null;
  method:         string | null;
  order_id:       string | null;
  on_hold:        boolean;
  debit:          number;
  credit:         number;
  currency:       string;
}
