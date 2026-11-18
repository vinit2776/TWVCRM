#!/usr/bin/env node
/**
 * Seeds the STAGING Supabase project with ONE customer whose billing covers every
 * line a statement of account can show, so the Statement of Account PDF (lead page
 * > Statement of Account > pick a FY) can be reviewed end to end:
 *
 *   two contracts over time   an ended one (Apr 2025 - Mar 2026, Rs 23,600/month) then a
 *                             live one at a higher rent (Apr 2026 on, Rs 29,500/month)
 *   GST invoices              paid in full, paid with TDS deducted, part paid, unpaid
 *   PIs                       paid, pending (aged 8 / 28 / 75 / 110+ days)
 *   left out of the statement voided, discarded, draft, and a finalized one never sent
 *   kept though unsent        a paid statement with no "sent" stamp
 *   opening balance           a FY 2025-26 balance still owing when FY 2026-27 starts
 *
 * Dates are relative to today, so re-run to refresh the aging. Re-running rebuilds the
 * rows. Remove everything with --clear.
 *
 *   node scripts/seed-staging-soa.mjs [--clear]
 *
 * Reads .env.staging.local (never .env.local) and refuses to run against production.
 * The lead's email is @example.com, so nothing reaches a real customer.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

const PRODUCTION_REF = "zlbvadtajetylacxevsm";
const EMAIL = "soaseed@example.com";
const TITLE = "SOASEED contract";

function loadEnv(path) {
  const env = {};
  for (const line of readFileSync(new URL(path, import.meta.url), "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) {
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      env[m[1]] = v.replace(/\\n$/, "");
    }
  }
  return env;
}
const env = loadEnv("../.env.staging.local");
if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) { console.error("Missing Supabase env in .env.staging.local"); process.exit(1); }
if (env.NEXT_PUBLIC_SUPABASE_URL.includes(PRODUCTION_REF)) { console.error("Refusing to run: this points at PRODUCTION."); process.exit(1); }
console.log(`Seeding ${env.NEXT_PUBLIC_SUPABASE_URL} ...`);
const supa = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

async function must(q, what) { const { data, error } = await q; if (error) throw new Error(`${what}: ${error.message}`); return data; }

const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
const daysAgo = (n) => new Date(new Date(`${today}T00:00:00Z`).getTime() - n * 86400e3).toISOString().slice(0, 10);
const at = (date) => `${date}T05:00:00+00:00`;

async function clear() {
  const leads = await must(supa.from("leads").select("id").eq("email", EMAIL), "find lead");
  const ids = leads.map((l) => l.id);
  if (!ids.length) return;
  const contracts = await must(supa.from("contracts").select("id").in("lead_id", ids), "find contracts");
  const cids = contracts.map((c) => c.id);
  const stmts = await must(supa.from("billing_statements").select("id").in("lead_id", ids), "find statements");
  const sids = stmts.map((s) => s.id);
  if (sids.length) {
    await must(supa.from("billing_payments").delete().in("billing_statement_id", sids), "delete payments");
    await must(supa.from("billing_statements").delete().in("id", sids), "delete statements");
  }
  if (cids.length) await must(supa.from("contracts").delete().in("id", cids), "delete contracts");
  await must(supa.from("proposals").delete().in("lead_id", ids), "delete proposals");
  await must(supa.from("leads").delete().in("id", ids), "delete lead");
  console.log("Cleared.");
}
await clear();
if (process.argv.includes("--clear")) process.exit(0);

const admin = await must(supa.from("users").select("id").eq("role", "admin").limit(1).maybeSingle(), "admin user");
const location = await must(supa.from("locations").select("id").eq("code", "STG01").maybeSingle(), "STG01 location");
if (!admin || !location) { console.error('Run "node scripts/seed-staging.mjs" first.'); process.exit(1); }

const lead = await must(supa.from("leads").insert({
  first_name: "Statement", last_name: "Demo", company: "SOASEED Statement Demo Pvt Ltd", email: EMAIL,
  phone: "9000000000", mobile: "9000000000", status: "won", source: "other", gst_number: "33AAACS1234A1Z5",
  street: "12 Demo Street, Nungambakkam", city: "Chennai", state: "Tamil Nadu", zip_code: "600034",
}).select("id").single(), "lead");
const proposal = await must(supa.from("proposals").insert({
  lead_id: lead.id, location_id: location.id, title: TITLE, total_amount: 20000, status: "accepted", payment_status: "paid",
  security_deposit_months: 0, security_deposit_amount: 0, deposit_payment_status: "not_required",
}).select("id").single(), "proposal");

const mkContract = (extra) => must(supa.from("contracts").insert({
  lead_id: lead.id, proposal_id: proposal.id, location_id: location.id, billing_cycle: "monthly", tenure_months: 12,
  seats: 2, tax_percentage: 18, created_by: admin.id, security_deposit_months: 0, security_deposit_amount: 0,
  deposit_payment_status: "not_required", ...extra,
}).select("id, contract_number").single(), "contract");

const c1 = await mkContract({
  title: `${TITLE} 1 (ended)`, status: "expired", start_date: "2025-04-01", end_date: "2026-03-31",
  subtotal: 20000, total_amount: 23600, activated_at: at("2025-04-01"),
});
const c2 = await mkContract({
  title: `${TITLE} 2 (live, higher rent)`, status: "active", start_date: "2026-04-01", end_date: "2027-03-31",
  subtotal: 25000, total_amount: 29500, activated_at: at("2026-04-01"),
});

let gst = 0;
const monthEnd = (y, m) => new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
/**
 * One statement. `sent` is days ago the PI went out; `gstNo` makes it a GST invoice;
 * `pay` lists [daysAgo, amount, mode, tds].
 */
async function stmt(contract, y, m, total, o) {
  const subtotal = Math.round(total / 1.18);
  // What the invoice lists: rent split from add-ons / usage so the Particulars column has real lines.
  const rent = o.items ? subtotal - o.items.reduce((a, [, amt]) => a + amt, 0) : subtotal;
  const lineItems = [
    { type: "prepaid_rent", label: "Rent", items: [{ description: contract.rentLabel, amount: rent, quantity: 1, unit_price: rent }], subtotal: rent },
    ...(o.items ? [{ type: "service_usage", label: "Add-ons and usage", items: o.items.map(([d, amt]) => ({ description: d, amount: amt, quantity: 1, unit_price: amt })), subtotal: o.items.reduce((a, [, amt]) => a + amt, 0) }] : []),
  ];
  const sentDate = o.sentOn ?? (o.sent != null ? daysAgo(o.sent) : null);
  const row = await must(supa.from("billing_statements").insert({
    contract_id: contract.id, lead_id: lead.id, period_start: `${y}-${String(m).padStart(2, "0")}-01`, period_end: monthEnd(y, m),
    fixed_amount: subtotal, subtotal, tax_percentage: 18, tax_amount: total - subtotal, total_amount: total,
    line_items: lineItems,
    status: o.status ?? "finalized", payment_status: o.paid ?? "unpaid", statement_type: "rent",
    due_date: sentDate ? new Date(Date.parse(`${sentDate}T00:00:00Z`) + 7 * 86400e3).toISOString().slice(0, 10) : null,
    proforma_sent_at: sentDate && !o.noStamp ? at(sentDate) : null,
    finalized_at: at(sentDate ?? daysAgo(40)), created_at: at(sentDate ?? daysAgo(40)),
    gst_invoice_number: o.gstNo ? `TWV/SOASEED/${String(++gst).padStart(3, "0")}` : null,
    ...(o.status === "voided" ? { voided_at: at(sentDate ?? daysAgo(40)), voided_by: admin.id, void_reason: "SOASEED seed" } : {}),
    ...(o.status === "discarded" ? { discarded_at: at(daysAgo(40)), discarded_by: admin.id, discard_reason: "SOASEED seed" } : {}),
  }).select("id, statement_number").single(), "statement");
  for (const [ago, amount, mode, tds = 0] of o.pay ?? []) {
    await must(supa.from("billing_payments").insert({
      billing_statement_id: row.id, amount, tds_amount: tds, payment_date: daysAgo(ago), payment_mode: mode,
      payment_reference: `SOASEED-${row.statement_number}`, recorded_by: admin.id,
    }), "payment");
  }
  console.log(`  ${row.statement_number}  ${o.note}`);
}

// Dates below are fixed calendar months for the invoices, relative days for the ones that must age.
c1.rentLabel = "Dedicated desk x2, monthly rent";
c2.rentLabel = "Dedicated desk x2, monthly rent (revised rate)";
console.log("Contract 1 (ended):", c1.contract_number);
await stmt(c1, 2025, 4, 23600, { sentOn: "2025-04-03", gstNo: true, paid: "paid", pay: [[Math.floor((Date.parse(today) - Date.parse("2025-04-10")) / 86400e3), 23600, "bank_transfer"]], note: "FY25-26 GST invoice, paid in full" });
await stmt(c1, 2025, 5, 23600, { items: [["Parking, 1 slot", 1500]], sentOn: "2025-05-03", gstNo: true, paid: "paid", pay: [[Math.floor((Date.parse(today) - Date.parse("2025-05-12")) / 86400e3), 21240, "bank_transfer", 2360]], note: "FY25-26 GST invoice, paid with TDS deducted (21,240 + 2,360)" });
await stmt(c1, 2025, 6, 23600, { sentOn: "2025-06-03", paid: "paid", pay: [[Math.floor((Date.parse(today) - Date.parse("2025-06-08")) / 86400e3), 23600, "upi"]], note: "FY25-26 PI, paid" });
await stmt(c1, 2025, 7, 23600, { sentOn: "2025-07-03", status: "voided", note: "voided (left out)" });
await stmt(c1, 2025, 8, 23600, { sentOn: "2025-08-03", status: "discarded", note: "discarded (left out)" });
await stmt(c1, 2026, 1, 23600, { sentOn: "2026-01-04", gstNo: true, paid: "partially_paid", pay: [[Math.floor((Date.parse(today) - Date.parse("2026-01-15")) / 86400e3), 10000, "upi"]], note: "FY25-26 GST invoice, part paid: balance carries into FY26-27 opening and ages" });
await stmt(c1, 2026, 2, 23600, { sentOn: "2026-02-04", note: "FY25-26 PI, never paid (aged 270+ days)" });
await stmt(c1, 2026, 3, 23600, { sentOn: "2026-03-04", gstNo: true, paid: "paid", pay: [[Math.floor((Date.parse(today) - Date.parse("2026-03-12")) / 86400e3), 23600, "bank_transfer"]], note: "FY25-26 GST invoice, paid" });

console.log("Contract 2 (live):", c2.contract_number);
await stmt(c2, 2026, 4, 29500, { sentOn: "2026-04-03", gstNo: true, paid: "paid", pay: [[Math.floor((Date.parse(today) - Date.parse("2026-04-12")) / 86400e3), 29500, "bank_transfer"]], note: "FY26-27 GST invoice, paid (new rent 29,500)" });
await stmt(c2, 2026, 5, 29500, { sentOn: "2026-05-03", gstNo: true, paid: "paid", pay: [[Math.floor((Date.parse(today) - Date.parse("2026-05-11")) / 86400e3), 29500, "upi"]], note: "FY26-27 GST invoice, paid" });
await stmt(c2, 2026, 6, 29500, { sent: 150, noStamp: true, paid: "paid", pay: [[140, 29500, "bank_transfer"]], note: "paid, no 'sent' stamp: still shown" });
await stmt(c2, 2026, 7, 29500, { items: [["Meeting room, 6 hrs", 2400], ["Printing, 180 pages", 600]], sent: 110, note: "PI pending, 110 days (over 90 bucket)" });
await stmt(c2, 2026, 8, 29500, { sent: 75, note: "PI pending, 75 days (61-90 bucket)" });
await stmt(c2, 2026, 9, 29500, { sent: 50, gstNo: true, paid: "partially_paid", pay: [[40, 15000, "upi"]], note: "GST invoice, part paid, 50 days (31-60 bucket)" });
await stmt(c2, 2026, 10, 29500, { items: [["Parking, 1 slot", 1500], ["Locker rental", 500], ["Meeting room, 4 hrs", 1200], ["Printing, 90 pages", 300], ["Day pass, guest", 500], ["Courier charges", 200]], sent: 28, note: "PI pending, 28 days (0-30 bucket)" });
await stmt(c2, 2026, 11, 29500, { sent: 8, note: "PI pending, 8 days (0-30 bucket)" });
await stmt(c2, 2026, 12, 29500, { note: "finalized but never sent (left out)" });
await stmt(c2, 2027, 1, 29500, { status: "draft", note: "draft (left out)" });

console.log(`\nDone. Lead: http://localhost:3000/leads/${lead.id}`);
