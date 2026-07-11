import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { z } from "zod";
import { createIrpClient, loadPublicConfig, loadCredentials } from "@/lib/e-invoice";
import { recordIrnCancelled } from "@/lib/e-invoice/persist-invoice";
import { zodErrorResponse } from "@/lib/validations";

const requestSchema = z.object({
  gst_invoice_id: z.string().uuid(),
  reason_code: z.enum(["1", "2", "3", "4"]),
  // 1=Duplicate, 2=Data entry mistake, 3=Order Cancelled, 4=Others
  remarks: z.string().max(100).optional(),
});

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

/**
 * POST /api/e-invoice/cancel
 *
 * Cancels an existing IRN. Enforces the 24-hour window client-side too —
 * even though NIC enforces it server-side, we surface a clearer error
 * than NIC's terse "2270 cancel window expired".
 *
 * Roles: admin, manager, accounts.
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
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });
  if (!["admin", "manager", "accounts"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const parsed = requestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  }

  // ── Load gst_invoice ────────────────────────────────────────────────────
  const { data: invoice, error: invErr } = await supabase
    .from("gst_invoices")
    .select("*")
    .eq("id", parsed.data.gst_invoice_id)
    .single();
  if (invErr || !invoice) {
    return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
  }

  if (invoice.e_invoice_status !== "generated" || !invoice.irn) {
    return NextResponse.json(
      { error: `Invoice is in status "${invoice.e_invoice_status}" — only generated IRNs can be cancelled` },
      { status: 422 }
    );
  }

  // ── Pre-flight: 24-hour window ──────────────────────────────────────────
  const generatedAt = invoice.e_invoice_generated_at ? new Date(invoice.e_invoice_generated_at) : null;
  if (!generatedAt) {
    return NextResponse.json(
      { error: "Invoice has IRN but no generation timestamp — cannot determine cancel window" },
      { status: 422 }
    );
  }
  const ageMs = Date.now() - generatedAt.getTime();
  if (ageMs >= TWENTY_FOUR_HOURS_MS) {
    return NextResponse.json(
      {
        error: "Cancellation window has expired (24 hours). Issue a Credit Note instead.",
        code: "WINDOW_EXPIRED",
        generated_at: generatedAt.toISOString(),
      },
      { status: 422 }
    );
  }

  // ── Submit cancel to IRP ────────────────────────────────────────────────
  const config = await loadPublicConfig(supabase);
  const credentials = await loadCredentials(supabase, config.environment);
  const client = createIrpClient(
    {
      provider: config.irp_provider,
      environment: config.environment,
      gstin: config.seller_gstin,
      credentials,
    },
    supabase
  );

  const result = await client.cancelIrn({
    Irn: invoice.irn,
    CnlRsn: parsed.data.reason_code,
    CnlRem: parsed.data.remarks,
  });

  // ── Audit log ───────────────────────────────────────────────────────────
  await supabase.from("e_invoice_api_log").insert({
    gst_invoice_id: invoice.id,
    endpoint: "POST /eicore/v1.03/Invoice/Cancel",
    irp_provider: config.irp_provider,
    environment: config.environment,
    request_summary: {
      irn: invoice.irn,
      reason_code: parsed.data.reason_code,
      remarks: parsed.data.remarks,
    },
    response_summary: result.ok
      ? { cancelled: true, cancel_date: result.data.CancelDate }
      : { error_code: result.error.code, error_message: result.error.message, raw: result.raw_response },
    irp_status_code: result.ok ? "1" : "0",
    irp_error_code: result.ok ? null : result.error.code,
    irp_error_message: result.ok ? null : result.error.message,
    latency_ms: result.latency_ms,
    attempted_by: dbUser.id,
  });

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error.message, code: result.error.code, latency_ms: result.latency_ms },
      { status: 502 }
    );
  }

  await recordIrnCancelled(
    supabase,
    invoice.id,
    parsed.data.reason_code,
    parsed.data.remarks ?? null,
  );

  return NextResponse.json({
    ok: true,
    cancel_date: result.data.CancelDate,
    latency_ms: result.latency_ms,
  });
}
