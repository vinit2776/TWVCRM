import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { RAZORPAY_MAX_LINK_VALIDITY_SECONDS } from "@/lib/constants";
import { invoiceParty, type InvoiceCaseLike } from "@/lib/invoice-party";

export const maxDuration = 30;

// Same people who can cancel an invoice — renewing swaps the live way a
// customer pays, so it isn't offered to anyone who can merely create one.
const RENEW_ROLES = ["admin", "manager", "accounts"];
const RAZORPAY_TIMEOUT_MS = 10_000;

/**
 * POST /api/invoices/[id]/renew-link
 *
 * Issues a fresh Razorpay payment link for an unpaid ad-hoc invoice
 * (proforma_invoices) whose link has expired or been cancelled — without it an
 * expired link is a dead end, since the email route only creates a link when
 * the invoice has none.
 *
 * Deliberately does NOT notify the customer: the new link is created with
 * notify off and returned, so the caller decides when to share it (copy it, or
 * use "Email to Lead", which reuses the stored link).
 *
 * Safety: the payment webhook matches payments by the stored link id, so two
 * live links would let a payment land on one nobody is watching. The old link
 * is therefore only replaced when Razorpay confirms it is expired/cancelled, or
 * after a successful cancel of a still-live one. A paid (or part-paid) link
 * blocks the renewal.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !RENEW_ROLES.includes(dbUser.role)) {
    return NextResponse.json(
      { error: "Only admin, manager or accounts can renew a payment link" },
      { status: 403 },
    );
  }

  const { data: invoice } = await supabase
    .from("proforma_invoices")
    .select("id, invoice_number, title, status, total_amount, lead_id, case_id, razorpay_link_id, razorpay_link_url")
    .eq("id", id)
    .single();

  if (!invoice) return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
  if (invoice.status === "paid") {
    return NextResponse.json({ error: "Invoice is already paid" }, { status: 400 });
  }
  if (invoice.status === "cancelled") {
    return NextResponse.json({ error: "Invoice is cancelled" }, { status: 400 });
  }
  if (invoice.status === "draft") {
    return NextResponse.json({ error: "Send the invoice first — a draft has no payment link to renew" }, { status: 400 });
  }
  const totalAmount = Number(invoice.total_amount);
  if (!(totalAmount > 0)) {
    return NextResponse.json({ error: "Invoice has no amount to collect" }, { status: 400 });
  }

  const admin = createAdminClient();

  // A mirrored statement already marked paid means money came in some other
  // way (bank transfer recorded by accounts) — a new link would invite a
  // double payment.
  const { data: statement } = await admin
    .from("billing_statements")
    .select("id, payment_status, voided_at")
    .eq("invoice_id", id)
    .maybeSingle();
  if (statement?.payment_status === "paid") {
    return NextResponse.json({ error: "Linked billing statement is already paid" }, { status: 400 });
  }

  const { data: rzpSettings } = await admin
    .from("app_settings")
    .select("key, value")
    .in("key", ["razorpay_enabled", "razorpay_key_id", "razorpay_key_secret"]);
  const rzp: Record<string, string> = {};
  (rzpSettings || []).forEach((s) => { rzp[s.key] = s.value; });
  if (rzp.razorpay_enabled !== "true" || !rzp.razorpay_key_id || !rzp.razorpay_key_secret) {
    return NextResponse.json({ error: "Razorpay is not configured" }, { status: 400 });
  }
  const auth = Buffer.from(`${rzp.razorpay_key_id}:${rzp.razorpay_key_secret}`).toString("base64");
  const headers = { Authorization: `Basic ${auth}` };

  const oldLinkId = invoice.razorpay_link_id as string | null;

  // ── Retire the old link ──────────────────────────────────────────────────
  if (oldLinkId) {
    let oldStatus: string;
    try {
      const res = await fetch(`https://api.razorpay.com/v1/payment_links/${oldLinkId}`, {
        headers,
        signal: AbortSignal.timeout(RAZORPAY_TIMEOUT_MS),
      });
      if (!res.ok) {
        return NextResponse.json({ error: "Could not check the existing payment link with Razorpay" }, { status: 502 });
      }
      oldStatus = (await res.json()).status as string;
    } catch (e) {
      console.error("[invoice renew-link] Razorpay fetch failed:", e);
      return NextResponse.json({ error: "Could not reach Razorpay to check the existing link" }, { status: 502 });
    }

    if (oldStatus === "paid" || oldStatus === "partially_paid") {
      return NextResponse.json(
        { error: "The existing payment link has already received a payment — record it instead of renewing" },
        { status: 409 },
      );
    }

    if (oldStatus === "created") {
      // Still live: it must be cancelled, or a payment could land on a link the
      // invoice no longer points at.
      try {
        const res = await fetch(`https://api.razorpay.com/v1/payment_links/${oldLinkId}/cancel`, {
          method: "POST",
          headers,
          signal: AbortSignal.timeout(RAZORPAY_TIMEOUT_MS),
        });
        if (!res.ok) {
          console.error("[invoice renew-link] Razorpay refused to cancel live link:", await res.text());
          return NextResponse.json({ error: "The existing link is still active and could not be cancelled" }, { status: 502 });
        }
      } catch (e) {
        console.error("[invoice renew-link] Razorpay cancel failed:", e);
        return NextResponse.json({ error: "The existing link is still active and could not be cancelled" }, { status: 502 });
      }
    }
    // expired / cancelled: nothing to retire.
  }

  // ── Who is being billed (prefills the Razorpay checkout) ──────────────────
  let party = null;
  if (invoice.case_id) {
    const { data: caseRow } = await supabase
      .from("cases")
      .select("client_name, client_company_name, client_email, client_phone, client_gst_number, aggregator_id, bill_to, aggregator:aggregators!cases_aggregator_id_fkey(name, billing_method, primary_email, primary_phone, gst_number)")
      .eq("id", invoice.case_id)
      .maybeSingle();
    if (caseRow) {
      // The create-time "bill the client" override isn't stored on the row, so
      // this prefills the case's default billing party. Harmless: the link is
      // created silent, and the customer details only prefill the checkout.
      party = invoiceParty({ case: caseRow as unknown as InvoiceCaseLike });
    }
  } else if (invoice.lead_id) {
    const { data: lead } = await supabase
      .from("leads")
      .select("first_name, last_name, company, email, phone, mobile")
      .eq("id", invoice.lead_id)
      .single();
    party = invoiceParty({ lead });
  }

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "https://twv-crm.vercel.app").trim();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payload: Record<string, any> = {
    amount: Math.round(totalAmount * 100),
    currency: "INR",
    description: `${invoice.invoice_number} — ${invoice.title} — The WorkVilla`,
    reference_id: `${invoice.invoice_number}-${Date.now()}`,
    expire_by: Math.floor(Date.now() / 1000) + RAZORPAY_MAX_LINK_VALIDITY_SECONDS,
    // Silent: the caller chooses when the customer hears about the new link.
    notify: { sms: false, email: false },
    reminder_enable: true,
    notes: {
      invoice_id: id,
      invoice_number: invoice.invoice_number,
      type: "adhoc_invoice",
      renewed: "true",
    },
    callback_url: `${appUrl}/invoices`,
    callback_method: "get",
  };
  if (party?.name || party?.email || party?.phone) {
    payload.customer = {};
    if (party.name) payload.customer.name = party.name;
    if (party.email) payload.customer.email = party.email;
    if (party.phone) payload.customer.contact = party.phone.replace(/\s/g, "");
  }

  let newLinkId: string;
  let newLinkUrl: string;
  try {
    const res = await fetch("https://api.razorpay.com/v1/payment_links", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(RAZORPAY_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error("[invoice renew-link] Razorpay link creation failed:", JSON.stringify(await res.json().catch(() => null)));
      return NextResponse.json({ error: "Razorpay could not create a new payment link" }, { status: 502 });
    }
    const linkData = await res.json();
    newLinkId = linkData.id;
    newLinkUrl = linkData.short_url;
  } catch (e) {
    console.error("[invoice renew-link] Razorpay error:", e);
    return NextResponse.json({ error: "Could not reach Razorpay to create a new link" }, { status: 502 });
  }

  // ── Point the invoice (and its AR mirror) at the new link ────────────────
  // Admin client for both writes so a role that can renew isn't blocked by RLS
  // halfway, leaving the invoice and its statement on different links.
  const { error: invErr } = await admin
    .from("proforma_invoices")
    .update({ razorpay_link_id: newLinkId, razorpay_link_url: newLinkUrl })
    .eq("id", id);
  if (invErr) {
    console.error("[invoice renew-link] Could not persist new link:", invErr.message);
    return NextResponse.json({ error: "New link was created but could not be saved — please retry" }, { status: 500 });
  }

  if (statement) {
    const { error: stmtErr } = await admin
      .from("billing_statements")
      .update({ razorpay_payment_link_id: newLinkId, razorpay_payment_link_url: newLinkUrl })
      .eq("id", statement.id);
    if (stmtErr) console.error("[invoice renew-link] Could not update mirrored statement:", stmtErr.message);
  }

  logAudit(supabase, {
    entityType: "invoice",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      trigger: { old: null, new: "renew_payment_link" },
      razorpay_link_id: { old: oldLinkId, new: newLinkId },
    },
  });

  return NextResponse.json({ ok: true, razorpay_link_id: newLinkId, razorpay_link_url: newLinkUrl });
}
