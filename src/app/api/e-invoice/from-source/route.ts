import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { z } from "zod";
import {
  loadPublicConfig,
  buildGstInvoice,
  sellerFromConfig,
  validateForIrn,
} from "@/lib/e-invoice";
import { createGstInvoice } from "@/lib/e-invoice/persist-invoice";
import type { BuilderInput } from "@/lib/e-invoice/build-invoice";

/**
 * POST /api/e-invoice/from-source
 *
 * Creates a new gst_invoices row (and gst_invoice_items rows) by reading
 * an existing booking, contract_payment, or proforma_invoice. Returns the
 * new gst_invoice_id. Idempotent — if a row already exists for this
 * source, returns the existing id.
 *
 * Does NOT call the IRP — call /api/e-invoice/generate after this with
 * the returned gst_invoice_id.
 *
 * Roles: admin, manager, accounts.
 */
const requestSchema = z.discriminatedUnion("source_type", [
  z.object({
    source_type: z.literal("contract_payment"),
    contract_payment_id: z.string().uuid(),
    invoice_number: z.string().min(1).max(16),
    invoice_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    item_description: z.string().min(3).max(300).optional(),
  }),
  z.object({
    source_type: z.literal("booking"),
    booking_id: z.string().uuid(),
    invoice_number: z.string().min(1).max(16),
    invoice_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    item_description: z.string().min(3).max(300).optional(),
  }),
]);

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
  const input = parsed.data;

  const config = await loadPublicConfig(supabase);
  if (!config.seller_gstin || !config.seller_legal_name) {
    return NextResponse.json(
      { error: "Seller details incomplete. Configure them in Settings → E-Invoicing." },
      { status: 400 }
    );
  }

  let builderInput: BuilderInput;
  let sourceId: string;

  if (input.source_type === "contract_payment") {
    sourceId = input.contract_payment_id;
    const { data: cp, error } = await supabase
      .from("contract_payments")
      .select(
        `id, amount, payment_date,
         contract:contracts(id, contract_number, monthly_membership_fee,
           lead:leads(id, first_name, last_name, company, gst_number, email, phone, mobile, street, city, state, zip_code))`
      )
      .eq("id", input.contract_payment_id)
      .single();
    if (error || !cp) return NextResponse.json({ error: "Contract payment not found" }, { status: 404 });

    const contract = (cp.contract as unknown) as {
      id: string;
      contract_number: string;
      monthly_membership_fee: number;
      lead: {
        id: string; first_name: string; last_name: string; company?: string;
        gst_number?: string; email?: string; phone?: string; mobile?: string;
        street?: string; city?: string; state?: string; zip_code?: string;
      } | null;
    } | null;

    if (!contract?.lead) {
      return NextResponse.json({ error: "Contract or lead missing" }, { status: 422 });
    }

    const buyerName = contract.lead.company || `${contract.lead.first_name} ${contract.lead.last_name}`.trim();
    const description = input.item_description ?? `Coworking subscription — ${contract.contract_number}`;

    // The amount paid is GST-inclusive; back-compute the pre-tax unit price
    const grossInclusiveTax = Number(cp.amount);
    const rate = config.default_gst_rate;
    const preTax = round2(grossInclusiveTax / (1 + rate / 100));

    builderInput = {
      doc_type: "INV",
      invoice_number: input.invoice_number,
      invoice_date: input.invoice_date,
      seller: sellerFromConfig(config),
      buyer: {
        legal_name: buyerName,
        gstin: contract.lead.gst_number,
        address1: contract.lead.street,
        city: contract.lead.city,
        state: contract.lead.state,
        pincode: contract.lead.zip_code,
        email: contract.lead.email,
        phone: contract.lead.phone || contract.lead.mobile,
      },
      items: [
        {
          description,
          unit_price: preTax,
          quantity: 1,
        },
      ],
    };
  } else {
    // ── booking ──
    sourceId = input.booking_id;
    const { data: bk, error } = await supabase
      .from("bookings")
      .select(
        `id, total_amount,
         lead:leads(id, first_name, last_name, company, gst_number, email, phone, mobile, street, city, state, zip_code)`
      )
      .eq("id", input.booking_id)
      .single();
    if (error || !bk) return NextResponse.json({ error: "Booking not found" }, { status: 404 });

    const lead = (bk.lead as unknown) as {
      id: string; first_name: string; last_name: string; company?: string;
      gst_number?: string; email?: string; phone?: string; mobile?: string;
      street?: string; city?: string; state?: string; zip_code?: string;
    } | null;

    if (!lead) return NextResponse.json({ error: "Booking has no lead" }, { status: 422 });

    const buyerName = lead.company || `${lead.first_name} ${lead.last_name}`.trim();
    const description = input.item_description ?? `Workspace booking — ${input.booking_id.slice(0, 8)}`;
    const gross = Number(bk.total_amount);
    const rate = config.default_gst_rate;
    const preTax = round2(gross / (1 + rate / 100));

    builderInput = {
      doc_type: "INV",
      invoice_number: input.invoice_number,
      invoice_date: input.invoice_date,
      seller: sellerFromConfig(config),
      buyer: {
        legal_name: buyerName,
        gstin: lead.gst_number,
        address1: lead.street,
        city: lead.city,
        state: lead.state,
        pincode: lead.zip_code,
        email: lead.email,
        phone: lead.phone || lead.mobile,
      },
      items: [
        {
          description,
          unit_price: preTax,
          quantity: 1,
          unit: "NOS",
        },
      ],
    };
  }

  // ── Build, validate, persist ────────────────────────────────────────────
  const internal = buildGstInvoice(builderInput, {
    sac_code: config.default_sac_code,
    gst_rate: config.default_gst_rate,
  });

  // Optional: validate but only as warnings — let user persist even with
  // soft warnings. Hard errors on the IRP path will surface during /generate.
  const validation = validateForIrn(internal);

  const { id, existed } = await createGstInvoice(
    supabase,
    internal,
    { source_type: input.source_type, source_id: sourceId },
    dbUser.id,
  );

  return NextResponse.json({
    ok: true,
    gst_invoice_id: id,
    existed,
    e_invoice_status: internal.buyer.classification === "b2b" ? "pending" : "not_applicable",
    validation_warnings: validation.issues.filter((i) => i.severity === "warning"),
    validation_errors: validation.issues.filter((i) => i.severity === "error"),
    is_intrastate: internal.is_intrastate,
    total_invoice_value: internal.total_invoice_value,
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
