import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { createInvoiceSchema } from "@/lib/validations";
import { logAudit } from "@/lib/audit";
import { invoiceParty, type InvoiceCaseLike } from "@/lib/invoice-party";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const page = parseInt(searchParams.get("page") || "1");
  const limit = parseInt(searchParams.get("limit") || "25");
  const status = searchParams.get("status");
  const leadId = searchParams.get("lead_id");
  const caseId = searchParams.get("case_id");

  const offset = (page - 1) * limit;

  let query = supabase
    .from("proforma_invoices")
    .select("*, lead:leads!proforma_invoices_lead_id_fkey(id, first_name, last_name, company)", { count: "exact" });

  if (status) query = query.eq("status", status);
  if (leadId) query = query.eq("lead_id", leadId);
  if (caseId) query = query.eq("case_id", caseId);
  query = query.order("created_at", { ascending: false }).range(offset, offset + limit - 1);

  const { data, error, count } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    data,
    pagination: { page, limit, total: count || 0, totalPages: Math.ceil((count || 0) / limit) },
  });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "manager", "sales_rep", "floor_manager"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Only admin, manager, sales_rep, or floor_manager can create invoices" }, { status: 403 });
  }

  const body = await request.json();
  const result = createInvoiceSchema.safeParse(body);
  if (!result.success) {
    return NextResponse.json({ error: "Validation failed", details: result.error.issues }, { status: 400 });
  }

  // Security deposits are refundable and GST-exempt — collecting one through an
  // ad-hoc invoice books it as taxed revenue and makes it invisible to the
  // deposit ledger (get_deposit_available_balance). Always redirect to the
  // proposal deposit link instead. No override — client already blocks this
  // in the UI, this is defense in depth.
  if (result.data.primary_head === "security_deposit") {
    return NextResponse.json(
      { error: "Security deposits can't be collected via an ad-hoc invoice. Use the deposit link on the proposal instead." },
      { status: 400 }
    );
  }

  const items = result.data.items;
  const subtotal = items.reduce((sum, item) => sum + item.total, 0);
  const taxAmount = subtotal * (result.data.tax_percentage / 100);
  const discountAmount = subtotal * (result.data.discount_percentage / 100);
  const totalAmount = subtotal + taxAmount - discountAmount;

  // invoice_number is left unset so the generate_invoice_number() DB trigger
  // assigns it atomically within the INSERT — computing it here via a separate
  // SELECT COUNT(*) round trip was racy under concurrent invoice creation and
  // could violate the invoice_number UNIQUE constraint.
  const { data, error } = await supabase
    .from("proforma_invoices")
    .insert({
      ...result.data,
      status: "draft",
      subtotal,
      tax_amount: taxAmount,
      discount_amount: discountAmount,
      total_amount: totalAmount,
      created_by: dbUser?.id,
    })
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const invoiceNumber: string = data.invoice_number;

  if (data && dbUser?.id) {
    logAudit(supabase, {
      entityType: "invoice",
      entityId: data.id,
      action: "create",
      performedBy: dbUser.id,
      changes: { record: { old: null, new: data } },
    });
  }

  // ── Auto-create Razorpay payment link at creation time ────────────────────
  // This makes the link available immediately in the PDF download and avoids
  // recreating it on every email send.
  if (data && totalAmount > 0 && (result.data.lead_id || result.data.case_id)) {
    try {
      const adminSupabase = createAdminClient();
      const { data: rzpSettings } = await adminSupabase
        .from("app_settings")
        .select("key, value")
        .in("key", ["razorpay_enabled", "razorpay_key_id", "razorpay_key_secret"]);

      const rzpMap: Record<string, string> = {};
      (rzpSettings || []).forEach((s: { key: string; value: string }) => { rzpMap[s.key] = s.value; });

      if (rzpMap.razorpay_enabled === "true" && rzpMap.razorpay_key_id && rzpMap.razorpay_key_secret) {
        // Prefill the Razorpay customer with whoever is actually being billed.
        // On a case that is the case's billing party — an aggregator for a
        // partner-billed case — not the end client, who does not owe it.
        let party = null;
        if (result.data.case_id) {
          const { data: caseRow } = await supabase
            .from("cases")
            .select("client_name, client_company_name, client_email, client_phone, client_gst_number, aggregator_id, bill_to, aggregator:aggregators!cases_aggregator_id_fkey(name, billing_method, primary_email, primary_phone, gst_number)")
            .eq("id", result.data.case_id)
            .maybeSingle();
          if (caseRow) {
            party = invoiceParty({
              case: caseRow as unknown as InvoiceCaseLike,
              billClientOverride: result.data.bill_client_override,
            });
          }
        } else {
          const { data: lead } = await supabase
            .from("leads")
            .select("first_name, last_name, company, email, phone, mobile")
            .eq("id", result.data.lead_id!)
            .single();
          party = invoiceParty({ lead });
        }

        const customerName = party?.name ?? "";
        const customerEmail = party?.email ?? "";
        const customerPhone = party?.phone ?? "";

        const auth = Buffer.from(
          `${rzpMap.razorpay_key_id}:${rzpMap.razorpay_key_secret}`
        ).toString("base64");
        const appUrl = (
          process.env.NEXT_PUBLIC_APP_URL || "https://twv-crm.vercel.app"
        ).trim();

        // Expire at the due date if set, else 30 days from now. Due dates under
        // a day away (or already past) are clamped to a 1-day minimum so the
        // link isn't created already-expired — but a due date further out than
        // that is honored as-is; it must NOT be pushed further out to 30 days
        // (that previously let the link stay payable well past the due date).
        const nowSeconds = Math.floor(Date.now() / 1000);
        const defaultExpiry = nowSeconds + 30 * 24 * 60 * 60;
        const minExpiry = nowSeconds + 24 * 60 * 60;
        const expireBy = result.data.due_date
          ? Math.max(Math.floor(new Date(result.data.due_date).getTime() / 1000), minExpiry)
          : defaultExpiry;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const payload: Record<string, any> = {
          amount: Math.round(totalAmount * 100),
          currency: "INR",
          description: `${invoiceNumber} — ${result.data.title} — The WorkVilla`,
          reference_id: `${invoiceNumber}-${Date.now()}`,
          expire_by: expireBy,
          notify: { sms: !!customerPhone, email: !!customerEmail },
          reminder_enable: true,
          notes: {
            invoice_id: data.id,
            invoice_number: invoiceNumber,
            type: "adhoc_invoice",
          },
          callback_url: `${appUrl}/invoices`,
          callback_method: "get",
        };

        if (customerName || customerEmail || customerPhone) {
          payload.customer = {};
          if (customerName) payload.customer.name = customerName;
          if (customerEmail) payload.customer.email = customerEmail;
          if (customerPhone)
            payload.customer.contact = customerPhone.replace(/\s/g, "");
        }

        const rzpRes = await fetch("https://api.razorpay.com/v1/payment_links", {
          method: "POST",
          headers: {
            Authorization: `Basic ${auth}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });

        if (rzpRes.ok) {
          const linkData = await rzpRes.json();
          await supabase
            .from("proforma_invoices")
            .update({
              razorpay_link_id: linkData.id,
              razorpay_link_url: linkData.short_url,
            })
            .eq("id", data.id);
          // Return the enriched record so the UI can show the link immediately
          data.razorpay_link_id = linkData.id;
          data.razorpay_link_url = linkData.short_url;
        } else {
          console.warn(
            "[invoice create] Razorpay link creation failed:",
            await rzpRes.json().catch(() => null)
          );
        }
      }
    } catch (e) {
      // Non-fatal — invoice was already saved; link can be created on first email send
      console.warn("[invoice create] Razorpay error (non-fatal):", e);
    }
  }

  return NextResponse.json({ data }, { status: 201 });
}
