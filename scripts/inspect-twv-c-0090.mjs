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

const { data: contract, error: cErr } = await supa
  .from("contracts")
  .select(`
    id, contract_number, billing_mode, status,
    lead:leads!contracts_lead_id_fkey(id, first_name, last_name, company, email, mobile, phone, gst_number)
  `)
  .eq("contract_number", "TWV-C-0090")
  .maybeSingle();

if (cErr || !contract) { console.error("Contract not found", cErr); process.exit(1); }

console.log("=== CONTRACT ===");
console.log(JSON.stringify(contract, null, 2));

console.log("\n=== BILLING STATEMENTS (Aug period) ===");
const { data: stmts, error: sErr } = await supa
  .from("billing_statements")
  .select("*")
  .eq("contract_id", contract.id)
  .gte("period_start", "2026-08-01")
  .lte("period_start", "2026-08-31")
  .order("created_at", { ascending: false });

if (sErr) console.error(sErr);
console.log(JSON.stringify(stmts, null, 2));

for (const s of stmts || []) {
  console.log(`\n=== GST INVOICE UPLOADS for statement ${s.id} (${s.statement_number}) ===`);
  const { data: uploads } = await supa
    .from("gst_invoice_uploads")
    .select("*")
    .eq("billing_statement_id", s.id)
    .order("created_at", { ascending: false });
  console.log(JSON.stringify(uploads, null, 2));

  console.log(`\n=== AUDIT TRAIL for statement ${s.id} ===`);
  const { data: audit } = await supa
    .from("audit_trail")
    .select("*")
    .eq("entity_type", "billing_statement")
    .eq("entity_id", s.id)
    .order("created_at", { ascending: false });
  console.log(JSON.stringify(audit, null, 2));
}
