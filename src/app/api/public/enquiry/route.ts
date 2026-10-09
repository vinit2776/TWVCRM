import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { resend, EMAIL_FROM } from "@/lib/mailer";
import { sendPushToAll } from "@/lib/push";
import { messaging } from "@/lib/whatsapp";
import { sanitiseAttribution } from "@/lib/public-forms/attribution";
import { verifyTurnstile } from "@/lib/public-forms/turnstile";

/** Normalise a phone number to a canonical 10-digit Indian mobile number.
 *  Strips all non-digit characters, then removes a leading country code
 *  (+91 / 91) or STD zero if present, so both "9876543210" and
 *  "+91 98765 43210" normalise to the same "9876543210".
 */
function normalisePhone(raw: string): string {
  let digits = raw.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0"))  digits = digits.slice(1);
  return digits;
}

const ALLOWED_SOURCES = ["google_ads", "meta_ads", "direct_walkin"] as const;
type AllowedSource = (typeof ALLOWED_SOURCES)[number];

const SOURCE_META: Record<AllowedSource, { label: string; tag: string }> = {
  google_ads:    { label: "Google Ads",     tag: "google-ads-form" },
  meta_ads:      { label: "Meta Ads",       tag: "meta-ads-form"   },
  direct_walkin: { label: "Direct Walk-in", tag: "walkin-form"     },
};

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://twv-crm.vercel.app";

type AdminClient = Awaited<ReturnType<typeof createAdminClient>>;

/** Records this submission as an enquiry and returns its reference (TWV-E-0001).
 *  The reference is minted by the database. A failure here must never lose the customer's
 *  enquiry, so it is logged (no PII) and the submission carries on without a reference. */
async function recordEnquiry(
  supabase: AdminClient,
  args: { leadId: string; source: AllowedSource; isReEnquiry: boolean; payload: Record<string, unknown> }
): Promise<string | null> {
  const { data, error } = await supabase
    .from("lead_enquiries")
    .insert({
      lead_id: args.leadId,
      source: args.source,
      is_re_enquiry: args.isReEnquiry,
      payload: args.payload,
    })
    .select("reference")
    .single();
  if (error) {
    console.error("[public/enquiry] could not record enquiry:", error.message);
    return null;
  }
  return data.reference as string;
}

interface EnquiryEmailParams {
  isReturning: boolean;
  leadId: string;
  reference: string | null;
  firstName: string;
  lastName: string;
  sourceLabel: string;
  mobile: string;
  email: string | null;
  company?: string;
  workspace_type?: string;
  seat_capacity?: string;
  budget_per_seat?: string;
  preferred_location?: string;
  working_hours?: string;
  conference_room_location?: string;
  start_date?: string;
  description?: string;
}

function row(label: string, value: string | undefined | null) {
  if (!value) return "";
  return `
    <tr>
      <td style="padding:6px 12px;background:#f9fafb;font-size:13px;color:#6b7280;white-space:nowrap;width:160px;">${label}</td>
      <td style="padding:6px 12px;font-size:13px;color:#111827;">${value}</td>
    </tr>`;
}

function buildEnquiryEmailHtml(p: EnquiryEmailParams): string {
  const badge = p.isReturning
    ? `<span style="background:#fef3c7;color:#92400e;font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;display:inline-block;margin-left:8px;">Re-Enquiry</span>`
    : `<span style="background:#d1fae5;color:#065f46;font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;display:inline-block;margin-left:8px;">New Lead</span>`;

  const crmUrl = `${APP_URL}/leads/${p.leadId}`;

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08);">

        <!-- Header -->
        <tr>
          <td style="background:#015E65;padding:24px 28px;">
            <p style="margin:0;font-size:18px;font-weight:700;color:#fff;">
              Enquiry Received ${badge}
            </p>
            <p style="margin:6px 0 0;font-size:13px;color:#7fd8c2;">
              via ${p.sourceLabel} form
            </p>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:24px 28px;">
            <p style="margin:0 0 16px;font-size:14px;color:#374151;">
              ${p.isReturning
                ? `An <strong>existing contact</strong> has re-submitted an enquiry.`
                : `A <strong>new enquiry</strong> has been received.`}
            </p>

            <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
              ${row("Reference",              p.reference ?? undefined)}
              ${row("Name",                   `${p.firstName} ${p.lastName}`)}
              ${row("Mobile",                 p.mobile)}
              ${row("Email",                  p.email || undefined)}
              ${row("Company",                p.company)}
              ${row("Looking for",            p.workspace_type?.replace(/_/g, " "))}
              ${row("Conference room",        p.conference_room_location)}
              ${row("Seats",                  p.seat_capacity)}
              ${row("Budget / seat",          p.budget_per_seat ? `₹${p.budget_per_seat}` : undefined)}
              ${row("Preferred location",     p.preferred_location)}
              ${row("Start date",             p.start_date)}
              ${row("Working hours",          p.working_hours)}
              ${row("Requirement",            p.description)}
            </table>

            <!-- CRM link -->
            <div style="margin-top:24px;text-align:center;">
              <a href="${crmUrl}"
                 style="display:inline-block;background:#015E65;color:#fff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 28px;border-radius:8px;">
                View in CRM →
              </a>
            </div>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="padding:16px 28px;border-top:1px solid #f3f4f6;text-align:center;">
            <p style="margin:0;font-size:11px;color:#9ca3af;">
              The WorkVilla · Prakash Presidium, 110 MG Road, Nungambakkam, Chennai 600034
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export async function POST(request: NextRequest) {
  const body = await request.json();

  const {
    name,
    mobile,
    email,
    company,
    workspace_type,
    seat_capacity,
    budget_per_seat,
    preferred_location,
    working_hours,
    description,
    start_date,               // walk-in specific
    conference_room_location, // walk-in specific (when workspace_type = conference_room)
    hp_field,                 // honeypot — bots fill this, humans don't
    attribution: rawAttribution, // ad / campaign the visitor came from (untrusted)
    turnstile_token,          // Cloudflare Turnstile token (optional until configured)
    source: rawSource,
  } = body;

  // Resolve source — whitelist only; default to google_ads
  const source: AllowedSource = ALLOWED_SOURCES.includes(rawSource as AllowedSource)
    ? (rawSource as AllowedSource)
    : "google_ads";
  const { label: sourceLabel, tag: sourceTag } = SOURCE_META[source];

  // Honeypot check — silently succeed without touching DB
  if (hp_field) {
    return NextResponse.json({ success: true });
  }

  // Bot check. Fails open: only an explicit "invalid token" from Cloudflare rejects, so a
  // missing token / Cloudflare outage never costs us a real customer's enquiry.
  const captcha = await verifyTurnstile(
    turnstile_token,
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
  );
  if (captcha === "failed") {
    return NextResponse.json(
      { error: "We couldn't verify your submission. Please refresh the page and try again." },
      { status: 400 }
    );
  }

  // Basic validation
  if (!name || typeof name !== "string" || !name.trim()) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }
  if (!mobile || typeof mobile !== "string" || !mobile.trim()) {
    return NextResponse.json({ error: "Mobile number is required" }, { status: 400 });
  }

  // Split full name into first + last
  const nameParts = name.trim().split(/\s+/);
  const firstName = nameParts[0];
  const lastName = nameParts.length > 1 ? nameParts.slice(1).join(" ") : "-";

  const normalisedMobile = normalisePhone(mobile);

  // Validate: must be a 10-digit Indian mobile number (starts with 6–9)
  if (!/^[6-9]\d{9}$/.test(normalisedMobile)) {
    return NextResponse.json(
      { error: "Please enter a valid 10-digit mobile number." },
      { status: 400 }
    );
  }

  const normalisedEmail = email ? email.trim().toLowerCase() : null;

  const supabase = await createAdminClient();

  // Dedup: check if phone OR email already exists in leads
  let dupQuery = supabase
    .from("leads")
    .select("id")
    .or(`phone.eq.${normalisedMobile},mobile.eq.${normalisedMobile}`);

  if (normalisedEmail) {
    dupQuery = supabase
      .from("leads")
      .select("id")
      .or(
        `phone.eq.${normalisedMobile},mobile.eq.${normalisedMobile},email.eq.${normalisedEmail}`
      );
  }

  const { data: existing } = await dupQuery.limit(1).maybeSingle();

  // Build a human-readable summary of the submission
  const enquirySummary = [
    `Name: ${name}`,
    `Mobile: ${mobile}`,
    normalisedEmail               ? `Email: ${normalisedEmail}`                         : null,
    company                       ? `Company: ${company}`                               : null,
    workspace_type                ? `Looking for: ${workspace_type}`                    : null,
    conference_room_location      ? `Conference room: ${conference_room_location}`      : null,
    seat_capacity                 ? `Seats: ${seat_capacity}`                           : null,
    budget_per_seat               ? `Budget/seat: ₹${budget_per_seat}`                  : null,
    preferred_location            ? `Preferred location: ${preferred_location}`         : null,
    start_date                    ? `Start date: ${start_date}`                         : null,
    working_hours                 ? `Working hours: ${working_hours}`                   : null,
    description                   ? `Requirement: ${description}`                       : null,
  ]
    .filter(Boolean)
    .join("\n");

  // Exactly what the customer submitted, kept on the enquiry row.
  const submittedPayload: Record<string, unknown> = Object.fromEntries(
    Object.entries({
      name: name.trim(),
      mobile: normalisedMobile,
      email: normalisedEmail,
      company: company?.trim(),
      workspace_type,
      seat_capacity,
      budget_per_seat,
      preferred_location,
      working_hours,
      conference_room_location,
      start_date,
      description: description?.trim(),
    }).filter(([, v]) => v !== undefined && v !== null && v !== "")
  );

  // Where the visitor came from. Stored beside the form fields but never mixed into them.
  const attribution = sanitiseAttribution(rawAttribution);
  if (Object.keys(attribution).length > 0) submittedPayload.attribution = attribution;
  // Visible in the data when the bot check was on but the browser sent no token.
  if (captcha === "missing") submittedPayload.captcha = "missing";

  const emailParams: Omit<EnquiryEmailParams, "isReturning" | "leadId" | "reference"> = {
    firstName, lastName, sourceLabel,
    mobile: normalisedMobile,
    email: normalisedEmail,
    company, workspace_type, seat_capacity, budget_per_seat,
    preferred_location, working_hours, conference_room_location,
    start_date, description,
  };

  // Resolve all active admin/manager email addresses to notify
  const { data: staffRows } = await supabase
    .from("users")
    .select("email")
    .in("role", ["admin", "manager"])
    .eq("is_active", true);

  const staffEmails = (staffRows ?? [])
    .map((u: { email: string }) => u.email)
    .filter(Boolean) as string[];

  // Always include the shared inbox; deduplicate
  const ALL_RECIPIENTS = Array.from(
    new Set(["space@theworkvilla.com", ...staffEmails])
  );

  // WhatsApp alert — only for Google Ads / Meta Ads enquiries, to sales reps + managers
  const shouldSendWhatsApp = source === "google_ads" || source === "meta_ads";
  let salesPhones: string[] = [];
  if (shouldSendWhatsApp) {
    const { data: salesRows } = await supabase
      .from("users")
      .select("phone")
      .in("role", ["sales_rep", "manager"])
      .eq("is_active", true)
      .not("phone", "is", null)
      .neq("phone", "");

    salesPhones = (salesRows ?? [])
      .map((u: { phone: string }) => u.phone)
      .filter(Boolean);
  }

  if (existing) {
    const reference = await recordEnquiry(supabase, {
      leadId: existing.id,
      source,
      isReEnquiry: true,
      payload: submittedPayload,
    });

    // Returning enquiry — add a note activity to the existing lead
    await supabase.from("activities").insert({
      lead_id: existing.id,
      type: "note",
      subject: `Re-enquiry via ${sourceLabel} form`,
      description: reference ? `Reference: ${reference}\n${enquirySummary}` : enquirySummary,
    });

    // Re-open the attention window: clear any prior claim/resolve so the
    // dashboard surfaces this lead again, and bump the overdue timer.
    await supabase
      .from("leads")
      .update({
        claimed_by: null,
        claimed_at: null,
        resolved_at: null,
        resolved_by: null,
        resolution_outcome: null,
        attention_reset_at: new Date().toISOString(),
      })
      .eq("id", existing.id);

    // Fire-and-forget email + push alert — must not block the response
    resend.emails.send({
      from: EMAIL_FROM,
      to: ALL_RECIPIENTS,
      subject: `🔁 Re-Enquiry${reference ? ` ${reference}` : ""} — ${firstName} ${lastName} via ${sourceLabel}`,
      html: buildEnquiryEmailHtml({ ...emailParams, isReturning: true, leadId: existing.id, reference }),
      replyTo: normalisedEmail || undefined,
    }).catch(() => {});

    sendPushToAll({
      title: `🔁 Re-Enquiry — ${firstName} ${lastName}`,
      body: `Enquiring again via ${sourceLabel}${reference ? ` · ${reference}` : ""}`,
      url: `${APP_URL}/leads/${existing.id}`,
      tag: `re-enquiry-${existing.id}`,
    }).catch(() => {});

    salesPhones.forEach((phone) => {
      messaging
        .internalNewLead(phone, `${firstName} ${lastName}`, company || "—", sourceLabel, existing.id)
        .catch(() => {});
    });

    return NextResponse.json({ success: true, returning: true, reference });
  }

  // Build the description field: combine free-text with structured extra fields
  const extraDetails = [
    conference_room_location ? `Conference room: ${conference_room_location}` : null,
    start_date               ? `Start date: ${start_date}`                    : null,
  ]
    .filter(Boolean)
    .join("\n");

  const fullDescription = [description?.trim(), extraDetails]
    .filter(Boolean)
    .join("\n")
    || null;

  // New lead — create with the resolved source, select id back for email link
  const { data: newLead, error: insertError } = await supabase.from("leads").insert({
    first_name: firstName,
    last_name: lastName,
    company: company?.trim() || null,
    mobile: normalisedMobile,
    email: normalisedEmail || null,
    workspace_type: workspace_type || null,
    seat_capacity: seat_capacity ? parseInt(seat_capacity, 10) : null,
    budget_per_seat: budget_per_seat ? parseFloat(budget_per_seat) : null,
    preferred_location: preferred_location?.trim() || null,
    working_hours: working_hours?.trim() || null,
    description: fullDescription,
    source,
    status: "new",
    rating: "none",
    score: 0,
    tags: [sourceTag],
  }).select("id").single();

  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  const reference = await recordEnquiry(supabase, {
    leadId: newLead.id,
    source,
    isReEnquiry: false,
    payload: submittedPayload,
  });

  // Fire-and-forget email + push alert — must not block the response
  resend.emails.send({
    from: EMAIL_FROM,
    to: ALL_RECIPIENTS,
    subject: `🔔 New Enquiry${reference ? ` ${reference}` : ""} — ${firstName} ${lastName} via ${sourceLabel}`,
    html: buildEnquiryEmailHtml({ ...emailParams, isReturning: false, leadId: newLead.id, reference }),
    replyTo: normalisedEmail || undefined,
  }).catch(() => {});

  sendPushToAll({
    title: `🔔 New Enquiry — ${firstName} ${lastName}`,
    body: `New enquiry via ${sourceLabel}${reference ? ` · ${reference}` : ""}`,
    url: `${APP_URL}/leads/${newLead.id}`,
    tag: `new-enquiry-${newLead.id}`,
  }).catch(() => {});

  salesPhones.forEach((phone) => {
    messaging
      .internalNewLead(phone, `${firstName} ${lastName}`, company || "—", sourceLabel, newLead.id)
      .catch(() => {});
  });

  return NextResponse.json({ success: true, returning: false, reference });
}
