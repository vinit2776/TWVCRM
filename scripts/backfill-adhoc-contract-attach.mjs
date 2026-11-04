#!/usr/bin/env node
/**
 * Attaches existing ad-hoc invoices to the customer's live contract.
 *
 * New invoices are attached when they are created (POST /api/invoices). This
 * catches the ones raised before that rule existed.
 *
 *   node scripts/backfill-adhoc-contract-attach.mjs            # list only, changes nothing
 *   node scripts/backfill-adhoc-contract-attach.mjs --apply    # write the attachments
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from the
 * environment, so it hits whichever project those point at; it prints the
 * project ref first.
 *
 * Attaches an invoice only when ALL hold:
 *   - it belongs to a lead, is not cancelled and not already on a contract
 *   - the lead has exactly ONE live contract (several = a person decides)
 *   - the invoice was created on/after that contract's start date, so an old
 *     term's invoices never land on a later contract
 * Purpose is always "other": visibility only, never opens the activation gate.
 */
import { createClient } from "@supabase/supabase-js";

const apply = process.argv.includes("--apply");
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}
console.log(`Project: ${new URL(url).hostname.split(".")[0]}  Mode: ${apply ? "APPLY" : "list only"}\n`);

const db = createClient(url, key, { auth: { persistSession: false } });
const today = new Date().toISOString().slice(0, 10);

const { data: contracts, error: cErr } = await db
  .from("contracts")
  .select("id, contract_number, lead_id, status, start_date, end_date")
  .in("status", ["active", "renewal_in_progress"]);
if (cErr) throw cErr;
const live = contracts.filter((c) => c.status === "active" || c.end_date >= today);
const byLead = new Map();
for (const c of live) byLead.set(c.lead_id, [...(byLead.get(c.lead_id) ?? []), c]);

const { data: invoices, error: iErr } = await db
  .from("proforma_invoices")
  .select("id, invoice_number, lead_id, status, total_amount, created_at")
  .not("lead_id", "is", null)
  .is("contract_id", null)
  .neq("status", "cancelled");
if (iErr) throw iErr;

const matches = [];
const needHuman = [];
for (const inv of invoices) {
  const mine = byLead.get(inv.lead_id);
  if (!mine) continue;
  if (mine.length > 1) { needHuman.push({ inv, contracts: mine }); continue; }
  const [c] = mine;
  if (c.start_date && inv.created_at.slice(0, 10) < c.start_date) continue;
  matches.push({ inv, c });
}

console.log(`Would attach (${matches.length}):`);
for (const { inv, c } of matches) console.log(`  ${inv.invoice_number}  ${inv.status}  ${inv.total_amount}  ->  ${c.contract_number}`);
console.log(`\nNeeds a person (customer has several live contracts) (${needHuman.length}):`);
for (const { inv, contracts: cs } of needHuman) console.log(`  ${inv.invoice_number}  ${inv.status}  ${inv.total_amount}  ->  ${cs.map((c) => c.contract_number).join(" / ")}`);

if (!apply) { console.log("\nNothing changed. Re-run with --apply to write the first list."); process.exit(0); }

let done = 0;
for (const { inv, c } of matches) {
  const { error } = await db.from("proforma_invoices").update({
    contract_id: c.id,
    attribution_purpose: "other",
    attributed_at: new Date().toISOString(),
  }).eq("id", inv.id).is("contract_id", null);
  if (error) { console.error(`  FAILED ${inv.invoice_number}: ${error.message}`); continue; }
  await db.from("audit_trail").insert({
    entity_type: "contract", entity_id: c.id, action: "invoice_attributed",
    changes: { invoice_number: { old: null, new: inv.invoice_number }, automatic: { old: null, new: "backfill: live contract" } },
  });
  done++;
}
console.log(`\nAttached ${done} of ${matches.length}.`);
