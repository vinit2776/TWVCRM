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

const statementId = "ae06f596-fcfc-4cd6-a21f-54443b42cea4";

console.log("=== gst_invoice_uploads: raw error check ===");
const { data: uploads, error: uErr, count } = await supa
  .from("gst_invoice_uploads")
  .select("*", { count: "exact" })
  .eq("billing_statement_id", statementId);
console.log("error:", uErr, "count:", count);
console.log(JSON.stringify(uploads, null, 2));

console.log("\n=== gst_invoice_uploads: any row with tally_invoice_number = SD/A/26-27/267 ===");
const { data: byNum, error: nErr } = await supa
  .from("gst_invoice_uploads")
  .select("*")
  .eq("tally_invoice_number", "SD/A/26-27/267");
console.log("error:", nErr);
console.log(JSON.stringify(byNum, null, 2));

console.log("\n=== Full audit trail (contract-level too) ===");
const { data: audit2 } = await supa
  .from("audit_trail")
  .select("*")
  .eq("entity_id", statementId)
  .order("created_at", { ascending: true });
console.log(JSON.stringify(audit2, null, 2));

console.log("\n=== app_settings: resend / email related keys ===");
const { data: settings } = await supa
  .from("app_settings")
  .select("key, value")
  .in("key", ["razorpay_enabled", "tally_sync_enabled", "tally_handoff_v2_enabled"]);
console.log(JSON.stringify(settings, null, 2));
