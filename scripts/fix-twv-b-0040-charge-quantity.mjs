/**
 * One-off: correct the quantity on the usage charge for booking TWV-B-0040.
 *
 *   node scripts/fix-twv-b-0040-charge-quantity.mjs          # dry run
 *   node scripts/fix-twv-b-0040-charge-quantity.mjs --apply  # write
 *
 * The customer booked Arcade Conference Room for one hour (15:30–16:30 on
 * 2026-05-06) and actually occupied it from 15:55 to 18:54 IST — 2.98 hours.
 * Three hours at Rs 800 were billed, which is correct.
 *
 * The charge was stored as quantity 1 at unit_price 800 with total 2400, so the
 * line reads as Rs 800 while charging Rs 2,400. Only the quantity is wrong.
 *
 * This sets quantity to 3. It does not touch total, gst_amount, total_with_gst
 * or anything on the statement — no amount changes, and the statement
 * TWV-BS-0125 keeps the line_items snapshot of what was actually invoiced via
 * Tally (SD/A/26-27/263), which is a historical record and not ours to rewrite.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

const env = {};
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) {
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[m[1]] = v.replace(/\\n$/, "");
  }
}

const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const APPLY = process.argv.includes("--apply");
const CHARGE_ID = "04b0c2f4-f28a-4f8e-a82b-dc9255fddcec";
const CORRECT_QTY = 3;

const { data: before, error } = await supabase
  .from("usage_charges")
  .select("id, description, quantity, unit_price, total, status")
  .eq("id", CHARGE_ID)
  .single();

if (error) { console.error("Charge not found:", error.message); process.exit(1); }

console.log("current:", JSON.stringify({
  quantity: before.quantity, unit_price: before.unit_price, total: before.total, status: before.status,
}));

if (Number(before.quantity) === CORRECT_QTY) {
  console.log("Already corrected — nothing to do.");
  process.exit(0);
}
if (Number(before.total) !== CORRECT_QTY * Number(before.unit_price)) {
  console.error(`Refusing: total ${before.total} is not ${CORRECT_QTY} x ${before.unit_price}. Re-check before running.`);
  process.exit(1);
}

if (!APPLY) {
  console.log(`\nDRY RUN — would set quantity ${before.quantity} -> ${CORRECT_QTY}. Total stays ${before.total}.`);
  console.log("Re-run with --apply to write.");
  process.exit(0);
}

const { error: updateError } = await supabase
  .from("usage_charges").update({ quantity: CORRECT_QTY }).eq("id", CHARGE_ID);
if (updateError) { console.error("Update failed:", updateError.message); process.exit(1); }

const { data: after } = await supabase
  .from("usage_charges").select("quantity, unit_price, total").eq("id", CHARGE_ID).single();
console.log("updated:", JSON.stringify(after));
console.log(`${after.quantity} x ${after.unit_price} = ${after.quantity * after.unit_price} (total ${after.total})`);
