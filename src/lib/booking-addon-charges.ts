import { SupabaseClient } from "@supabase/supabase-js";

/**
 * Keeps a `usage_charges` row in sync with a `booking_addon` row for
 * contract-holder bookings.
 *
 * Why this exists: a contract holder's room charge is posted to
 * `usage_charges` at booking-creation time (see src/app/api/bookings/route.ts),
 * but add-ons (extended time, printer pages, tea, etc. — `booking_addons`)
 * only ever updated `bookings.total_amount_with_gst`. Nothing read
 * `booking_addons` in the billing pipeline (src/lib/billing.ts,
 * src/lib/pdf-generator.ts), so add-ons on a contract-holder booking were
 * silently never invoiced. This module creates a matching usage_charges row
 * per add-on so it gets picked up by the normal statement pipeline and
 * itemised on the statement, and keeps it in sync when the add-on is
 * removed.
 */

type AddonRow = {
  id: string;
  booking_id: string;
  description: string;
  quantity: number;
  unit_price: number;
  amount: number;
  gst_rate: number;
  gst_amount: number;
  total_with_gst: number;
};

type ContractBookingInfo = {
  contract_id: string;
  booking_number: string;
  booking_date: string; // YYYY-MM-DD
};

/**
 * `booking_addons` (supabase/migrations/00117_daypass_pricing_addons.sql) has
 * no column to store a linked charge id, and this change doesn't own
 * migrations. Rather than matching on booking_id + description alone — which
 * is ambiguous whenever two add-ons on the same booking share a description
 * (e.g. two separate "Tea" line items) — we stash an exact marker in
 * usage_charges.notes (a pre-existing free-text column) and match on that.
 */
const ADDON_NOTE_PREFIX = "booking_addon_id:";

export function addonChargeNote(addonId: string): string {
  return `${ADDON_NOTE_PREFIX}${addonId}`;
}

export function buildAddonChargeDescription(
  addonDescription: string,
  bookingNumber: string,
  bookingDate: string,
): string {
  return `Add-on: ${addonDescription} (${bookingNumber}, ${bookingDate})`;
}

/**
 * Create a usage_charges row for one add-on on a contract-holder booking.
 * Called right after the booking_addons insert succeeds. Never throws —
 * a failure here is logged and surfaced via the caller's response, but the
 * add-on row itself has already been saved and should not be rolled back
 * for a charge-sync failure alone.
 */
export async function createAddonUsageCharge(
  supabase: SupabaseClient,
  addon: AddonRow,
  booking: ContractBookingInfo,
  leadId: string | null,
  createdBy: string,
): Promise<{ id: string } | null> {
  const { data, error } = await supabase
    .from("usage_charges")
    .insert({
      contract_id: booking.contract_id,
      lead_id: leadId,
      booking_id: addon.booking_id,
      description: buildAddonChargeDescription(addon.description, booking.booking_number, booking.booking_date),
      quantity: addon.quantity,
      billed_quantity: addon.quantity,
      unit_price: addon.unit_price,
      total: addon.amount,
      gst_rate: addon.gst_rate,
      gst_amount: addon.gst_amount,
      total_with_gst: addon.total_with_gst,
      charge_date: booking.booking_date,
      status: "pending",
      contract_facility_id: null,
      created_by: createdBy,
      notes: addonChargeNote(addon.id),
    })
    .select("id")
    .single();

  if (error) {
    console.error(`[booking-addon-charges] failed to create usage charge for addon ${addon.id}:`, error.message);
    return null;
  }
  return data;
}

/**
 * Find the usage_charges row linked to a given add-on, if one exists.
 * Returns null for non-contract bookings (no charge was ever created) or
 * on lookup failure.
 */
export async function findAddonUsageCharge(
  supabase: SupabaseClient,
  bookingId: string,
  addonId: string,
): Promise<{ id: string; status: string; billing_statement_id: string | null } | null> {
  const { data, error } = await supabase
    .from("usage_charges")
    .select("id, status, billing_statement_id")
    .eq("booking_id", bookingId)
    .eq("notes", addonChargeNote(addonId))
    .maybeSingle();

  if (error) {
    console.error(`[booking-addon-charges] failed to look up usage charge for addon ${addonId}:`, error.message);
    return null;
  }
  return data;
}

/**
 * True if a charge is already locked into billing history and must not be
 * silently mutated or deleted — e.g. attached to a statement, or already
 * marked billed.
 */
export function isChargeAlreadyInvoiced(charge: { status: string; billing_statement_id: string | null }): boolean {
  return charge.billing_statement_id !== null || charge.status === "billed";
}
