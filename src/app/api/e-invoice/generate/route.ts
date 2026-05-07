import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { z } from "zod";
import {
  createIrpClient,
  loadPublicConfig,
  loadCredentials,
  validateForIrn,
  mapInternalToNic,
} from "@/lib/e-invoice";
import { recordIrnGenerated, recordIrnFailure } from "@/lib/e-invoice/persist-invoice";
import type { InternalGstInvoice } from "@/lib/e-invoice/types";

const requestSchema = z.object({
  gst_invoice_id: z.string().uuid(),
  /** If true, skip the validator's pre-flight (use only for IRP-side debugging). */
  force: z.boolean().optional(),
});

/**
 * POST /api/e-invoice/generate
 *
 * Submits an existing gst_invoices row to the IRP for IRN generation.
 * Idempotent — if the row is already 'generated', returns the cached IRN
 * without re-calling the IRP.
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
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  // ── Load gst_invoice + items ────────────────────────────────────────────
  const { data: invoice, error: invErr } = await supabase
    .from("gst_invoices")
    .select(`*, gst_invoice_items(*)`)
    .eq("id", parsed.data.gst_invoice_id)
    .single();
  if (invErr || !invoice) {
    return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
  }

  // Idempotency
  if (invoice.e_invoice_status === "generated" && invoice.irn) {
    return NextResponse.json({
      ok: true,
      idempotent: true,
      irn: invoice.irn,
      ack_no: invoice.ack_no,
      ack_date: invoice.ack_date,
      signed_qr_code: invoice.signed_qr_code,
    });
  }
  if (invoice.e_invoice_status === "cancelled") {
    return NextResponse.json({ error: "Invoice has been cancelled — re-generation not allowed" }, { status: 422 });
  }
  if (invoice.buyer_classification?.startsWith("b2c")) {
    return NextResponse.json({ error: "B2C invoices do not require IRN" }, { status: 422 });
  }

  // ── Reconstitute InternalGstInvoice from DB rows ────────────────────────
  const internal: InternalGstInvoice = {
    doc_type: invoice.doc_type,
    invoice_number: invoice.invoice_number,
    invoice_date: invoice.invoice_date,
    reference_invoice_number: invoice.reference_invoice_number ?? undefined,
    reference_invoice_date: invoice.reference_invoice_date ?? undefined,
    seller: {
      gstin: invoice.seller_gstin,
      legal_name: invoice.seller_legal_name,
      trade_name: invoice.seller_trade_name ?? undefined,
      address1: invoice.seller_address1,
      address2: invoice.seller_address2 ?? undefined,
      location: invoice.seller_location,
      pincode: invoice.seller_pincode,
      state_code: invoice.seller_state_code,
    },
    buyer: {
      classification: invoice.buyer_classification,
      gstin: invoice.buyer_gstin ?? undefined,
      legal_name: invoice.buyer_legal_name,
      trade_name: invoice.buyer_trade_name ?? undefined,
      address1: invoice.buyer_address1 ?? undefined,
      address2: invoice.buyer_address2 ?? undefined,
      location: invoice.buyer_location ?? undefined,
      pincode: invoice.buyer_pincode ?? undefined,
      state_code: invoice.buyer_state_code ?? undefined,
    },
    place_of_supply_state_code: invoice.place_of_supply_state_code,
    is_intrastate: invoice.is_intrastate,
    currency: invoice.currency,
    total_taxable_value: Number(invoice.total_taxable_value),
    total_cgst_amount: Number(invoice.total_cgst_amount),
    total_sgst_amount: Number(invoice.total_sgst_amount),
    total_igst_amount: Number(invoice.total_igst_amount),
    total_cess_amount: Number(invoice.total_cess_amount),
    total_discount: Number(invoice.total_discount),
    total_other_charges: Number(invoice.total_other_charges),
    round_off_amount: Number(invoice.round_off_amount),
    total_invoice_value: Number(invoice.total_invoice_value),
    items: (invoice.gst_invoice_items ?? [])
      .sort((a: { serial_no: number }, b: { serial_no: number }) => a.serial_no - b.serial_no)
      .map((it: Record<string, unknown>) => ({
        serial_no: it.serial_no as number,
        is_service: it.is_service as boolean,
        hsn_or_sac_code: it.hsn_or_sac_code as string,
        item_description: it.item_description as string,
        unit: (it.unit as string) ?? undefined,
        quantity: Number(it.quantity),
        unit_price: Number(it.unit_price),
        gross_amount: Number(it.gross_amount),
        discount_amount: Number(it.discount_amount),
        other_charges: Number(it.other_charges),
        taxable_value: Number(it.taxable_value),
        gst_rate: Number(it.gst_rate),
        cgst_amount: Number(it.cgst_amount),
        sgst_amount: Number(it.sgst_amount),
        igst_amount: Number(it.igst_amount),
        cess_rate: Number(it.cess_rate),
        cess_amount: Number(it.cess_amount),
        total_item_value: Number(it.total_item_value),
      })),
    remarks: invoice.notes ?? undefined,
  };

  // ── Pre-flight validation ───────────────────────────────────────────────
  if (!parsed.data.force) {
    const result = validateForIrn(internal);
    if (!result.ok) {
      const errors = result.issues.filter((i) => i.severity === "error");
      return NextResponse.json(
        { error: "Pre-flight validation failed", issues: errors },
        { status: 422 }
      );
    }
  }

  // ── Schema map → NIC payload ────────────────────────────────────────────
  let payload;
  try {
    payload = mapInternalToNic(internal);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Schema mapping failed" },
      { status: 422 }
    );
  }

  // ── Load IRP config + credentials ───────────────────────────────────────
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

  // ── Submit ──────────────────────────────────────────────────────────────
  const result = await client.generateIrn(payload);

  // ── Audit log ───────────────────────────────────────────────────────────
  await supabase.from("e_invoice_api_log").insert({
    gst_invoice_id: invoice.id,
    endpoint: "POST /eicore/v1.03/Invoice",
    irp_provider: config.irp_provider,
    environment: config.environment,
    request_summary: {
      invoice_number: invoice.invoice_number,
      buyer_gstin: invoice.buyer_gstin,
      total: Number(invoice.total_invoice_value),
    },
    response_summary: result.ok
      ? { irn: result.data.Irn, ack_no: result.data.AckNo, ack_date: result.data.AckDt }
      : { error_code: result.error.code, error_message: result.error.message, raw: result.raw_response, http_status: result.http_status },
    irp_status_code: result.ok ? "1" : "0",
    irp_error_code: result.ok ? null : result.error.code,
    irp_error_message: result.ok ? null : result.error.message,
    latency_ms: result.latency_ms,
    attempted_by: dbUser.id,
  });

  // ── Recovery: if 2150 (duplicate IRN), fetch existing and treat as success ──
  if (!result.ok && result.error.code === "2150") {
    const existing = await client.getIrnByDocument(
      invoice.doc_type,
      invoice.invoice_number,
      formatNicDate(invoice.invoice_date),
    );
    if (existing.ok) {
      await recordIrnGenerated(supabase, invoice.id, existing.data, {
        irp_used: config.irp_provider,
        environment: config.environment,
      });
      return NextResponse.json({
        ok: true,
        recovered: true,
        irn: existing.data.Irn,
        ack_no: existing.data.AckNo,
        ack_date: existing.data.AckDt,
        signed_qr_code: existing.data.SignedQRCode,
      });
    }
  }

  if (!result.ok) {
    await recordIrnFailure(supabase, invoice.id, result.error.code, result.error.message);
    return NextResponse.json(
      { error: result.error.message, code: result.error.code, latency_ms: result.latency_ms },
      { status: 502 }
    );
  }

  // ── Persist success ─────────────────────────────────────────────────────
  await recordIrnGenerated(supabase, invoice.id, result.data, {
    irp_used: config.irp_provider,
    environment: config.environment,
  });

  return NextResponse.json({
    ok: true,
    irn: result.data.Irn,
    ack_no: result.data.AckNo,
    ack_date: result.data.AckDt,
    signed_qr_code: result.data.SignedQRCode,
    latency_ms: result.latency_ms,
  });
}

function formatNicDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}
