import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";

/** Normalise a phone number: strip spaces, dashes, dots; keep leading + */
function normalisePhone(raw: string): string {
  return raw.replace(/[\s\-.()\[\]]/g, "").trim();
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
    hp_field, // honeypot — bots fill this, humans don't
    source: rawSource,
  } = body;

  // Whitelist allowed sources; default to google_ads
  const ALLOWED_SOURCES = ["google_ads", "meta_ads"] as const;
  type AllowedSource = (typeof ALLOWED_SOURCES)[number];
  const source: AllowedSource = ALLOWED_SOURCES.includes(rawSource) ? rawSource : "google_ads";
  const sourceLabel = source === "meta_ads" ? "Meta Ads" : "Google Ads";
  const sourceTag = source === "meta_ads" ? "meta-ads-form" : "google-ads-form";

  // Honeypot check — silently succeed without touching DB
  if (hp_field) {
    return NextResponse.json({ success: true });
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

  if (existing) {
    // Returning enquiry — add a note activity to the existing lead
    const enquirySummary = [
      `Name: ${name}`,
      `Mobile: ${mobile}`,
      normalisedEmail ? `Email: ${normalisedEmail}` : null,
      company ? `Company: ${company}` : null,
      workspace_type ? `Looking for: ${workspace_type}` : null,
      seat_capacity ? `Seats: ${seat_capacity}` : null,
      budget_per_seat ? `Budget/seat: ₹${budget_per_seat}` : null,
      preferred_location ? `Preferred location: ${preferred_location}` : null,
      working_hours ? `Working hours: ${working_hours}` : null,
      description ? `Requirement: ${description}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    await supabase.from("activities").insert({
      lead_id: existing.id,
      type: "note",
      subject: `Re-enquiry via ${sourceLabel} form`,
      description: enquirySummary,
    });

    return NextResponse.json({ success: true, returning: true });
  }

  // New lead — create with the resolved source
  const { error: insertError } = await supabase.from("leads").insert({
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
    description: description?.trim() || null,
    source,
    status: "new",
    rating: "none",
    score: 0,
    tags: [sourceTag],
  });

  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, returning: false });
}
