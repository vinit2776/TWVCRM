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

const DRY = process.argv.includes("--dry");

// Same universe the fixed tally-reconcile cron will now see.
const { data: stuck, error } = await supa
  .from("billing_statements")
  .select(`
    id, statement_number, tally_invoice_number, total_amount, lifecycle_stage,
    tally_synced_at, gst_invoice_sent_at, gst_invoice_sent_to, payment_status, voided_at,
    contract:contracts!billing_statements_contract_id_fkey(
      contract_number,
      lead:leads!contracts_lead_id_fkey(email, billing_emails)
    ),
    proposal:proposals!billing_statements_proposal_id_fkey(
      proposal_number,
      lead:leads!proposals_lead_id_fkey(email, billing_emails)
    ),
    invoice:proforma_invoices!billing_statements_invoice_id_fkey(
      invoice_number,
      lead:leads!proforma_invoices_lead_id_fkey(email, billing_emails)
    )
  `)
  .eq("issuance_channel", "tally")
  .not("tally_invoice_number", "is", null)
  .is("tally_delivered_at", null)
  .order("tally_synced_at", { ascending: true });

if (error) { console.error(error); process.exit(1); }

const alreadyEmailed = [];   // gst_invoice_sent_at set -> safe bookkeeping-only backfill
const neverEmailed = [];     // no send record at all -> needs an actual send, flagged not auto-fired
const missingCc = [];        // emailed, but lead has billing_emails not covered by gst_invoice_sent_to

for (const s of stuck || []) {
  const ref = s.contract?.contract_number ?? s.proposal?.proposal_number ?? s.invoice?.invoice_number ?? "?";
  const lead = s.contract?.lead ?? s.proposal?.lead ?? s.invoice?.lead;
  const row = { id: s.id, stmt: s.statement_number, ref, invoice: s.tally_invoice_number, sentAt: s.gst_invoice_sent_at, sentTo: s.gst_invoice_sent_to, email: lead?.email, billingEmails: lead?.billing_emails || [] };

  if (s.gst_invoice_sent_at) {
    alreadyEmailed.push(row);
    const sentToList = (s.gst_invoice_sent_to || "").split(",").map((x) => x.trim()).filter(Boolean);
    const missing = (lead?.billing_emails || []).filter((e) => e && !sentToList.includes(e));
    if (missing.length > 0) missingCc.push({ ...row, missing });
  } else {
    neverEmailed.push(row);
  }
}

console.log(`Total stuck (issued, undelivered flag): ${(stuck || []).length}`);
console.log(`  Already emailed at least once (safe bookkeeping-only backfill): ${alreadyEmailed.length}`);
console.log(`  Never emailed at all (needs explicit send): ${neverEmailed.length}`);
console.log(`  Emailed but missing some billing_emails CC recipients: ${missingCc.length}`);

console.log("\n=== NEVER EMAILED (flagged, not auto-fired) ===");
for (const r of neverEmailed) console.log(`  ${r.stmt} (${r.ref}) invoice=${r.invoice} email=${r.email || "NONE ON FILE"}`);

console.log("\n=== MISSING CC (will resend to full list) ===");
for (const r of missingCc) console.log(`  ${r.stmt} (${r.ref}) invoice=${r.invoice} missing=${r.missing.join(", ")}`);

if (DRY) {
  console.log("\n--dry mode, no writes performed.");
  process.exit(0);
}

console.log("\n=== Backfilling tally_delivered_at / lifecycle_stage for already-emailed statements ===");
let ok = 0, fail = 0;
for (const r of alreadyEmailed) {
  const { error: updErr } = await supa
    .from("billing_statements")
    .update({
      tally_delivered_at: r.sentAt,
      lifecycle_stage: "sent",
      emailed_at: r.sentAt,
      emailed_to: (r.sentTo || r.email || "").split(",")[0]?.trim() || r.email,
    })
    .eq("id", r.id)
    .is("tally_delivered_at", null); // don't clobber if something else set it concurrently
  if (updErr) { console.error(`  FAIL ${r.stmt}: ${updErr.message}`); fail++; }
  else { console.log(`  OK ${r.stmt}`); ok++; }
}
console.log(`\nBackfilled: ${ok} ok, ${fail} failed`);

// Persist the two flagged lists for the next step (CC resend + never-emailed handling)
import { writeFileSync } from "fs";
writeFileSync(new URL("../scripts/.backfill-missing-cc.json", import.meta.url), JSON.stringify(missingCc, null, 2));
writeFileSync(new URL("../scripts/.backfill-never-emailed.json", import.meta.url), JSON.stringify(neverEmailed, null, 2));
console.log("\nWrote scripts/.backfill-missing-cc.json and scripts/.backfill-never-emailed.json");
