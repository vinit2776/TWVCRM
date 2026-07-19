import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/server";
import { pingCronHealth } from "@/lib/cron-ping";

export const maxDuration = 60;

/**
 * GET /api/cron/settlement-recon
 *
 * Stamps Razorpay bank-settlement dates onto payments the CRM has recorded.
 *
 * Razorpay's payment object doesn't carry a settlement date — money is
 * captured immediately but reaches the bank on a T+2/T+3 cycle, and the
 * mapping only exists in the settlement recon report. Without this, accounts
 * can see that a customer paid but not when the money actually landed, which
 * is what they need to tie a deposit to a bank statement line.
 *
 * Pulls the combined recon report for the current (and, near month start,
 * previous) month, then matches report rows to stored payment references.
 *
 * Query: ?months=N  — look back N months instead of the default window
 *        ?dry=1     — report what would be stamped, write nothing
 */

interface ReconRow {
  entity_id: string;       // pay_XXXX
  settlement_id?: string | null;
  settled_at?: number | null;   // unix seconds
  settlement_utr?: string | null;
  type?: string;
}

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const dry = url.searchParams.get("dry") === "1";
  const monthsParam = parseInt(url.searchParams.get("months") || "", 10);

  const admin = createAdminClient();

  const { data: rzpSettings } = await admin
    .from("app_settings")
    .select("key, value")
    .in("key", ["razorpay_enabled", "razorpay_key_id", "razorpay_key_secret"]);
  const rzp: Record<string, string> = {};
  (rzpSettings || []).forEach((s) => { rzp[s.key] = s.value; });

  if (rzp.razorpay_enabled !== "true" || !rzp.razorpay_key_id || !rzp.razorpay_key_secret) {
    await pingCronHealth("settlement-recon", "ok", { skipped: "razorpay disabled" });
    return NextResponse.json({ status: "skipped", reason: "Razorpay not enabled" });
  }

  const auth = Buffer.from(`${rzp.razorpay_key_id}:${rzp.razorpay_key_secret}`).toString("base64");

  // Which months to pull. Settlement lags capture by a few days, so early in
  // the month the previous month still gains new rows.
  const now = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const windows: { year: number; month: number }[] = [];
  const lookback = Number.isFinite(monthsParam) && monthsParam > 0 ? monthsParam : (now.getUTCDate() <= 5 ? 2 : 1);
  for (let i = 0; i < lookback; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    windows.push({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 });
  }

  const reconByPaymentId = new Map<string, ReconRow>();
  const fetchErrors: string[] = [];

  for (const w of windows) {
    let skip = 0;
    // Report is paginated; 1000 is Razorpay's max page size.
    for (;;) {
      const endpoint = `https://api.razorpay.com/v1/settlements/recon/combined?year=${w.year}&month=${String(w.month).padStart(2, "0")}&count=1000&skip=${skip}`;
      try {
        const res = await fetch(endpoint, { headers: { Authorization: `Basic ${auth}` } });
        if (!res.ok) {
          fetchErrors.push(`${w.year}-${w.month}: HTTP ${res.status}`);
          break;
        }
        const body = await res.json();
        const items: ReconRow[] = body?.items || [];
        for (const it of items) {
          // Only payment rows carry a customer payment id; refunds/adjustments
          // share the report but aren't what we're reconciling here.
          if (it.entity_id?.startsWith("pay_") && it.settled_at) {
            reconByPaymentId.set(it.entity_id, it);
          }
        }
        if (items.length < 1000) break;
        skip += 1000;
      } catch (err) {
        fetchErrors.push(`${w.year}-${w.month}: ${err instanceof Error ? err.message : String(err)}`);
        break;
      }
    }
  }

  if (reconByPaymentId.size === 0) {
    await pingCronHealth("settlement-recon", fetchErrors.length ? "error" : "ok", {
      stamped: 0, errors: fetchErrors.length,
    });
    return NextResponse.json({ status: "ok", dry, recon_rows: 0, stamped: 0, errors: fetchErrors });
  }

  const stamped = { deposits: 0, topups: 0, invoices: 0, statements: 0 };

  const stamp = async (
    table: string,
    refCol: string,
    settledCol: string,
    settlementIdCol: string,
    extraFilter: (q: ReturnType<SupabaseClient["from"]>) => unknown,
    counterKey: keyof typeof stamped,
  ) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q: any = admin.from(table).select(`id, ${refCol}`).is(settledCol, null).not(refCol, "is", null);
    q = extraFilter(q) ?? q;
    const { data: rows } = await q;
    for (const r of (rows || []) as Record<string, string>[]) {
      const hit = reconByPaymentId.get(r[refCol]);
      if (!hit?.settled_at) continue;
      if (!dry) {
        await admin.from(table).update({
          [settledCol]: new Date(hit.settled_at * 1000).toISOString(),
          [settlementIdCol]: hit.settlement_id || hit.settlement_utr || null,
        }).eq("id", r.id);
      }
      stamped[counterKey]++;
    }
  };

  await stamp(
    "proposals", "deposit_payment_reference", "deposit_settled_at", "deposit_settlement_id",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (q: any) => q.eq("deposit_payment_status", "paid"),
    "deposits",
  );
  await stamp(
    "deposit_topups", "payment_reference", "settled_at", "settlement_id",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (q: any) => q.eq("status", "paid"),
    "topups",
  );
  await stamp(
    "proforma_invoices", "payment_reference", "settled_at", "settlement_id",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (q: any) => q.eq("status", "paid"),
    "invoices",
  );

  const total = stamped.deposits + stamped.topups + stamped.invoices;
  await pingCronHealth("settlement-recon", fetchErrors.length ? "error" : "ok", {
    stamped: total, errors: fetchErrors.length,
  });

  return NextResponse.json({
    status: "ok", dry,
    windows, recon_rows: reconByPaymentId.size,
    stamped, total, errors: fetchErrors,
  });
}
