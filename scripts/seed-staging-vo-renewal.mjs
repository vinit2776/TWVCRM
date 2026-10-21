#!/usr/bin/env node
/**
 * Seeds the STAGING Supabase project with Virtual Office cases that have an
 * unpaid renewal bill, so renewal completion can be checked through the UI:
 * record a bank payment on the bill (Accounting → Receivables) and watch the
 * case renew.
 *
 *   TEST VO Renewal Due      direct client, ends in 25 days, renewal bill unpaid.
 *                            Recording the payment should move the case to
 *                            Active with the next 12-month term and the
 *                            escalated fee saved as its rate.
 *   TEST VO Grace Late Pay   ended 5 days ago, in grace. Paying late must still
 *                            start the new term the day after the old end.
 *   TEST VO Month End        ends on the last day of next month, 1-month term.
 *                            The new term must end on the following month's
 *                            last day (the old code overflowed into the month
 *                            after).
 *   TEST VO Legacy Bill      bill issued the old way (period starts on the old
 *                            end date). Must still renew.
 *
 * Nothing here can contact anyone: every case has renewal notices turned off,
 * @example.com addresses and 90000 phone numbers, and the bills carry no
 * Razorpay link.
 *
 * Everything it creates is marked as test data and removed by --clear:
 *   cases               client_name starts with "TEST VO", tag "test-seed"
 *   billing_statements  the vo_renewal bills (and payments) on those cases
 *
 * Run with:
 *   node scripts/seed-staging-vo-renewal.mjs            seed (clears its own earlier rows first)
 *   node scripts/seed-staging-vo-renewal.mjs --clear    remove everything it created
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from
 * .env.staging.local and, like seed-staging.mjs, refuses to run against the
 * production project.
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

const PRODUCTION_REF = "zlbvadtajetylacxevsm"; // hard safety check: never seed this one

function loadEnv(path) {
  const env = {};
  const raw = readFileSync(new URL(path, import.meta.url), "utf8");
  for (const line of raw.split("\n")) {
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
const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.staging.local");
  process.exit(1);
}
if (SUPABASE_URL.includes(PRODUCTION_REF)) {
  console.error(`Refusing to run: this URL points at the PRODUCTION project (${PRODUCTION_REF}). This script only ever runs against staging.`);
  process.exit(1);
}

const supa = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false, autoRefreshToken: false } });
const CLEAR_ONLY = process.argv.includes("--clear");

function check(label, { data, error }) {
  if (error) throw new Error(`${label}: ${error.message}`);
  return data;
}

// Date strings in UTC, matching src/lib/vo-renewal-term.ts.
const iso = (d) => d.toISOString().slice(0, 10);
const today = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
const plusDays = (date, n) => iso(new Date(Date.parse(date) + n * 86_400_000));
const lastDayOfMonth = (offset) =>
  iso(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + offset + 1, 0)));

// ─── Clear ───────────────────────────────────────────────────────────────────
async function clear() {
  const cases = check(
    "find cases",
    await supa.from("cases").select("id").like("client_name", "TEST VO%").contains("tags", ["test-seed"])
  );
  const ids = cases.map((c) => c.id);
  if (ids.length === 0) return;
  const stmts = check("find bills", await supa.from("billing_statements").select("id").in("case_id", ids));
  const stmtIds = stmts.map((s) => s.id);
  if (stmtIds.length) {
    check("delete payments", await supa.from("billing_payments").delete().in("billing_statement_id", stmtIds));
    check("delete bills", await supa.from("billing_statements").delete().in("id", stmtIds));
  }
  check("delete cases", await supa.from("cases").delete().in("id", ids));
  console.log(`Cleared ${ids.length} test cases and ${stmtIds.length} bills.`);
}

// ─── Seed ────────────────────────────────────────────────────────────────────
const SCENARIOS = [
  { name: "TEST VO Renewal Due", status: "renewal_due", endDate: plusDays(iso(today), 25), tenure: 12, rate: 18000, escalation: 10, legacy: false },
  { name: "TEST VO Grace Late Pay", status: "grace_period", endDate: plusDays(iso(today), -5), tenure: 12, rate: 15000, escalation: 0, legacy: false },
  { name: "TEST VO Month End", status: "renewal_due", endDate: lastDayOfMonth(1), tenure: 1, rate: 2000, escalation: 0, legacy: false },
  { name: "TEST VO Legacy Bill", status: "renewal_due", endDate: plusDays(iso(today), 20), tenure: 12, rate: 16000, escalation: 0, legacy: true },
];

async function seed() {
  const loc = check("find location", await supa.from("locations").select("id, name").limit(1).maybeSingle());
  if (!loc) throw new Error("No location on staging — run scripts/seed-staging.mjs first.");

  let n = 0;
  for (const s of SCENARIOS) {
    n += 1;
    const termStart = (() => {
      // The current term: tenure months back from the end, plus a day.
      const d = new Date(Date.parse(s.endDate));
      d.setUTCMonth(d.getUTCMonth() - s.tenure);
      return plusDays(iso(d), 1);
    })();

    const caseRow = check(
      `insert ${s.name}`,
      await supa
        .from("cases")
        .insert({
          case_source: "direct",
          aggregator_id: null,
          location_id: loc.id,
          status: s.status,
          purpose: "business_address",
          client_name: s.name,
          client_entity_type: "pvt_ltd",
          client_company_name: `${s.name} Pvt Ltd`,
          client_email: `vo-renewal-${n}@example.com`,
          client_phone: `900000000${n}`,
          rate: s.rate,
          tenure_months: s.tenure,
          start_date: termStart,
          end_date: s.endDate,
          renewal_escalation_percentage: s.escalation,
          renewal_notices_enabled: false,
          renewal_grace_ends_at: s.status === "grace_period" ? plusDays(s.endDate, 7) : null,
          tags: ["test-seed"],
          notes: "Seeded by scripts/seed-staging-vo-renewal.mjs for renewal-completion testing.",
        })
        .select("id, case_number")
        .single()
    );

    const fee = s.escalation ? Math.round(s.rate * (1 + s.escalation / 100)) : s.rate;
    const tax = Math.round(fee * 18) / 100;
    const periodStart = s.legacy ? s.endDate : plusDays(s.endDate, 1);
    const periodEnd = (() => {
      const d = new Date(Date.parse(s.endDate));
      const isMonthEnd = plusDays(s.endDate, 1).endsWith("-01");
      if (isMonthEnd) return iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + s.tenure + 1, 0)));
      d.setUTCMonth(d.getUTCMonth() + s.tenure);
      return iso(d);
    })();

    const stmt = check(
      `bill for ${s.name}`,
      await supa
        .from("billing_statements")
        .insert({
          case_id: caseRow.id,
          period_start: periodStart,
          period_end: periodEnd,
          due_date: plusDays(iso(today), 7),
          statement_type: "vo_renewal",
          fixed_amount: fee,
          usage_amount: 0,
          service_usage_amount: 0,
          booking_usage_amount: 0,
          subtotal: fee,
          tax_percentage: 18,
          tax_amount: tax,
          cgst_amount: tax / 2,
          sgst_amount: tax / 2,
          igst_amount: 0,
          total_amount: fee + tax,
          is_interstate: false,
          place_of_supply: "Tamil Nadu",
          status: "finalized",
          finalized_at: new Date().toISOString(),
          payment_status: "unpaid",
          line_items: [
            {
              type: "prepaid_rent",
              label: "Virtual Office Renewal",
              subtotal: fee,
              items: [{ description: `TEST Virtual Office Renewal · ${periodStart} to ${periodEnd}`, quantity: 1, rate: fee, amount: fee }],
            },
          ],
          reference_note: `TEST-PI-${n}`,
        })
        .select("id, statement_number")
        .single()
    );

    check(
      "link bill to case",
      await supa.from("cases").update({ renewal_billing_statement_id: stmt.id }).eq("id", caseRow.id)
    );

    console.log(
      `${s.name} (${caseRow.case_number ?? caseRow.id}): ends ${s.endDate}, bill ${stmt.statement_number ?? stmt.id} ` +
        `₹${fee + tax} for ${periodStart} to ${periodEnd}`
    );
  }
}

await clear();
if (!CLEAR_ONLY) await seed();
