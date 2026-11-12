#!/usr/bin/env node
/**
 * Seeds the STAGING Supabase project with contracts covering every scenario of
 * the contract exit workflow: deposit covers the charges, deposit short of the
 * charges, no deposit, a normal end-of-term exit, last day today, last day in
 * the future, a completed exit, and a live contract with no exit started.
 *
 * Idempotent: each scenario is keyed by its contract title ("EXITSEED ...");
 * re-running skips scenarios that already exist. Pass --reset to remove the
 * seeded exits, charges and invoices first and rebuild them.
 *
 *   node scripts/seed-staging-exits.mjs [--reset]
 *
 * Reads .env.staging.local (never .env.local) and refuses to run against the
 * production project. Every email is @example.com, so nothing reaches a real
 * customer even if a send were triggered.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

const PRODUCTION_REF = "zlbvadtajetylacxevsm";
const TAG = "EXITSEED";

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

const istToday = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
const offset = (days) => new Date(new Date(`${istToday()}T00:00:00Z`).getTime() + days * 86400e3).toISOString().slice(0, 10);

async function must(q, what) { const { data, error } = await q; if (error) throw new Error(`${what}: ${error.message}`); return data; }

const admin = await must(supa.from("users").select("id").eq("role", "admin").limit(1).maybeSingle(), "admin user");
const location = await must(supa.from("locations").select("id").eq("code", "STG01").maybeSingle(), "STG01 location");
if (!admin || !location) { console.error('Run "node scripts/seed-staging.mjs" first.'); process.exit(1); }

const SCENARIOS = [
  { key: "A", company: "Exit A - deposit covers", deposit: 100000, endIn: 150, invoices: [7080, 7080], usage: 2000, exit: null,
    note: "Live contract, no exit yet: use Start exit" },
  { key: "B", company: "Exit B - early exit with charges", deposit: 100000, endIn: 150, invoices: [7080, 7080], usage: 2000,
    exit: { noticeAgo: 10, lastIn: 20, charges: [["breakage", "Chair, 2 units", 7000], ["painting", "Cabin 2 wall", 8000], ["missing_item", "Key card", 500], ["extra_use", "Printing, Oct", 1200]] },
    note: "In notice, early exit, 4 charges, last day in 20 days (Complete exit disabled)" },
  { key: "C", company: "Exit C - shortfall", deposit: 30000, endIn: 120, invoices: [14160], usage: 0,
    exit: { noticeAgo: 5, lastIn: 15, charges: [["breakage", "Glass partition", 15000], ["painting", "Full cabin", 8000], ["other", "Deep clean", 3000]] },
    note: "Charges and invoice exceed the deposit: customer owes" },
  { key: "D", company: "Exit D - no deposit", deposit: 0, endIn: 100, invoices: [], usage: 0,
    exit: { noticeAgo: 3, lastIn: 12, charges: [["breakage", "Table", 5000]] }, note: "No deposit held: customer owes 5,000" },
  { key: "E", company: "Exit E - end of term", deposit: 50000, endIn: 25, invoices: [], usage: 0,
    exit: { noticeAgo: 32, lastIn: 25, charges: [] }, note: "Last day equals contract end: not an early exit" },
  { key: "F", company: "Exit F - last day today", deposit: 50000, endIn: 90, invoices: [3540], usage: 500,
    exit: { noticeAgo: 30, lastIn: 0, charges: [["extra_use", "Printing", 900]] }, note: "Last day is today: Complete exit enabled" },
  { key: "H", company: "Exit H - pooled deposit", deposit: 50000, endIn: 90, invoices: [], usage: 0, sibling: true,
    exit: { noticeAgo: 4, lastIn: 15, charges: [["breakage", "Chair", 2000]] },
    note: "Customer's other live contract still needs its deposit: nothing refundable from the pool" },
  { key: "I", company: "Exit I - ready to clear, refund", deposit: 100000, endIn: 60, invoices: [], usage: 0,
    exit: { noticeAgo: 40, lastIn: -3, completed: true, inspectionDone: true, charges: [["breakage", "Chairs", 7000], ["painting", "Cabin walls", 8000], ["missing_item", "Key cards", 1700]] },
    note: "Completed, inspected, clean: send for approval, refund 83,300" },
  { key: "J", company: "Exit J - ready to clear, owes", deposit: 30000, endIn: 60, invoices: [], usage: 0,
    exit: { noticeAgo: 40, lastIn: -3, completed: true, inspectionDone: true, charges: [["breakage", "Partition", 25000], ["painting", "Whole floor", 15000]] },
    note: "Completed, inspected, clean: deposit covers 30,000 of 40,000, customer owes 10,000" },
  { key: "K", company: "Exit K - ready to clear, no charges", deposit: 20000, endIn: 60, invoices: [], usage: 0,
    exit: { noticeAgo: 40, lastIn: -3, completed: true, inspectionDone: true, charges: [] },
    note: "Completed, inspected, no charges: full 20,000 refund" },
  { key: "L", company: "Exit L - blocked by invoice", deposit: 50000, endIn: 60, invoices: [5900], usage: 0,
    exit: { noticeAgo: 40, lastIn: -3, completed: true, inspectionDone: true, charges: [["other", "Clean", 1000]] },
    note: "Completed and inspected but an unpaid invoice blocks clearing" },
  { key: "G", company: "Exit G - completed", deposit: 40000, endIn: 60, invoices: [], usage: 0,
    exit: { noticeAgo: 40, lastIn: -2, completed: true, charges: [["painting", "Wall", 6000]] },
    note: "Contract terminated, exit completed; charges can still be added" },
];

async function wipe() {
  const contracts = await must(supa.from("contracts").select("id").like("title", `${TAG}%`), "find seeded contracts");
  const ids = contracts.map((c) => c.id);
  if (ids.length === 0) return;
  await supa.from("exit_settlements").delete().in("contract_id", ids);
  await supa.from("contract_exits").delete().in("contract_id", ids);
  await supa.from("usage_charges").delete().in("contract_id", ids);
  await supa.from("billing_statements").delete().in("contract_id", ids);
  await supa.from("contracts").delete().in("id", ids);
  const leads = await must(supa.from("leads").select("id").like("email", "exitseed.%@example.com"), "find seeded leads");
  const lids = leads.map((l) => l.id);
  if (lids.length) { await supa.from("proposals").delete().in("lead_id", lids); await supa.from("leads").delete().in("id", lids); }
  console.log(`Removed ${ids.length} seeded contracts`);
}

if (process.argv.includes("--reset")) await wipe();

for (const s of SCENARIOS) {
  const title = `${TAG} ${s.key} ${s.company}`;
  const existing = await must(supa.from("contracts").select("id, contract_number").eq("title", title).maybeSingle(), "lookup");
  if (existing) { console.log(`${s.key}: exists (${existing.contract_number}), skipped`); continue; }

  const email = `exitseed.${s.key.toLowerCase()}@example.com`;
  const lead = await must(supa.from("leads").insert({
    first_name: "Exit", last_name: s.key, company: s.company, email, phone: "9000000000", mobile: "9000000000", status: "won", source: "other",
  }).select("id").single(), "lead");

  const proposal = await must(supa.from("proposals").insert({
    lead_id: lead.id, location_id: location.id, title: title, total_amount: 20000, status: "accepted", payment_status: "paid",
    security_deposit_months: s.deposit > 0 ? 2 : 0, security_deposit_amount: s.deposit,
    deposit_payment_status: s.deposit > 0 ? "paid" : "not_required", deposit_payment_amount: s.deposit > 0 ? s.deposit : null,
  }).select("id").single(), "proposal");

  const status = s.exit?.completed ? "terminated" : "active";
  const contract = await must(supa.from("contracts").insert({
    lead_id: lead.id, proposal_id: proposal.id, location_id: location.id, title, status,
    billing_cycle: "monthly", tenure_months: 12, start_date: offset(-120), end_date: offset(s.endIn), seats: 2,
    subtotal: 20000, total_amount: 23600, tax_percentage: 18, created_by: admin.id,
    // Deposits are contract-owned (migration 00500): get_deposit_available_balance reads these.
    security_deposit_months: s.deposit > 0 ? 2 : 0, security_deposit_amount: s.deposit,
    deposit_payment_status: s.deposit > 0 ? "paid" : "not_required", deposit_payment_amount: s.deposit > 0 ? s.deposit : null,
    lock_in_months: 6, notice_period_months: 1,
    activated_at: new Date(Date.now() - 120 * 86400e3).toISOString(),
    ...(s.exit?.completed ? { terminated_at: new Date().toISOString(), termination_reason: "Exit: seed" } : {}),
  }).select("id, contract_number").single(), "contract");

  for (const [i, amt] of s.invoices.entries()) {
    await must(supa.from("billing_statements").insert({
      contract_id: contract.id, lead_id: lead.id, period_start: offset(-60 - i * 30), period_end: offset(-31 - i * 30),
      fixed_amount: amt, subtotal: amt, total_amount: amt, status: "finalized", payment_status: "unpaid", due_date: offset(-10),
    }), "statement");
  }
  if (s.usage > 0) {
    await must(supa.from("usage_charges").insert({
      contract_id: contract.id, lead_id: lead.id, description: "Printing (seed)", quantity: 1, unit_price: s.usage, total: s.usage,
      charge_date: offset(-3), status: "pending",
    }), "usage");
  }

  if (s.sibling) {
    // A second live contract of the same customer whose own deposit is still unpaid,
    // so it relies on the pool the exiting contract contributed to.
    await must(supa.from("contracts").insert({
      lead_id: lead.id, proposal_id: proposal.id, location_id: location.id, title: `${TAG} ${s.key}2 ${s.company} (sibling)`, status: "active",
      billing_cycle: "monthly", tenure_months: 12, start_date: offset(-30), end_date: offset(330), seats: 1,
      subtotal: 10000, total_amount: 11800, tax_percentage: 18, created_by: admin.id,
      security_deposit_months: 2, security_deposit_amount: 50000, deposit_payment_status: "pending",
      activated_at: new Date(Date.now() - 30 * 86400e3).toISOString(),
    }), "sibling contract");
  }

  if (s.exit) {
    const last = offset(s.exit.lastIn);
    const row = await must(supa.from("contract_exits").insert({
      contract_id: contract.id, status: s.exit.completed ? "completed" : "in_notice",
      notice_received_on: offset(-s.exit.noticeAgo), last_day: last, reason: "Relocating to own office (seed)",
      is_early_exit: last < offset(s.endIn), started_by: admin.id,
      ...(s.exit.completed ? { completed_at: new Date().toISOString(), completed_by: admin.id } : {}),
      ...(s.exit.inspectionDone ? { inspection_done_at: new Date().toISOString(), inspection_done_by: admin.id } : {}),
    }).select("id").single(), "exit");
    for (const [type, desc, amt] of s.exit.charges) {
      await must(supa.from("contract_exit_charges").insert({ exit_id: row.id, charge_type: type, description: desc, amount: amt, added_by: admin.id }), "charge");
    }
  }
  console.log(`${s.key}: ${contract.contract_number}  ${s.note}`);
}
console.log("Done.");
