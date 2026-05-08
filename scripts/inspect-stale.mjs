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

for (const num of ["TWV-B-0001","TWV-B-0025","TWV-B-0002","TWV-B-0004","TWV-B-0028","TWV-B-0030"]) {
  const { data: b } = await supa.from("bookings").select("id, total_amount, gst_amount, total_amount_with_gst, payment_status").eq("booking_number", num).single();
  const { data: pays } = await supa.from("booking_payments").select("id, amount, payment_mode, status, created_at").eq("booking_id", b.id);
  const { data: addons } = await supa.from("booking_addons").select("amount, gst_amount, total_with_gst, created_at").eq("booking_id", b.id);
  const paid = (pays || []).filter(p => p.status === "verified").reduce((s, p) => s + Number(p.amount), 0);
  const expectedGst = Number(b.total_amount) * 0.18;
  console.log(`\n${num}: total=${b.total_amount} gst=${b.gst_amount} grand=${b.total_amount_with_gst} paid=${paid}`);
  console.log(`  expected_gst_at_18%=${expectedGst.toFixed(2)} addons=${addons?.length || 0}`);
  console.log(`  payments:`, pays?.map(p => `${p.payment_mode}:${p.amount}@${p.created_at?.slice(0,10)}`).join(", "));
  if (addons?.length) console.log(`  addons:`, addons.map(a => `${a.amount}+${a.gst_amount}=${a.total_with_gst}`).join(", "));
}
