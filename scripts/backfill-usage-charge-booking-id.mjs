#!/usr/bin/env node
/**
 * One-shot: link usage_charge rows back to their source booking.
 *
 * Background: a booking-POST bug inserted usage_charges without setting
 * booking_id, so finance couldn't trace from a charge back to the booking
 * that produced it. The bug is fixed; this backfill repairs existing rows.
 *
 * Strategy: match by (contract_id, charge_date, total) — the natural keys
 * that uniquely identify a per-booking charge. Each match is logged.
 *
 * Idempotent: rows that already have booking_id set are skipped.
 *
 * Run once:  node scripts/backfill-usage-charge-booking-id.mjs
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
  console.log("→ Backfilling usage_charges.booking_id");

  // Pull every charge that's missing booking_id but has a contract — those
  // are the candidates the booking-POST flow created.
  const { data: orphans, error } = await supa
    .from("usage_charges")
    .select("id, contract_id, charge_date, total, description")
    .is("booking_id", null)
    .not("contract_id", "is", null);
  if (error) { console.error(error); process.exit(1); }
  console.log(`  candidates: ${orphans?.length ?? 0}`);
  if (!orphans || orphans.length === 0) { console.log("  nothing to do"); return; }

  let linked = 0;
  let ambiguous = 0;
  let unmatched = 0;

  for (const o of orphans) {
    // Matching strategy: same contract, same booking_date, same money amount.
    // The amount alone is fragile (could collide), so we add the date + a
    // looser total match (within 0.01 for float-rounding safety).
    const { data: candidates } = await supa
      .from("bookings")
      .select("id, booking_number, total_amount, total_amount_with_gst")
      .eq("contract_id", o.contract_id)
      .eq("booking_date", o.charge_date);

    if (!candidates || candidates.length === 0) {
      unmatched += 1;
      console.log(`  ! ${o.id}: no bookings on ${o.charge_date} for that contract`);
      continue;
    }

    // Charge total comes from booking.total_amount (ex-GST) per the POST
    // flow at the time the bug existed. Tolerate ±₹0.50 rounding drift.
    const tol = 0.5;
    const matches = candidates.filter((b) =>
      Math.abs(Number(b.total_amount) - Number(o.total)) <= tol
    );

    if (matches.length === 1) {
      const { error: upErr } = await supa
        .from("usage_charges")
        .update({ booking_id: matches[0].id })
        .eq("id", o.id);
      if (upErr) {
        console.warn(`  ! ${o.id}: ${upErr.message}`);
        continue;
      }
      linked += 1;
      console.log(`  ✓ ${o.description.slice(0, 60)} → ${matches[0].booking_number}`);
    } else if (matches.length > 1) {
      ambiguous += 1;
      console.log(`  ? ${o.id}: ${matches.length} possible matches — needs manual review`);
    } else {
      unmatched += 1;
      console.log(`  ! ${o.id}: no amount match (charge ₹${o.total} vs ${candidates.map((c) => `₹${c.total_amount}`).join(", ")})`);
    }
  }

  console.log(`\n✔ Linked: ${linked}, ambiguous: ${ambiguous}, unmatched: ${unmatched}`);
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
