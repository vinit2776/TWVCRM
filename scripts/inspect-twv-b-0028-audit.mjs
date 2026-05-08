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
  .eq("booking_number", "TWV-B-0028")
  .single();

console.log("=== BOOKING ===");
console.log("id:", b.id);
console.log("date/time:", b.booking_date, b.start_time, "→", b.end_time);
console.log("duration_hours:", b.duration_hours, " pricing_model:", b.pricing_model);
console.log("hourly_rate:", b.hourly_rate, " unit_rate:", b.unit_rate);
console.log("total_amount:", b.total_amount, " gst:", b.gst_amount, " grand:", b.total_amount_with_gst);
console.log("payment_status:", b.payment_status);
console.log("created_at:", b.created_at, " updated_at:", b.updated_at);

console.log("\n=== ALL PAYMENTS (any status) ===");
const { data: pays } = await supa
  .from("booking_payments")
  .select("*, collector:users!booking_payments_collected_by_fkey(full_name)")
  .eq("booking_id", b.id)
  .order("created_at");
for (const p of pays || []) {
  console.log(`- ${p.payment_mode} ₹${p.amount} status=${p.status} collected_by=${p.collector?.full_name || "—"} at ${p.created_at}`);
}

console.log("\n=== AUDIT LOG ===");
const { data: audit } = await supa
  .from("audit_log")
  .select("*, user:users!audit_log_performed_by_fkey(full_name)")
  .eq("entity_type", "booking")
  .eq("entity_id", b.id)
  .order("created_at");
for (const a of audit || []) {
  console.log(`- ${a.created_at} ${a.action} by ${a.user?.full_name || "—"}`);
  if (a.changes) console.log("    ", JSON.stringify(a.changes).slice(0, 200));
}

console.log("\n=== ADDONS ===");
const { data: addons } = await supa
  .from("booking_addons").select("*").eq("booking_id", b.id);
for (const a of addons || []) console.log(`  ${a.description}: ${a.amount} + ${a.gst_amount} = ${a.total_with_gst} created_at=${a.created_at}`);
