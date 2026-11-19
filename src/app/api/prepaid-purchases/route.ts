import { RAZORPAY_MAX_LINK_VALIDITY_SECONDS } from "@/lib/constants";
import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { addDaysToDate, istDateString } from "@/lib/prepaid";

// GET — list purchases (optionally filtered)
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const leadId = searchParams.get("lead_id");
  const companyName = searchParams.get("company_name");
  const status = searchParams.get("status");
  const locationId = searchParams.get("location_id");

  let query = supabase
    .from("prepaid_purchases")
    .select(`
      *,
      package:prepaid_packages(id,name,credit_type,total_credits,workspace_type,validity_days,price),
      lead:leads(id,first_name,last_name,company,phone,email),
      location:locations(id,name),
      locations:prepaid_purchase_locations(location:locations(id,name)),
      redemptions:prepaid_redemptions(id,credits_deducted,booking_id,redeemed_at)
    `)
    .order("created_at", { ascending: false });

  if (leadId) query = query.eq("lead_id", leadId);
  if (companyName) query = query.ilike("company_name", `%${companyName}%`);
  if (status) query = query.eq("status", status);
  if (locationId) query = query.eq("location_id", locationId);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Compute credits_remaining and refresh expired/exhausted status
  const enriched = (data || []).map((p) => {
    const creditsRemaining = Number(p.total_credits) - Number(p.credits_used);
    let computedStatus = p.status;
    if (computedStatus === "active") {
      if (creditsRemaining <= 0) computedStatus = "exhausted";
      else if (new Date(p.expires_at) < new Date()) computedStatus = "expired";
    }
    return { ...p, credits_remaining: Math.max(0, creditsRemaining), status: computedStatus };
  });

  return NextResponse.json({ data: enriched });
}

// POST — sell a package to a customer
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const {
    package_id,
    lead_id,
    company_name,
    payment_mode,
    payment_reference,
    notes,
    notify_sms,
    notify_email,
    location_ids,
    validity_days,
    cancellation_window_hours,
  } = body;

  if (!package_id) return NextResponse.json({ error: "package_id is required" }, { status: 400 });
  if (!payment_mode) return NextResponse.json({ error: "payment_mode is required" }, { status: 400 });
  if (!lead_id && !company_name) {
    return NextResponse.json({ error: "Either lead_id or company_name is required" }, { status: 400 });
  }

  const locationIds: string[] = Array.isArray(location_ids) ? [...new Set(location_ids.filter((l: unknown): l is string => typeof l === "string" && l !== ""))] : [];
  if (locationIds.length === 0) {
    return NextResponse.json({ error: "Choose at least one location this package can be redeemed at" }, { status: 400 });
  }
  if (validity_days !== undefined && (!Number.isInteger(Number(validity_days)) || Number(validity_days) < 1 || Number(validity_days) > 3650)) {
    return NextResponse.json({ error: "validity_days must be a whole number of days, 1 or more" }, { status: 400 });
  }
  if (cancellation_window_hours != null && !(Number(cancellation_window_hours) >= 0)) {
    return NextResponse.json({ error: "cancellation_window_hours must be 0 or more, or empty for no restores" }, { status: 400 });
  }

  // Fetch package template to copy credit details
  const { data: pkg, error: pkgErr } = await supabase
    .from("prepaid_packages")
    .select("*")
    .eq("id", package_id)
    .eq("is_active", true)
    .single();

  if (pkgErr || !pkg) return NextResponse.json({ error: "Package not found or inactive" }, { status: 404 });

  // Expiry: purchase date (IST) + validity, 30 days unless the sale says otherwise
  const validityDays = validity_days !== undefined ? Number(validity_days) : Number(pkg.validity_days) || 30;
  const expiresAtStr = addDaysToDate(istDateString(), validityDays);

  // Cancellation window: the package default unless this sale negotiated another.
  // undefined = use the default, null = this sale never restores credits.
  const windowHours: number | null =
    cancellation_window_hours === undefined
      ? (pkg.default_cancellation_window_hours == null ? null : Number(pkg.default_cancellation_window_hours))
      : cancellation_window_hours === null ? null : Number(cancellation_window_hours);

  // payment_link mode: purchase starts as pending_payment; others are immediately paid
  const paymentStatus = payment_mode === "payment_link" ? "pending_payment" : "paid";

  const { data, error } = await supabase
    .from("prepaid_purchases")
    .insert({
      package_id,
      location_id: locationIds.length === 1 ? locationIds[0] : null,
      lead_id: lead_id || null,
      company_name: company_name?.trim() || null,
      credit_type: pkg.credit_type,
      total_credits: pkg.total_credits,
      credits_used: 0,
      price_paid: pkg.price,
      payment_mode,
      payment_status: paymentStatus,
      payment_reference: payment_reference?.trim() || null,
      expires_at: expiresAtStr,
      cancellation_window_hours: windowHours,
      status: "active",
      notes: notes?.trim() || null,
      sold_by: user.id,
    })
    .select(`
      *,
      package:prepaid_packages(id,name,credit_type,total_credits,workspace_type),
      lead:leads(id,first_name,last_name,company,phone,email),
      location:locations(id,name)
    `)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const { error: locErr } = await supabase
    .from("prepaid_purchase_locations")
    .insert(locationIds.map((l) => ({ purchase_id: data.id, location_id: l })));
  if (locErr) {
    // A package with no locations would read as valid everywhere, so undo the sale.
    await createAdminClient().from("prepaid_purchases").delete().eq("id", data.id);
    return NextResponse.json({ error: "Could not save the package locations: " + locErr.message }, { status: 500 });
  }

  const creditsRemaining = Number(data.total_credits) - Number(data.credits_used);
  const result: Record<string, unknown> = { ...data, credits_remaining: creditsRemaining };

  // For payment_link mode: create a Razorpay payment link
  if (payment_mode === "payment_link") {
    try {
      const adminSupabase = await createAdminClient();
      const { data: settings } = await adminSupabase
        .from("app_settings")
        .select("key, value")
        .in("key", ["razorpay_key_id", "razorpay_key_secret", "razorpay_enabled"]);

      const creds: Record<string, string> = {};
      (settings || []).forEach((s: { key: string; value: string }) => { creds[s.key] = s.value; });

      if (creds.razorpay_enabled === "true" && creds.razorpay_key_id && creds.razorpay_key_secret) {
        const auth = Buffer.from(`${creds.razorpay_key_id}:${creds.razorpay_key_secret}`).toString("base64");
        const amountInPaise = Math.round(Number(pkg.price) * 100);
        const expireBy = Math.floor(Date.now() / 1000) + RAZORPAY_MAX_LINK_VALIDITY_SECONDS;

        // Resolve lead contact details for notification
        const lead = data.lead as Record<string, unknown> | null;
        const customerName = lead?.first_name ? `${lead.first_name} ${lead.last_name}` : company_name || undefined;
        const customerEmail = (lead?.email as string) || undefined;
        const rawPhone = (lead?.phone as string) || undefined;
        const customerPhone = (() => {
          if (!rawPhone) return undefined;
          let phone = String(rawPhone).replace(/[\s-]/g, "");
          if (phone.startsWith("+")) phone = phone.substring(1);
          if (!phone.startsWith("91") && phone.length === 10) phone = "91" + phone;
          return "+" + phone;
        })();

        const rzpPayload: Record<string, unknown> = {
          amount: amountInPaise,
          currency: "INR",
          description: `Package: ${pkg.name} — The WorkVilla`,
          reference_id: data.id,
          expire_by: expireBy,
          notify: {
            sms: notify_sms === true && !!customerPhone,
            email: notify_email === true && !!customerEmail,
          },
          reminder_enable: true,
          notes: {
            purchase_id: data.id,
            package_name: pkg.name,
          },
        };

        if (customerName || customerEmail || customerPhone) {
          rzpPayload.customer = {
            ...(customerName ? { name: customerName } : {}),
            ...(customerEmail ? { email: customerEmail } : {}),
            ...(customerPhone ? { contact: customerPhone } : {}),
          };
        }

        const rzpRes = await fetch("https://api.razorpay.com/v1/payment_links", {
          method: "POST",
          headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
          body: JSON.stringify(rzpPayload),
        });

        if (rzpRes.ok) {
          const linkData = await rzpRes.json();
          await supabase
            .from("prepaid_purchases")
            .update({
              razorpay_payment_link_id: linkData.id,
              razorpay_payment_link_url: linkData.short_url,
            })
            .eq("id", data.id);
          result.razorpay_payment_link_id = linkData.id;
          result.razorpay_payment_link_url = linkData.short_url;
          result.payment_link_url = linkData.short_url;
        } else {
          const rzpErr = await rzpRes.json().catch(() => null);
          console.error("Razorpay payment link error:", rzpErr);
          // Non-fatal: purchase is already created; return without link
        }
      }
    } catch (e) {
      console.error("Failed to create Razorpay link for purchase:", e);
      // Non-fatal
    }
  }

  return NextResponse.json({ data: result }, { status: 201 });
}
