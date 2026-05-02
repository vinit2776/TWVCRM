import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

const VALID_TYPES = ["extended_time", "service", "food_beverage", "other"] as const;

/**
 * GET /api/bookings/[id]/addons
 * Returns all add-ons charged on this booking, oldest first.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("booking_addons")
    .select("*, added_by_user:users!booking_addons_added_by_fkey(id, full_name)")
    .eq("booking_id", id)
    .order("added_at", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data: data || [] });
}

/**
 * POST /api/bookings/[id]/addons
 * Body:
 *   { addon_catalog_id?, addon_type, description, quantity, unit_price, unit_label?,
 *     gst_rate?, notes? }
 *
 * If `addon_catalog_id` is provided, missing fields are filled from the catalog row
 * for consistency. The booking's running total is recomputed (base + sum of addons)
 * and updated atomically.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 401 });

  // Confirm booking exists and capture base totals (we don't mutate base; we
  // only refresh `total_amount_with_gst` to reflect charges added/removed).
  const { data: booking, error: bErr } = await supabase
    .from("bookings")
    .select("id, total_amount, gst_rate, gst_amount, total_amount_with_gst, status")
    .eq("id", id).single();
  if (bErr || !booking) return NextResponse.json({ error: "Booking not found" }, { status: 404 });

  const body = await request.json();
  const { quantity, notes } = body;
  let addon_type = body.addon_type;
  let description = body.description;
  let unit_price = body.unit_price;
  let unit_label = body.unit_label;
  let gst_rate = body.gst_rate;
  const addonCatalogId = body.addon_catalog_id as string | undefined;

  if (addonCatalogId) {
    const { data: catItem, error: cErr } = await supabase
      .from("addon_catalog").select("*").eq("id", addonCatalogId).single();
    if (cErr || !catItem) return NextResponse.json({ error: "Catalog item not found" }, { status: 404 });
    addon_type    = addon_type    ?? catItem.addon_type;
    description   = description   ?? catItem.name;
    unit_price    = unit_price    ?? catItem.unit_price;
    unit_label    = unit_label    ?? catItem.unit_label;
    gst_rate      = gst_rate      ?? catItem.gst_rate;
  }

  if (!addon_type || !VALID_TYPES.includes(addon_type)) {
    return NextResponse.json({ error: "Invalid addon_type" }, { status: 400 });
  }
  if (!description || typeof description !== "string" || !description.trim()) {
    return NextResponse.json({ error: "description is required" }, { status: 400 });
  }
  const qty = Number(quantity ?? 1);
  const price = Number(unit_price ?? 0);
  const gst = Number(gst_rate ?? 18);
  if (!isFinite(qty) || qty <= 0) return NextResponse.json({ error: "quantity must be > 0" }, { status: 400 });
  if (!isFinite(price) || price < 0) return NextResponse.json({ error: "unit_price must be >= 0" }, { status: 400 });

  const amount = parseFloat((qty * price).toFixed(2));
  const gstAmount = parseFloat((amount * gst / 100).toFixed(2));
  const totalWithGst = parseFloat((amount + gstAmount).toFixed(2));

  const { data: addon, error: insErr } = await supabase
    .from("booking_addons")
    .insert({
      booking_id: id,
      addon_catalog_id: addonCatalogId || null,
      addon_type,
      description: String(description).trim(),
      quantity: qty,
      unit_price: price,
      unit_label: unit_label || null,
      amount,
      gst_rate: gst,
      gst_amount: gstAmount,
      total_with_gst: totalWithGst,
      notes: notes || null,
      added_by: dbUser.id,
    })
    .select()
    .single();
  if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });

  await recomputeBookingTotal(supabase, id, booking);

  logAudit(supabase, {
    entityType: "booking_addon",
    entityId: addon.id,
    action: "create",
    performedBy: dbUser.id,
    changes: { record: { old: null, new: addon } },
  });

  return NextResponse.json({ data: addon }, { status: 201 });
}

/**
 * Recompute the booking's total_amount_with_gst as
 *   base_with_gst + Σ addon.total_with_gst
 * Stored on the booking so it can be displayed without an extra query.
 */
async function recomputeBookingTotal(
  supabase: Awaited<ReturnType<typeof createClient>>,
  bookingId: string,
  baseBooking: { total_amount: number; gst_amount: number; total_amount_with_gst: number },
) {
  const { data: addons } = await supabase
    .from("booking_addons")
    .select("amount, gst_amount, total_with_gst")
    .eq("booking_id", bookingId);

  const addonSum = (addons || []).reduce(
    (acc: { amount: number; gst: number; total: number }, r: { amount: number; gst_amount: number; total_with_gst: number }) => ({
      amount: acc.amount + Number(r.amount),
      gst: acc.gst + Number(r.gst_amount),
      total: acc.total + Number(r.total_with_gst),
    }),
    { amount: 0, gst: 0, total: 0 },
  );

  const baseAmount = Number(baseBooking.total_amount);
  const baseGst = Number(baseBooking.gst_amount);

  await supabase.from("bookings").update({
    total_amount_with_gst: parseFloat((baseAmount + baseGst + addonSum.total).toFixed(2)),
  }).eq("id", bookingId);
}
