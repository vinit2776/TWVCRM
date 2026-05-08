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

const { data: b } = await supa.from("bookings").select("id, payment_status, total_amount_with_gst").eq("booking_number", "TWV-B-0028").single();
const { data: pays } = await supa.from("booking_payments").select("amount").eq("booking_id", b.id).eq("status", "verified");
const paid = (pays || []).reduce((s, p) => s + Number(p.amount), 0);
const total = Number(b.total_amount_with_gst);
console.log(`paid ₹${paid} of ₹${total}, currently ${b.payment_status}`);

await supa.from("bookings").update({ payment_status: "pending" }).eq("id", b.id);
await supa.from("audit_log").insert({
  entity_type: "booking",
  entity_id: b.id,
  action: "update",
  changes: {
    payment_status: { old: "paid", new: "pending" },
    reason: { old: null, new: `Manual correction — actually collected ₹${paid} of ₹${total}; flag was stale from a pre-fix code path. Real balance due ₹${(total - paid).toFixed(2)}.` },
  },
});
console.log("✓ Reset to pending");
