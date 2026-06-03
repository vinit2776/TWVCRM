import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { pingCronHealth } from "@/lib/cron-ping";
import { dispatchTallyInvoice } from "@/lib/tally/dispatch-tally-invoice";

export const maxDuration = 60;

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
    .neq("lifecycle_stage", "awaiting_irn")   // B2B IRN pending → not our job
    .order("tally_synced_at", { ascending: true })
    .limit(50);

  if (error) {
    await pingCronHealth("tally-reconcile", "error", { error: error.message });
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

  await pingCronHealth("tally-reconcile", "ok", { candidates: candidates.length, delivered, failed, dry });

  return NextResponse.json({
    ok: true,
    dry,
    candidates: candidates.length,
    delivered,
    failed,
    results,
  });
}
