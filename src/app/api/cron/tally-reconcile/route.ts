import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { pingCronHealth } from "@/lib/cron-ping";
import { dispatchTallyInvoice } from "@/lib/tally/dispatch-tally-invoice";

export const maxDuration = 60;

const DEFAULT_IRN_ALARM_HOURS = 24;

/**
 * GET /api/cron/tally-reconcile
 *
 * Self-healing sweep for the Tally GST-issuance pipe (OV5). The happy path is:
 *   enqueue → bridge posts voucher → /api/tally/ack → dispatchTallyInvoice sends.
 * Any step can drop: the ack arrives but the fire-and-forget dispatch throws
 * (Razorpay down, email timeout, storage blip), or the process dies between the
 * ack mirror and tally_delivered_at. The statement is then ISSUED in Tally
 * (tally_invoice_number set, books-of-record correct) but the customer never
 * got it (tally_delivered_at NULL). This cron finds those and re-drives delivery.
 *
 * dispatchTallyInvoice is delivered-once gated (keyed on tally_delivered_at), so
 * re-running it on an already-delivered statement is a no-op — safe to sweep often.
 *
 * Scope is deliberately narrow: only statements that Tally has ALREADY issued
 * (tally_invoice_number present) but not delivered. Jobs still in flight (no
 * invoice number yet) are the bridge's responsibility and are left alone. B2B
 * invoices awaiting an IRN (lifecycle_stage='awaiting_irn') are also skipped —
 * delivery there waits for the IRN re-ack by design.
 *
 * Query: ?dry=1 — list candidates, deliver nothing.
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const dry = new URL(request.url).searchParams.get("dry") === "1";
  const admin = createAdminClient();

  // Undelivered, already-issued Tally invoices. Matches the partial index
  // billing_statements_tally_undelivered_idx from migration 00238.
  const { data: stuck, error } = await admin
    .from("billing_statements")
    .select("id, statement_number, tally_invoice_number, total_amount, lifecycle_stage, tally_synced_at")
    .eq("issuance_channel", "tally")
    .not("tally_invoice_number", "is", null)
    .is("tally_delivered_at", null)
    // B2B IRN pending → not our job. NOTE: lifecycle_stage is NULL for the
    // vast majority of rows (only the ack-driven auto-dispatch path ever sets
    // it), and Postgres's NULL <> 'x' evaluates to NULL/false — a plain
    // .neq() here silently drops every NULL row instead of including it, which
    // let dozens of "issued but never delivered" statements go unnoticed
    // indefinitely. Use .or() so NULL rows are explicitly kept.
    .or("lifecycle_stage.is.null,lifecycle_stage.neq.awaiting_irn")
    .order("tally_synced_at", { ascending: true })
    .limit(50);

  if (error) {
    await pingCronHealth("cron/tally-reconcile", "error", { error: error.message });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const candidates = stuck || [];
  const results: { id: string; stmt: string; invoice: string; status: string; error?: string }[] = [];
  let delivered = 0, failed = 0;

  for (const s of candidates) {
    if (dry) {
      results.push({ id: s.id, stmt: s.statement_number, invoice: s.tally_invoice_number as string, status: "candidate" });
      continue;
    }
    try {
      const r = await dispatchTallyInvoice(admin, s.id, {
        invoiceNumber: s.tally_invoice_number as string,
        totalAmount:   Number(s.total_amount || 0),
        // signedQr/irn are re-read inside dispatch from the statement if needed;
        // for a redelivery we pass what we mirrored. B2C has neither.
        signedQrCode:  null,
        irn:           null,
      });
      if (r.ok) { delivered++; results.push({ id: s.id, stmt: s.statement_number, invoice: s.tally_invoice_number as string, status: r.alreadyDelivered ? "already-delivered" : "delivered" }); }
      else { failed++; results.push({ id: s.id, stmt: s.statement_number, invoice: s.tally_invoice_number as string, status: "failed", error: r.error }); }
    } catch (err) {
      failed++;
      results.push({ id: s.id, stmt: s.statement_number, invoice: s.tally_invoice_number as string, status: "failed", error: String(err) });
    }
  }

  // ── IRN aging alert ──────────────────────────────────────────────────────────
  // B2B invoices stuck in awaiting_irn for longer than tally_irn_alarm_hours are
  // a sign the IRP is not responding or the bridge lost the IRN callback. Surface
  // them in the cron response so monitoring can alert on them.
  const { data: alarmRow } = await admin
    .from("app_settings")
    .select("value")
    .eq("key", "tally_irn_alarm_hours")
    .maybeSingle();
  const alarmHours = Number(alarmRow?.value) || DEFAULT_IRN_ALARM_HOURS;
  const alarmCutoff = new Date(Date.now() - alarmHours * 60 * 60 * 1000).toISOString();

  const { data: stuckIrn } = await admin
    .from("billing_statements")
    .select("id, statement_number, tally_invoice_number, tally_synced_at")
    .eq("lifecycle_stage", "awaiting_irn")
    .lt("tally_synced_at", alarmCutoff)
    .order("tally_synced_at", { ascending: true })
    .limit(20);

  const stuckIrnList = (stuckIrn ?? []).map((s: { id: string; statement_number: string; tally_invoice_number: string | null; tally_synced_at: string | null }) => ({
    id: s.id,
    stmt: s.statement_number,
    invoice: s.tally_invoice_number,
    synced_at: s.tally_synced_at,
  }));

  if (stuckIrnList.length > 0) {
    console.error(`[tally-reconcile] ${stuckIrnList.length} statement(s) stuck in awaiting_irn for >${alarmHours}h`, stuckIrnList);
  }

  await pingCronHealth("cron/tally-reconcile", "ok", {
    candidates: candidates.length, delivered, failed, dry,
    stuck_irn: stuckIrnList.length,
  });

  return NextResponse.json({
    ok: true,
    dry,
    candidates: candidates.length,
    delivered,
    failed,
    results,
    stuck_irn: stuckIrnList,
  });
}
