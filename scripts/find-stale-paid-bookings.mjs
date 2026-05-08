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

// Find paid bookings where the verified payment total < total_amount_with_gst
const { data: bookings } = await supa
  .from("bookings")
  .select("id, booking_number, total_amount, total_amount_with_gst, gst_amount, payment_status")
  .eq("payment_status", "paid")
  .gt("gst_amount", 0);

const affected = [];
for (const b of bookings || []) {
  const { data: pays } = await supa
    .from("booking_payments")
    .select("amount")
    .eq("booking_id", b.id)
    .eq("status", "verified");
  const paid = (pays || []).reduce((s, p) => s + Number(p.amount), 0);
  const grand = Number(b.total_amount_with_gst);
  if (paid + 0.01 < grand) {
    affected.push({ ...b, paid, gap: grand - paid });
  }
}

console.log(`Affected bookings (paid status but payments < grand total): ${affected.length}`);
for (const a of affected) {
  console.log(`  ${a.booking_number}: paid ₹${a.paid} of ₹${a.total_amount_with_gst} (gap ₹${a.gap.toFixed(2)})`);
}
