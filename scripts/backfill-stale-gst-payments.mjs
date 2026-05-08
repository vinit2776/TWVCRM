#!/usr/bin/env node
/**
 * One-off: 5 cash payments recorded BEFORE the GST-inclusive balance fix
 * (commit 6ea5076) capped collection at the ex-GST total. Customers
 * actually paid the GST-inclusive total in cash; the system only
 * recorded the pre-tax amount, leaving each booking with a ghost
 * "balance due" equal to the GST.
 *
 * Pattern (verified manually): paid = total_amount, gap = gst_amount.
 * For each affected row we bump the payment up by the GST gap and
 * audit-log the correction.
 *
 * TWV-B-0028 is excluded — its ₹1,675 gap doesn't match the GST
 * pattern, so it needs human review (probably partial payment).
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

const TARGETS = ["TWV-B-0001", "TWV-B-0002", "TWV-B-0004", "TWV-B-0025", "TWV-B-0030"];

for (const num of TARGETS) {
  const { data: b } = await supa
    .from("bookings")
    .select("id, total_amount, gst_amount, total_amount_with_gst")
    .eq("booking_number", num)
    .single();

  const { data: pays } = await supa
    .from("booking_payments")
    .select("id, amount")
    .eq("booking_id", b.id)
    .eq("status", "verified");

  // Single payment expected for these cases. If split across multiple,
  // skip and flag — the math gets ambiguous.
  if (pays.length !== 1) {
    console.log(`! ${num}: ${pays.length} payments — skipping for manual review`);
    continue;
  }

  const p = pays[0];
  const currentAmount = Number(p.amount);
  const grandTotal = Number(b.total_amount_with_gst);
  const expected = grandTotal;

  // Sanity: only correct when the gap is exactly the GST amount.
  // Anything else is a different bug and shouldn't be auto-bumped.
  const gap = grandTotal - currentAmount;
  if (Math.abs(gap - Number(b.gst_amount)) > 0.01) {
    console.log(`! ${num}: gap ${gap} != gst ${b.gst_amount} — skipping`);
    continue;
  }

  const { error } = await supa
    .from("booking_payments")
    .update({ amount: expected })
    .eq("id", p.id);
  if (error) {
    console.error(`x ${num}: ${error.message}`);
    continue;
  }
  await supa.from("audit_log").insert({
    entity_type: "booking_payment",
    entity_id: p.id,
    action: "update",
    changes: {
      amount: { old: currentAmount, new: expected },
      reason: { old: null, new: "Backfill — pre-fix GST-inclusive bug. Customer paid the GST-inclusive amount in cash; system had only recorded the ex-GST portion." },
    },
  });
  console.log(`✓ ${num}: payment ₹${currentAmount} → ₹${expected}`);
}
