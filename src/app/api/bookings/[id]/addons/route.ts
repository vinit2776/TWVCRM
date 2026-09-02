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
    .select("id, total_amount, gst_rate, gst_amount, total_amount_with_gst, status, payment_status")
    .eq("id", id).single();
  if (bErr || !booking) return NextResponse.json({ error: "Booking not found" }, { status: 404 });

  // Lock add-ons under the same rules as the rate edit. Adding charges
  // after the customer has paid creates a balance due that the receipt
  // doesn't reflect; same shape mismatch as silently changing the rate.
  if (["cancelled", "checked_out", "no_show"].includes(booking.status)) {
    return NextResponse.json(
      { error: `Cannot add charges to a ${booking.status} booking` },
      { status: 400 }
    );
  }
  if (booking.payment_status === "paid") {
    return NextResponse.json(
      { error: "Cannot add charges — payment has already been collected. Use 'Add Charge' on the booking detail page to record a post-checkout charge." },
      { status: 400 }
    );
  }
  // Defence in depth — payment_status can be stale; verified booking_payments
  // is the truth.
  const { data: paidPayments } = await supabase
    .from("booking_payments")
    .select("id")
    .eq("booking_id", id)
    .eq("status", "verified")
    .limit(1);
  if (paidPayments && paidPayments.length > 0) {
    return NextResponse.json(
      { error: "Cannot add charges — verified payments exist for this booking" },
      { status: 400 }
    );
  }

  const body = await request.json();

  // Accept either a single item (legacy callers) or `{ items: [...] }` (new
  // mobile-friendly cart UX that lets staff add several extras in one shot).
  // We normalise both into a `rawItems` array so the rest of the handler is
  // shape-agnostic.
  type RawItem = {
    addon_catalog_id?: string;
    addon_type?: string;
    description?: string;
    unit_price?: number | string;
    unit_label?: string | null;
    gst_rate?: number | string;
    quantity?: number | string;
    notes?: string | null;
  };
  const rawItems: RawItem[] = Array.isArray(body.items) && body.items.length > 0
    ? (body.items as RawItem[])
    : [body as RawItem];

  if (rawItems.length === 0) {
    return NextResponse.json({ error: "At least one item is required" }, { status: 400 });
  }

  // Pre-fetch all referenced catalog rows in one query (avoids N round-trips
  // when 5 items in the cart all reference catalog ids).
  const catalogIds = Array.from(new Set(
    rawItems.map((it) => it.addon_catalog_id).filter(Boolean) as string[]
  ));
  let catalogMap = new Map<string, { addon_type: string; name: string; unit_price: number; unit_label: string | null; gst_rate: number }>();
  if (catalogIds.length > 0) {
    const { data: catRows, error: cErr } = await supabase
      .from("addon_catalog").select("id, addon_type, name, unit_price, unit_label, gst_rate")
      .in("id", catalogIds);
    if (cErr) return NextResponse.json({ error: cErr.message }, { status: 500 });
    catalogMap = new Map((catRows ?? []).map((r) => [r.id, r]));
  }

  // Resolve + validate each row.
  const toInsert: Array<Record<string, unknown>> = [];
  for (let i = 0; i < rawItems.length; i++) {
    const it = rawItems[i];
    let addon_type = it.addon_type;
    let description = it.description;
    let unit_price: number | string | undefined = it.unit_price;
    let unit_label = it.unit_label;
    let gst_rate: number | string | undefined = it.gst_rate;

    if (it.addon_catalog_id) {
      const cat = catalogMap.get(it.addon_catalog_id);
      if (!cat) {
        return NextResponse.json(
          { error: `Catalog item not found for entry ${i + 1}` },
          { status: 404 },
        );
      }
      addon_type  = addon_type  ?? cat.addon_type;
      description = description ?? cat.name;
      unit_price  = unit_price  ?? cat.unit_price;
      unit_label  = unit_label  ?? cat.unit_label;
      gst_rate    = gst_rate    ?? cat.gst_rate;
    }

    if (!addon_type || !(VALID_TYPES as readonly string[]).includes(addon_type)) {
      return NextResponse.json({ error: `Invalid addon_type at entry ${i + 1}` }, { status: 400 });
    }
    // Extended-time charges only make sense once the customer has actually
    // used extra time in the room. Before check-in, the booking's own
    // duration is still adjustable via Reschedule — which already recomputes
    // the full charge for the new time slot, so an extended_time addon on
    // top of that double-bills the same hours (see TWV-B-0219).
    if (addon_type === "extended_time" && booking.status !== "checked_in") {
      return NextResponse.json(
        { error: "Extended-time charges can only be added after check-in. To change the booking's time before check-in, use Reschedule instead — it already recalculates the full charge for the new duration." },
        { status: 400 },
      );
    }
    if (!description || typeof description !== "string" || !description.trim()) {
      return NextResponse.json({ error: `Description required at entry ${i + 1}` }, { status: 400 });
    }
    const qty = Number(it.quantity ?? 1);
    const price = Number(unit_price ?? 0);
    const gst = Number(gst_rate ?? 18);
    if (!isFinite(qty) || qty <= 0) return NextResponse.json({ error: `Quantity must be > 0 at entry ${i + 1}` }, { status: 400 });
    if (!isFinite(price) || price < 0) return NextResponse.json({ error: `Unit price must be >= 0 at entry ${i + 1}` }, { status: 400 });

    const amount = parseFloat((qty * price).toFixed(2));
    const gstAmount = parseFloat((amount * gst / 100).toFixed(2));
    const totalWithGst = parseFloat((amount + gstAmount).toFixed(2));

    toInsert.push({
      booking_id: id,
      addon_catalog_id: it.addon_catalog_id || null,
      addon_type,
      description: String(description).trim(),
      quantity: qty,
      unit_price: price,
      unit_label: unit_label || null,
      amount,
      gst_rate: gst,
      gst_amount: gstAmount,
      total_with_gst: totalWithGst,
      notes: it.notes || null,
      added_by: dbUser.id,
    });
  }

  // One bulk insert + one recompute, regardless of cart size.
  const { data: addons, error: insErr } = await supabase
    .from("booking_addons")
    .insert(toInsert)
    .select();
  if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });

  await recomputeBookingTotal(supabase, id, booking);

  // Audit one row per inserted addon — keeps the existing per-addon timeline
  // contract intact (callers consuming audit_trail don't need to learn a new
  // batch shape).
  for (const addon of addons ?? []) {
    logAudit(supabase, {
      entityType: "booking_addon",
      entityId: addon.id,
      action: "create",
      performedBy: dbUser.id,
      changes: { record: { old: null, new: addon } },
    });
  }

  // Single-item legacy callers expect `{ data: <addon> }`. Multi-item callers
  // use `data` as the array. Always include `count` for clarity.
  return NextResponse.json({
    data: (addons?.length ?? 0) === 1 ? addons![0] : (addons ?? []),
    count: addons?.length ?? 0,
  }, { status: 201 });
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
