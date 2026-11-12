#!/usr/bin/env node
/**
 * Seeds the STAGING Supabase project with a postpaid partner and two of its
 * Virtual Office cases, so the partner renewal flow can be checked through the
 * UI (Cases → Renewals → Confirm partner, or the case's Renewal tab).
 *
 *   TEST VO Partner Open    active, ends in 20 days, ₹2,500 a month, 5% agreed
 *                           escalation. Confirming records the new term; the
 *                           case rolls over on the term's first day.
 *   TEST VO Partner Ended   ended yesterday, so the new term has already
 *                           begun: confirming rolls it over immediately.
 *
 * Nothing here can contact anyone: @example.com addresses, 90000 phone
 * numbers, and renewal notices turned off on both cases (switch one on from
 * its Renewal tab to see the opt-in flow).
 *
 * Everything it creates is marked as test data and removed by --clear:
 *   aggregators  name "TEST VO Partner", code TESTVOPARTNER
 *   cases        client_name starts with "TEST VO Partner", tag "test-seed"
 *                (including any next-term case created from them)
 *
 * Run with:
 *   node scripts/seed-staging-vo-partner.mjs            seed (clears its own earlier rows first)
 *   node scripts/seed-staging-vo-partner.mjs --clear    remove everything it created
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from
 * .env.staging.local and, like the other seeders, refuses to run against the
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

const iso = (d) => d.toISOString().slice(0, 10);
const today = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
const plusDays = (date, n) => iso(new Date(Date.parse(date) + n * 86_400_000));

async function clear() {
  const cases = check("find cases", await supa.from("cases").select("id").like("client_name", "TEST VO Partner%"));
  const ids = cases.map((c) => c.id);
  if (ids.length) {
    // Each renewed term points at its first case, so remove children before parents.
    check("delete next terms", await supa.from("cases").delete().in("parent_case_id", ids));
    check("delete cases", await supa.from("cases").delete().in("id", ids));
  }
  const aggs = check("find partner", await supa.from("aggregators").select("id").eq("code", "TESTVOPARTNER"));
  if (aggs.length) check("delete partner", await supa.from("aggregators").delete().in("id", aggs.map((a) => a.id)));
  console.log(`Cleared ${ids.length} test cases${aggs.length ? " and the test partner" : ""}.`);
}

const SCENARIOS = [
  { name: "TEST VO Partner Open", endDate: plusDays(iso(today), 20) },
  { name: "TEST VO Partner Ended", endDate: plusDays(iso(today), -1) },
];

async function seed() {
  const loc = check("find location", await supa.from("locations").select("id, name").limit(1).maybeSingle());
  if (!loc) throw new Error("No location on staging — run scripts/seed-staging.mjs first.");

  const partner = check(
    "insert partner",
    await supa
      .from("aggregators")
      .insert({
        name: "TEST VO Partner",
        code: "TESTVOPARTNER",
        company_name: "TEST VO Partner Pvt Ltd",
        billing_method: "postpaid",
        primary_email: "vo-partner@example.com",
        primary_phone: "9000000100",
        tags: ["test-seed"],
      })
      .select("id")
      .single()
  );

  let n = 0;
  for (const s of SCENARIOS) {
    n += 1;
    const d = new Date(Date.parse(s.endDate));
    d.setUTCFullYear(d.getUTCFullYear() - 1);
    const termStart = plusDays(iso(d), 1);
    const row = check(
      `insert ${s.name}`,
      await supa
        .from("cases")
        .insert({
          case_source: "aggregator",
          aggregator_id: partner.id,
          location_id: loc.id,
          status: "active",
          purpose: "business_address",
          client_name: s.name,
          client_entity_type: "pvt_ltd",
          client_company_name: `${s.name} Pvt Ltd`,
          client_email: `vo-partner-${n}@example.com`,
          client_phone: `900000010${n}`,
          rate: 2500,
          tenure_months: 12,
          start_date: termStart,
          end_date: s.endDate,
          activated_at: `${termStart}T05:00:00Z`,
          renewal_escalation_percentage: 5,
          renewal_notices_enabled: false,
          tags: ["test-seed"],
          notes: "Seeded by scripts/seed-staging-vo-partner.mjs for partner renewal testing.",
        })
        .select("id, case_number")
        .single()
    );
    console.log(`${s.name} (${row.case_number ?? row.id}): ends ${s.endDate}, ₹2,500 a month`);
  }
}

await clear();
if (!CLEAR_ONLY) await seed();
