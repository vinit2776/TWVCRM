/**
 * GET /api/tally/awaiting-irn
 *
 * Bridge-only endpoint. Returns B2B invoices that have been created in Tally
 * (voucher exists, invoice number assigned) but whose IRN has not yet been
 * generated. The bridge queries Tally for each one's IRN and, when it appears,
 * acks it (POST /api/tally/ack) — which completes the invoice and triggers
 * customer delivery + the Razorpay link.
 *
 * These are jobs in 'posted' status (set when the voucher was created with
 * irn_pending = true).
 *
 * Auth: Bearer TALLY_AGENT_TOKEN
 *
 * Response: { vouchers: [{ job_id, invoice_number, voucher_created_at }] }
 */

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";

function authGuard(request: NextRequest): boolean {
  return request.headers.get("authorization") === `Bearer ${process.env.TALLY_AGENT_TOKEN}`;
}

export async function GET(request: NextRequest) {
  if (!authGuard(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("tally_sync_jobs")
    .select("id, tally_invoice_number, tally_voucher_guid, voucher_created_at")
    .eq("status", "posted")                 // voucher created, IRN still pending
    .not("tally_invoice_number", "is", null)
    .order("voucher_created_at", { ascending: true })
    .limit(50);

  if (error) {
    console.error("[tally/awaiting-irn] query error:", error.message);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }

  return NextResponse.json({
    vouchers: (data ?? []).map((j: {
      id: string;
      tally_invoice_number: string | null;
      tally_voucher_guid: string | null;
      voucher_created_at: string | null;
    }) => ({
      job_id:             j.id,
      invoice_number:     j.tally_invoice_number,
      voucher_guid:       j.tally_voucher_guid,
      voucher_created_at: j.voucher_created_at,
    })),
  });
}
