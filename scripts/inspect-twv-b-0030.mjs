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

const { data: b } = await supa
  .from("bookings")
  .select("*")
  .eq("booking_number", "TWV-B-0030")
  .single();

if (!b) { console.error("Not found"); process.exit(1); }

console.log("=== BOOKING ===");
console.log("id:", b.id);
console.log("date/time:", b.booking_date, b.start_time, "→", b.end_time);
console.log("duration_hours:", b.duration_hours);
console.log("pricing_model:", b.pricing_model, "  unit_rate:", b.unit_rate, "  quantity:", b.quantity);
console.log("hourly_rate:", b.hourly_rate);
console.log("total_amount:", b.total_amount);
console.log("gst_rate:", b.gst_rate, "  gst_amount:", b.gst_amount);
console.log("total_amount_with_gst:", b.total_amount_with_gst);
console.log("payment_status:", b.payment_status, "  payment_mode:", b.payment_mode);

console.log("\n=== PAYMENTS ===");
const { data: pays } = await supa
  .from("booking_payments")
  .select("*, collector:users!booking_payments_collected_by_fkey(id, full_name), handover_receiver:users!booking_payments_handed_over_to_fkey(id, full_name), confirmer:users!booking_payments_handover_confirmed_by_fkey(id, full_name)")
  .eq("booking_id", b.id)
  .order("created_at");
for (const p of pays || []) {
  console.log(`- ${p.payment_mode} ₹${p.amount} (${p.status})`);
  console.log(`  collected_by: ${p.collector?.full_name || "—"} at ${p.collected_at || "—"}`);
  console.log(`  handover_status: ${p.cash_handover_status || "—"}`);
  console.log(`  handed_over_to: ${p.handover_receiver?.full_name || "—"} at ${p.handed_over_at || "—"}`);
  console.log(`  handover_confirmed_by: ${p.confirmer?.full_name || "—"} at ${p.handover_confirmed_at || "—"}`);
}

console.log("\n=== ADDONS ===");
const { data: addons } = await supa
  .from("booking_addons").select("*").eq("booking_id", b.id);
for (const a of addons || []) console.log(`- ${a.description}: ₹${a.amount} + ₹${a.gst_amount} GST = ₹${a.total_with_gst}`);
