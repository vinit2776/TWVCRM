#!/usr/bin/env node
/**
 * Seeds the STAGING Supabase project with leads for clicking through the Leads rework
 * (docs/plans/leads-enquiry-rework-build-plan.md):
 *
 *   Requirements   a lead that asked about two centres and two seat types, with tenure, start date,
 *                  quoted price, an "other" area and extras (migration 00735)
 *   Quiet leads    contacted leads whose last touch was 3, 9 and 21 days ago with an overdue next step
 *   Tours          one later today, one tomorrow, one yesterday with no outcome (needs an update)
 *   Closed         a lost lead with a reason and a junk lead with a junk reason (00735, 00736)
 *
 * Not seeded yet: parked ("waiting for space") leads and hand-over jobs, because the columns they
 * need arrive in later phases. Extend this script in those PRs.
 *
 * Everything carries the tag "leads-rework-seed" and a [TEST] description, uses @example.com
 * addresses and 9000000xxx phones, and is removed by --clear. The tag is deliberately not
 * "test-seed", so this script and seed-staging-enquiry-flow.mjs never clear each other's rows.
 *
 * Run with:
 *   node scripts/seed-staging-leads-rework.mjs            seed (clears its own earlier rows first)
 *   node scripts/seed-staging-leads-rework.mjs --clear    remove everything it created
 *
 * Needs migrations 00735 and 00736 applied on staging and scripts/seed-staging.mjs run once. Reads
 * .env.staging.local and, like the other seeders, refuses to run against the production project.
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

const PRODUCTION_REF = "zlbvadtajetylacxevsm"; // hard safety check: never seed this one
const TAG = "leads-rework-seed";

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

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const ahead = (ms) => new Date(Date.now() + ms).toISOString();

function check(label, { data, error }) {
  if (error) throw new Error(`${label}: ${error.message}`);
  return data;
}

async function clear() {
  const leads = check("find leads", await supa.from("leads").select("id").contains("tags", [TAG]));
  const ids = leads.map((l) => l.id);
  if (ids.length > 0) {
    check("delete activities", await supa.from("activities").delete().in("lead_id", ids));
    check("delete leads", await supa.from("leads").delete().in("id", ids));
  }
}

if (CLEAR_ONLY) {
  console.log(`Removing seeded leads from ${SUPABASE_URL} ...`);
  await clear();
  console.log("Done.");
  process.exit(0);
}

console.log(`Seeding leads for the Leads rework into ${SUPABASE_URL} ...`);
await clear();

const admin = check("find admin", await supa.from("users").select("id").eq("email", "admin@staging.theworkvilla.test").maybeSingle());
if (!admin) throw new Error("Staging admin user not found. Run scripts/seed-staging.mjs first.");
const locations = check("locations", await supa.from("locations").select("id, name").order("name").limit(2));
if (locations.length < 2) throw new Error("Need at least two locations on staging. Run scripts/seed-staging.mjs first.");
const [locA, locB] = locations;

const base = { rating: "none", score: 0, tags: [TAG], assigned_to: admin.id, created_by: admin.id };
const lead = async (row) => check(`lead ${row.last_name}`, await supa.from("leads").insert({ ...base, ...row }).select("id").single()).id;

// ─── Requirements: several centres and types, with the new fields ────────────
const multi = await lead({
  first_name: "TEST", last_name: "Multi requirement", email: "multi.requirement@example.com", mobile: "9000000501",
  source: "inbound_call", status: "contacted", description: "[TEST] Asked about two centres and two seat types",
  location_id: locA.id, location_ids: [locA.id, locB.id], workspace_type: "dedicated_desk", workspace_types: ["dedicated_desk", "hot_desk"],
  seat_capacity: 8, budget_per_seat: 9000, quoted_per_seat: 9500, tenure_months: 6,
  start_date: new Date(Date.now() + 14 * DAY).toISOString().slice(0, 10),
  other_area: "Indiranagar", extras: ["parking", "access_24x7"],
});

// ─── Quiet leads: last touch 3, 9 and 21 days ago, next step overdue ─────────
async function quiet(key, mobile, days) {
  const id = await lead({
    first_name: "TEST", last_name: `Quiet ${days} days`, email: `quiet.${key}@example.com`, mobile,
    source: "referral", status: "contacted", description: "[TEST] No reply since the last call",
    location_id: locA.id, workspace_type: "hot_desk", seat_capacity: 2,
  });
  check("quiet call", await supa.from("activities").insert({
    lead_id: id, type: "call", subject: "Call", description: "[TEST] Spoke, said they will confirm", call_outcome: "connected",
    created_by: admin.id, created_at: ago(days * DAY), follow_up_date: ago((days - 1) * DAY), follow_up_notes: "[TEST] Check if they decided",
  }));
  return id;
}
await quiet("3", "9000000502", 3);
await quiet("9", "9000000503", 9);
await quiet("21", "9000000504", 21);

// ─── Tours: later today, tomorrow, and yesterday with no outcome ─────────────
async function tour(key, mobile, startMs, label) {
  const id = await lead({
    first_name: "TEST", last_name: `Tour ${label}`, email: `tour.${key}@example.com`, mobile,
    source: "referral", status: "tour_scheduled", description: "[TEST] Tour booked",
    location_id: locA.id, workspace_type: "private_office", seat_capacity: 5,
  });
  check("tour", await supa.from("activities").insert({
    lead_id: id, type: "tour", subject: `Tour (${label})`, description: "[TEST] Site visit", created_by: admin.id,
    tour_host_id: admin.id, meeting_start_at: new Date(startMs).toISOString(), meeting_end_at: new Date(startMs + HOUR).toISOString(),
    meeting_location: locA.name,
  }));
  return id;
}
await tour("today", "9000000505", Date.now() + 4 * HOUR, "later today");
await tour("tomorrow", "9000000506", Date.now() + DAY, "tomorrow");
await tour("missed", "9000000507", Date.now() - DAY, "yesterday, no outcome");

// ─── Closed: lost with a reason, junk with a reason ──────────────────────────
await lead({
  first_name: "TEST", last_name: "Lost on price", email: "lost.price@example.com", mobile: "9000000508",
  source: "referral", status: "lost", lost_reason: "budget", lost_at: ago(5 * DAY), description: "[TEST] Found a cheaper place",
  location_id: locA.id, workspace_type: "hot_desk", seat_capacity: 1,
});
await lead({
  first_name: "TEST", last_name: "Job seeker", email: "job.seeker@example.com", mobile: "9000000509",
  source: "whatsapp", status: "junk", junk_reason: "job_seeker", description: "[TEST] Asking about vacancies",
});

console.log(`Done. 9 leads tagged "${TAG}" (multi-requirement ${multi}). Remove with --clear.`);
