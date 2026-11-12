#!/usr/bin/env node
/**
 * Seeds the STAGING Supabase project with a working admin login and a small
 * set of clearly-fake records (location, leads, proposals, contracts) so
 * local dev and Vercel Preview deploys have something real to click through
 * without ever touching production data.
 *
 * Every email/phone here uses a reserved fake domain (@example.com) or an
 * obviously fake number — even if a bug or a hand-rolled script accidentally
 * triggers a live send against this data, it goes nowhere real.
 *
 * Run with:
 *   node scripts/seed-staging.mjs
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from
 * .env.staging.local (NOT .env.local) — deliberately separate so this can
 * never accidentally be pointed at production by picking up the wrong file.
 * Refuses to run if the target URL's project ref matches production's.
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

const PRODUCTION_REF = "zlbvadtajetylacxevsm"; // hard safety check — never seed this one

function loadEnv(path) {
  const env = {};
  const raw = readFileSync(new URL(path, import.meta.url), "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) {
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      v = v.replace(/\\n$/, "");
      env[m[1]] = v;
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
  console.error(`Refusing to run — this URL points at the PRODUCTION project (${PRODUCTION_REF}). This script only ever runs against staging.`);
  process.exit(1);
}

console.log(`Seeding ${SUPABASE_URL} ...`);
const supa = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false, autoRefreshToken: false } });

async function upsertAdminUser() {
  const email = "admin@staging.theworkvilla.test";
  const password = "StagingAdmin!2026";

  const { data: existing } = await supa.auth.admin.listUsers();
  let authUser = existing?.users?.find((u) => u.email === email);

  if (!authUser) {
    const { data, error } = await supa.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: "Staging Admin" },
    });
    if (error) throw error;
    authUser = data.user;
    console.log(`Created auth user ${email}`);
  } else {
    console.log(`Auth user ${email} already exists`);
  }

  // The on_auth_user_created trigger auto-inserts a public.users row on
  // createUser above (role defaults to sales_rep) — promote it to admin.
  const { data: dbUser, error: userErr } = await supa
    .from("users")
    .update({ role: "admin", full_name: "Staging Admin", is_active: true })
    .eq("auth_id", authUser.id)
    .select("id")
    .maybeSingle();
  if (userErr) throw userErr;

  let userId = dbUser?.id;
  if (!userId) {
    // Trigger may not have fired if the user already existed from a prior partial run.
    const { data: inserted, error: insertErr } = await supa
      .from("users")
      .insert({ auth_id: authUser.id, email, full_name: "Staging Admin", role: "admin" })
      .select("id")
      .single();
    if (insertErr) throw insertErr;
    userId = inserted.id;
  }

  console.log(`Login: ${email} / ${password}`);
  return userId;
}

async function getWorkvillaCompanyId() {
  const { data, error } = await supa.from("companies").select("id").eq("brand_name", "Workvilla").maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Workvilla company row not found — did migration 00539 run?");
  return data.id;
}

async function upsertLocation(companyId) {
  const code = "STG01";
  const { data: existing } = await supa.from("locations").select("id").eq("code", code).maybeSingle();
  if (existing) return existing.id;
  const { data, error } = await supa
    .from("locations")
    .insert({ name: "Staging Test Location", code, address: "123 Fake Street", city: "Chennai", state: "Tamil Nadu", is_active: true, company_id: companyId })
    .select("id")
    .single();
  if (error) throw error;
  console.log("Created location STG01");
  return data.id;
}

async function upsertLead(company, firstName, lastName) {
  const email = `${firstName.toLowerCase()}.${lastName.toLowerCase()}@example.com`;
  const { data: existing } = await supa.from("leads").select("id").eq("email", email).maybeSingle();
  if (existing) return existing.id;
  const { data, error } = await supa
    .from("leads")
    .insert({
      first_name: firstName,
      last_name: lastName,
      company,
      email,
      phone: "9000000000",
      mobile: "9000000000",
      status: "won",
      source: "other",
    })
    .select("id")
    .single();
  if (error) throw error;
  console.log(`Created lead ${company}`);
  return data.id;
}

async function createProposal(leadId, locationId, title, totalAmount) {
  const { data, error } = await supa
    .from("proposals")
    .insert({
      lead_id: leadId,
      location_id: locationId,
      title,
      total_amount: totalAmount,
      status: "accepted",
      payment_status: "paid",
      deposit_payment_status: "paid",
      security_deposit_months: 0,
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

async function createContract({ leadId, proposalId, locationId, title, status, startDate, endDate, totalAmount, createdBy, parentContractId, isRenewal }) {
  const { data, error } = await supa
    .from("contracts")
    .insert({
      lead_id: leadId,
      proposal_id: proposalId,
      location_id: locationId,
      title,
      status,
      billing_cycle: "monthly",
      tenure_months: 3,
      start_date: startDate,
      end_date: endDate,
      seats: 1,
      subtotal: totalAmount,
      total_amount: totalAmount,
      tax_percentage: 18,
      created_by: createdBy,
      parent_contract_id: parentContractId ?? null,
      is_renewal: isRenewal ?? false,
    })
    .select("id, contract_number")
    .single();
  if (error) throw error;
  console.log(`Created contract ${data.contract_number} (${status}) — ${title}`);
  return data;
}

async function disableRazorpay() {
  // Never let a stray test script issue a real payment link from staging.
  const { error } = await supa
    .from("app_settings")
    .upsert({ key: "razorpay_enabled", value: "false" }, { onConflict: "key" });
  if (error) console.warn("Could not set razorpay_enabled=false (table may not exist yet):", error.message);
  else console.log("Razorpay disabled on staging (razorpay_enabled=false)");
}

async function main() {
  const userId = await upsertAdminUser();
  const companyId = await getWorkvillaCompanyId();
  const locationId = await upsertLocation(companyId);
  await disableRazorpay();

  // Scenario 1: a plain active contract
  const lead1 = await upsertLead("Fake Widgets Pvt Ltd", "Test", "Customer");
  const prop1 = await createProposal(lead1, locationId, "Open Desk — Fake Widgets", 15000);
  await createContract({
    leadId: lead1, proposalId: prop1, locationId,
    title: "Open Desk 1 seat", status: "active",
    startDate: "2026-07-01", endDate: "2027-06-30",
    totalAmount: 15000, createdBy: userId,
  });

  // Scenario 2: a renewal_in_progress parent + its (still-draft) renewal
  // child — deliberately reproduces the exact shape that caused the
  // 2026-09-01 incident, so this class of bug can be tested safely here.
  const lead2 = await upsertLead("Renewal Test Co", "Renewal", "Tester");
  const prop2a = await createProposal(lead2, locationId, "Cabin — Renewal Test Co (term 1)", 20000);
  const parent = await createContract({
    leadId: lead2, proposalId: prop2a, locationId,
    title: "Private Cabin 2 seats", status: "renewal_in_progress",
    startDate: "2026-01-01", endDate: "2026-08-31",
    totalAmount: 20000, createdBy: userId,
  });
  const prop2b = await createProposal(lead2, locationId, "Cabin — Renewal Test Co (term 2)", 22000);
  await createContract({
    leadId: lead2, proposalId: prop2b, locationId,
    title: "Private Cabin 2 seats (renewal)", status: "draft",
    startDate: "2026-09-01", endDate: "2027-08-31",
    totalAmount: 22000, createdBy: userId,
    parentContractId: parent.id, isRenewal: true,
  });

  console.log("\nStaging seed complete.");
}

main().catch((e) => {
  console.error("Seed failed:", e);
  process.exit(1);
});
