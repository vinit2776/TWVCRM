import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { createInvoiceSchema } from "@/lib/validations";
import { logAudit } from "@/lib/audit";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const page = parseInt(searchParams.get("page") || "1");
  const limit = parseInt(searchParams.get("limit") || "25");
  const status = searchParams.get("status");
  const leadId = searchParams.get("lead_id");

  const offset = (page - 1) * limit;

  let query = supabase
    .from("proforma_invoices")
    .select("*, lead:leads!proforma_invoices_lead_id_fkey(id, first_name, last_name, company)", { count: "exact" });

  if (status) query = query.eq("status", status);
  if (leadId) query = query.eq("lead_id", leadId);
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

  const { count } = await supabase.from("proforma_invoices").select("*", { count: "exact", head: true });
  const invoiceNumber = `INV-${String((count || 0) + 1).padStart(4, "0")}`;

  const { data, error } = await supabase
    .from("proforma_invoices")
    .insert({
      ...result.data,
      invoice_number: invoiceNumber,
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
  if (data && totalAmount > 0 && result.data.lead_id) {
    try {
      const adminSupabase = createAdminClient();
      const { data: rzpSettings } = await adminSupabase
        .from("app_settings")
        .select("key, value")
        .in("key", ["razorpay_enabled", "razorpay_key_id", "razorpay_key_secret"]);

      const rzpMap: Record<string, string> = {};
      (rzpSettings || []).forEach((s: { key: string; value: string }) => { rzpMap[s.key] = s.value; });

      if (rzpMap.razorpay_enabled === "true" && rzpMap.razorpay_key_id && rzpMap.razorpay_key_secret) {
        // Fetch lead contact details for Razorpay customer prefill
        const { data: lead } = await supabase
          .from("leads")
          .select("first_name, last_name, email, phone, mobile")
          .eq("id", result.data.lead_id)
          .single();

        const customerName = lead
          ? `${lead.first_name || ""} ${lead.last_name || ""}`.trim()
          : "";
        const customerEmail = (lead as { email?: string } | null)?.email || "";
        const customerPhone = ((lead as { phone?: string; mobile?: string } | null)?.phone ||
          (lead as { phone?: string; mobile?: string } | null)?.mobile || "");

        const auth = Buffer.from(
          `${rzpMap.razorpay_key_id}:${rzpMap.razorpay_key_secret}`
        ).toString("base64");
        const appUrl = (
          process.env.NEXT_PUBLIC_APP_URL || "https://twv-crm.vercel.app"
        ).trim();

        // Expire at due date (if set) or 30 days from now
        const defaultExpiry = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
        const expireBy = result.data.due_date
          ? Math.max(
              Math.floor(new Date(result.data.due_date).getTime() / 1000),
              defaultExpiry
            )
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
