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

console.log("=== Exact tally-reconcile cron query ===");
const { data: stuck, error } = await supa
  .from("billing_statements")
  .select("id, statement_number, tally_invoice_number, total_amount, lifecycle_stage, tally_synced_at")
  .eq("issuance_channel", "tally")
  .not("tally_invoice_number", "is", null)
  .is("tally_delivered_at", null)
  .neq("lifecycle_stage", "awaiting_irn")
  .order("tally_synced_at", { ascending: true })
  .limit(50);

console.log("error:", error);
console.log("count returned:", (stuck || []).length);
console.log("TWV-BS-0236 present in results?", (stuck || []).some(s => s.id === statementId));

console.log("\n=== Same query WITHOUT the lifecycle_stage neq filter ===");
const { data: stuck2 } = await supa
  .from("billing_statements")
  .select("id, statement_number, tally_invoice_number, total_amount, lifecycle_stage, tally_synced_at")
  .eq("issuance_channel", "tally")
  .not("tally_invoice_number", "is", null)
  .is("tally_delivered_at", null)
  .order("tally_synced_at", { ascending: true })
  .limit(50);
console.log("count returned:", (stuck2 || []).length);
console.log("TWV-BS-0236 present in results?", (stuck2 || []).some(s => s.id === statementId));

console.log("\n=== How many OTHER tally-issued, undelivered statements have NULL lifecycle_stage (i.e. also silently excluded)? ===");
const nullLifecycleStuck = (stuck2 || []).filter(s => s.lifecycle_stage === null);
console.log("count with null lifecycle_stage:", nullLifecycleStuck.length);
console.log(nullLifecycleStuck.map(s => s.statement_number));
