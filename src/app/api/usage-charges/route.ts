import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createUsageChargeSchema } from "@/lib/validations";
import { logAudit } from "@/lib/audit";
import { isContractOperational, CHARGE_ALLOWED_ROLES } from "@/lib/constants";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const page = parseInt(searchParams.get("page") || "1");
  const limit = parseInt(searchParams.get("limit") || "25");
  const contractId = searchParams.get("contract_id");
  const bookingId = searchParams.get("booking_id");
  const leadId = searchParams.get("lead_id");
  const status = searchParams.get("status");
  const dateFrom = searchParams.get("date_from");
  const dateTo = searchParams.get("date_to");

  const offset = (page - 1) * limit;

  let query = supabase
    .from("usage_charges")
    .select(
      "*, contract:contracts!usage_charges_contract_id_fkey(id, contract_number, billing_cycle), booking:bookings!usage_charges_booking_id_fkey(id, booking_number, booking_date, lead_id, guest_name, guest_email), lead:leads!usage_charges_lead_id_fkey(id, first_name, last_name, company), waived_by_user:users!usage_charges_waived_by_fkey(id, full_name, role)",
      { count: "exact" }
    );

  if (contractId) query = query.eq("contract_id", contractId);
  if (bookingId) query = query.eq("booking_id", bookingId);
  if (leadId) query = query.eq("lead_id", leadId);
  if (status) query = query.eq("status", status);
  if (dateFrom) query = query.gte("charge_date", dateFrom);
  if (dateTo) query = query.lte("charge_date", dateTo);

  // charge_date is a DATE (no time component), so same-day charges tie on
  // it — Postgres gives no ordering guarantee for ties without a
  // tiebreaker. created_at is a real timestamp, so it breaks ties
  // chronologically instead of leaving same-day order undefined.
  query = query
    .order("charge_date", { ascending: false })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

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

  const body = await request.json();
  const result = createUsageChargeSchema.safeParse(body);
  if (!result.success) {
    return NextResponse.json({ error: "Validation failed", details: result.error.issues }, { status: 400 });
  }

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();

  if (!dbUser || !CHARGE_ALLOWED_ROLES.includes(dbUser.role)) {
    return NextResponse.json(
      { error: "You do not have permission to create usage charges" },
      { status: 403 }
    );
  }

  let leadId: string | null = null;

  // Derive the billing period from charge_date for lock/finalization checks
  const chargeDate = new Date(result.data.charge_date + "T00:00:00");
  const chargeMonth = chargeDate.getMonth() + 1;
  const chargeYear = chargeDate.getFullYear();
  const periodFirst = `${chargeYear}-${String(chargeMonth).padStart(2, "0")}-01`;
  const periodLast = `${chargeYear}-${String(chargeMonth).padStart(2, "0")}-${new Date(chargeYear, chargeMonth, 0).getDate()}`;
  const monthLabel = chargeDate.toLocaleString("en-IN", { month: "long", year: "numeric" });

  // Check if the accounting period is locked
  const { data: period } = await supabase
    .from("accounting_periods")
    .select("id, status")
    .eq("year", chargeYear)
    .eq("month", chargeMonth)
    .maybeSingle();

  if (period?.status === "locked") {
    return NextResponse.json(
      { error: `The ${monthLabel} billing period is locked. Charges cannot be added to a locked period.` },
      { status: 400 },
    );
  }

  // Will hold the contract's tax_percentage when creating a contract-based
  // charge — used below to override the client-supplied gst_rate so per-charge
  // GST always matches the statement-level rate.
  let contractTaxPercentage: number | null = null;
  let contractNumber: string | null = null;

  // Defaults to the client-supplied values; overwritten below when
  // contract_facility_id is set, since quota math is server-authoritative.
  //
  // The total is derived rather than trusted, for the same reason gst_amount is
  // below: a client that sends a total disagreeing with quantity x unit_price
  // leaves a line that cannot be read back. Booking TWV-B-0040 is the example —
  // three hours of conference room were billed correctly at Rs 2,400, but the
  // charge was stored as quantity 1 at Rs 800, so the line reads as Rs 800 while
  // charging Rs 2,400. Both dialogs already send quantity x unit_price, so this
  // changes nothing for them and only rejects the inconsistent case.
  let facilityQuantity  = result.data.quantity;
  let facilityUnitPrice = result.data.unit_price;
  let facilityTotal     = parseFloat((result.data.quantity * result.data.unit_price).toFixed(2));

  const claimedTotal = Number(result.data.total);
  if (Number.isFinite(claimedTotal) && Math.abs(claimedTotal - facilityTotal) > 0.01) {
    return NextResponse.json({
      error: `Charge does not add up: ${result.data.quantity} x ${result.data.unit_price} is ${facilityTotal.toLocaleString("en-IN")}, but the total says ${claimedTotal.toLocaleString("en-IN")}. Set the quantity to the units actually being billed.`,
    }, { status: 422 });
  }
  let facilityStatus    = "pending";

  if (result.data.contract_id) {
    // Contract-based charge — must exist and be active
    const { data: contract, error: contractError } = await supabase
      .from("contracts")
      .select("id, lead_id, status, end_date, tax_percentage, contract_number")
      .eq("id", result.data.contract_id)
      .single();

    if (contractError || !contract) {
      return NextResponse.json({ error: "Contract not found" }, { status: 404 });
    }
    if (!isContractOperational(contract)) {
      return NextResponse.json({ error: "Contract is not active" }, { status: 400 });
    }

    // Check if a finalized/exported statement already exists for this contract+period
    const { data: existingStatement } = await supabase
      .from("billing_statements")
      .select("id, status, statement_number")
      .eq("contract_id", result.data.contract_id)
      .gte("period_start", periodFirst)
      .lte("period_start", periodLast)
      .in("status", ["finalized", "exported"])
      .maybeSingle();

    if (existingStatement) {
      const monthLabel = chargeDate.toLocaleString("en-IN", { month: "long", year: "numeric" });
      return NextResponse.json(
        { error: `The ${monthLabel} bill (${existingStatement.statement_number}) is already finalized. Charges cannot be added to a finalized bill.` },
        { status: 400 },
      );
    }

    leadId = contract.lead_id;
    contractTaxPercentage = contract.tax_percentage != null ? Number(contract.tax_percentage) : null;
    contractNumber = contract.contract_number ?? null;

    // ── Facility-linked charge: quota is authoritative server-side ──────────
    // The client may pre-fill/override description + rate from the facility's
    // config, but quantity/total are always recomputed here against
    // free_quota + prior consumption this month — mirrors the booking-side
    // quota logic in /api/bookings (contractFacilityForQuota).
    if (result.data.contract_facility_id) {
      const { data: facility, error: facilityError } = await supabase
        .from("contract_facilities")
        .select("id, contract_id, name, free_quota, cost_per_unit, is_active")
        .eq("id", result.data.contract_facility_id)
        .eq("contract_id", result.data.contract_id)
        .single();

      if (facilityError || !facility) {
        return NextResponse.json({ error: "Facility not found on this contract" }, { status: 404 });
      }

      const { data: existingCharges } = await supabase
        .from("usage_charges")
        .select("quantity")
        .eq("contract_facility_id", facility.id)
        .is("billing_statement_id", null)
        .in("status", ["pending", "waived"])
        .gte("charge_date", periodFirst)
        .lte("charge_date", periodLast);

      const consumed = (existingCharges || []).reduce((sum, c) => sum + Number(c.quantity || 0), 0);
      const freeRemaining = Math.max(0, Number(facility.free_quota) - consumed);
      const requestedQty = Number(result.data.quantity);
      const overageQty = Math.max(0, requestedQty - freeRemaining);
      const rate = Number(result.data.unit_price);

      if (overageQty > 0) {
        facilityQuantity = overageQty;
        facilityUnitPrice = rate;
        facilityTotal = parseFloat((overageQty * rate).toFixed(2));
        facilityStatus = "pending";
      } else {
        facilityQuantity = requestedQty;
        facilityUnitPrice = 0;
        facilityTotal = 0;
        facilityStatus = "waived";
      }
    }
  } else if (result.data.booking_id) {
    // Booking-based charge — booking must exist
    const { data: booking, error: bookingError } = await supabase
      .from("bookings")
      .select("id, lead_id, status")
      .eq("id", result.data.booking_id)
      .single();

    if (bookingError || !booking) {
      return NextResponse.json({ error: "Booking not found" }, { status: 404 });
    }
    leadId = booking.lead_id ?? null;
  }

  // GST: server is the source of truth for the computed fields.
  // For contract-based charges, force gst_rate to match the contract's
  // tax_percentage so every line item on the billing statement uses the
  // same rate. This prevents the mismatch where a charge is stored at 5%
  // but the statement-level total applies 18%. For non-contract charges
  // (booking-based), the client-supplied rate (default 18%) is used.
  const gstRate = contractTaxPercentage ?? result.data.gst_rate ?? 18;
  const subtotal = facilityTotal;
  const gstAmount = parseFloat((subtotal * gstRate / 100).toFixed(2));
  const totalWithGst = parseFloat((subtotal + gstAmount).toFixed(2));

  const { data, error } = await supabase
    .from("usage_charges")
    .insert({
      contract_id: result.data.contract_id ?? null,
      booking_id: result.data.booking_id ?? null,
      contract_facility_id: result.data.contract_facility_id ?? null,
      description: result.data.description,
      quantity: facilityQuantity,
      unit_price: facilityUnitPrice,
      total: subtotal,
      gst_rate: gstRate,
      gst_amount: gstAmount,
      total_with_gst: totalWithGst,
      charge_date: result.data.charge_date,
      hsn_sac_code: result.data.hsn_sac_code || "999799",
      notes: result.data.notes,
      proof_path: body.proof_path || null,
      lead_id: leadId,
      status: facilityStatus,
      created_by: dbUser?.id,
    })
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (data && dbUser?.id) {
    logAudit(supabase, {
      entityType: "usage_charge",
      entityId: data.id,
      action: "create",
      performedBy: dbUser.id,
      changes: { record: { old: null, new: data } },
    });
  }

  const chargeRef = contractNumber ? `contract ${contractNumber}` : "the booking";
  const amountLine = `Qty ${facilityQuantity} × ₹${facilityUnitPrice} = ₹${subtotal}${gstAmount > 0 ? ` + ₹${gstAmount} GST = ₹${totalWithGst}` : ""}`;

  const postInsertTasks: PromiseLike<unknown>[] = [];

  // Surface every ad-hoc charge on the customer's Activities timeline (not
  // just the admin-only audit log) so staff reviewing a lead/contract can
  // see it without digging into Billing.
  if (data && leadId && dbUser?.id) {
    postInsertTasks.push(
      supabase.from("activities").insert({
        lead_id: leadId,
        type: "note",
        subject: `Charge added — ₹${totalWithGst}`,
        description: `${result.data.description} (${amountLine}) on ${chargeRef}. Will be billed in the ${monthLabel} cycle.`,
        created_by: dbUser.id,
      }).then(({ error: activityError }) => {
        if (activityError) console.error("[usage-charge activity]", activityError.message);
      })
    );
  }

  // Optional customer notification — staff explicitly opts in per charge.
  // WhatsApp/SMS aren't available here: this app only sends pre-approved
  // MSG91 templates and none exists for an ad-hoc charge notice, so email
  // is the only channel wired up today.
  if (data && leadId && body.notify_customer === true) {
    postInsertTasks.push(
      (async () => {
        const { data: leadRow } = await supabase
          .from("leads")
          .select("email, billing_emails, first_name, last_name, company")
          .eq("id", leadId)
          .single();

        const recipients = Array.from(
          new Set([leadRow?.email, ...((leadRow?.billing_emails as string[] | null) ?? [])].filter(Boolean))
        ) as string[];

        if (recipients.length === 0) {
          console.error("[usage-charge notify] no email on file for lead", leadId);
          return;
        }

        const customerName = leadRow?.company || `${leadRow?.first_name ?? ""} ${leadRow?.last_name ?? ""}`.trim() || "there";

        const html = `
          <p>Hi ${customerName},</p>
          <p>A new charge has been added to your account on ${chargeRef}:</p>
          <table style="border-collapse:collapse;margin:12px 0">
            <tr><td style="padding:4px 12px 4px 0;color:#666">Description</td><td>${result.data.description}</td></tr>
            <tr><td style="padding:4px 12px 4px 0;color:#666">Amount</td><td>${amountLine}</td></tr>
            <tr><td style="padding:4px 12px 4px 0;color:#666">Date</td><td>${result.data.charge_date}</td></tr>
          </table>
          <p>This will be billed at the end of the ${monthLabel} billing cycle along with your regular statement.</p>
          <p style="font-size:12px;color:#888">If you believe this charge was made in error, please reply to this email or contact us within 24 hours so we can review it before it's billed.</p>
        `;

        try {
          const sendResult = await resend.emails.send({
            from: EMAIL_FROM,
            to: recipients,
            replyTo: EMAIL_REPLY_TO,
            subject: `New charge added — ${chargeRef}`,
            html,
          });
          if (sendResult.error) {
            console.error("[usage-charge notify] send failed", sendResult.error.message);
          }
        } catch (sendErr) {
          console.error("[usage-charge notify] send threw", sendErr instanceof Error ? sendErr.message : sendErr);
        }
      })()
    );
  }

  await Promise.all(postInsertTasks);

  return NextResponse.json({ data }, { status: 201 });
}
