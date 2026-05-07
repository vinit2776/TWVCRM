#!/usr/bin/env node
/**
 * One-off: mark TWV-B-0046 as waived (complimentary).
 *
 * Background: the booking was created with ₹0 total because it was
 * meant to be complimentary, but the booking-creation flow has no
 * "total = 0 → waived" branch. payment_status stayed as "pending"
 * throughout the lifecycle, confusing finance.
 *
 * The proper fix (A+B+C plan in chat) is shipping next; this script
 * patches the one existing affected row + audit-logs the correction
 * so there's a paper trail.
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

const env = {};
const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
for (const line of raw.split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) {
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    v = v.replace(/\\n$/, "");
    env[m[1]] = v;
  }
}

const supa = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function main() {
  console.log("→ Looking up TWV-B-0046…");

  const { data: booking, error } = await supa
    .from("bookings")
    .select("id, booking_number, payment_status, total_amount, total_amount_with_gst")
    .eq("booking_number", "TWV-B-0046")
    .single();

  if (error || !booking) {
    console.error("Booking not found:", error?.message);
    process.exit(1);
  }

  console.log(`  Found: ${booking.booking_number}`);
  console.log(`  Current payment_status: ${booking.payment_status}`);
  console.log(`  total_amount: ${booking.total_amount}`);
  console.log(`  total_amount_with_gst: ${booking.total_amount_with_gst}`);

  if (booking.payment_status === "waived") {
    console.log("  Already waived — nothing to do.");
    return;
  }

  const total = Number(booking.total_amount_with_gst ?? booking.total_amount ?? 0);
  if (total > 0) {
    console.error(`  Refusing to waive: total is ${total}, not 0. Manual review needed.`);
    process.exit(1);
  }

  // Update the row
  const { error: upErr } = await supa
    .from("bookings")
    .update({ payment_status: "waived" })
    .eq("id", booking.id);
  if (upErr) {
    console.error("Update failed:", upErr.message);
    process.exit(1);
  }

  // Audit log
  await supa.from("audit_log").insert({
    entity_type: "booking",
    entity_id: booking.id,
    action: "update",
    changes: {
      payment_status: { old: booking.payment_status, new: "waived" },
      reason: { old: null, new: "Manual correction — booking was created at ₹0 (complimentary) but auto-defaulted to pending. The proper fix (auto-waive ₹0 bookings + complimentary reason capture) ships next." },
    },
  });

  console.log("✓ Marked TWV-B-0046 as waived. Audit logged.");
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
