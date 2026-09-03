#!/usr/bin/env node
/**
 * Seeds the STAGING Supabase project with a spread of /queries threads —
 * every module, every kind, and the awaiting/overdue/resolved/payment-report
 * states the page distinguishes — so the queries UI has something real to
 * click through instead of an empty "nothing waiting on you" page.
 *
 * Reuses whatever seed-staging.mjs already created (the STG01 location, the
 * "Fake Widgets Pvt Ltd" contract/proposal/statement) rather than duplicating
 * it, and adds two more staging users (accounts, sales_rep) since a
 * clarification thread needs more than one actor to look realistic.
 *
 * Run with:
 *   node scripts/seed-staging-queries.mjs
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from
 * .env.staging.local — same safety convention as seed-staging.mjs: refuses
 * to run if the target project ref matches production's.
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

console.log(`Seeding queries into ${SUPABASE_URL} ...`);
const supa = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false, autoRefreshToken: false } });

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}
function dateDaysAgo(n) {
  return daysAgo(n).slice(0, 10);
}

// ── users ────────────────────────────────────────────────────────────────

async function upsertUser(email, fullName, role, password) {
  const { data: existing } = await supa.auth.admin.listUsers();
  let authUser = existing?.users?.find((u) => u.email === email);

  if (!authUser) {
    const { data, error } = await supa.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    });
    if (error) throw error;
    authUser = data.user;
    console.log(`Created auth user ${email}`);
  }

  const { data: dbUser, error: userErr } = await supa
    .from("users")
    .update({ role, full_name: fullName, is_active: true })
    .eq("auth_id", authUser.id)
    .select("id")
    .maybeSingle();
  if (userErr) throw userErr;

  let userId = dbUser?.id;
  if (!userId) {
    const { data: inserted, error: insertErr } = await supa
      .from("users")
      .insert({ auth_id: authUser.id, email, full_name: fullName, role })
      .select("id")
      .single();
    if (insertErr) throw insertErr;
    userId = inserted.id;
  }
  return userId;
}

// ── reused base entities from seed-staging.mjs ──────────────────────────────

async function getContract() {
  const { data, error } = await supa
    .from("contracts")
    .select("id, proposal_id, lead_id, contract_number")
    .eq("contract_number", "TWV-C-0001")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('Contract TWV-C-0001 not found — run "node scripts/seed-staging.mjs" first.');
  return data;
}

async function getOrCreateStatement(contractId, leadId) {
  const { data: existing } = await supa
    .from("billing_statements")
    .select("id")
    .eq("contract_id", contractId)
    .limit(1)
    .maybeSingle();
  if (existing) return existing.id;

  const periodStart = dateDaysAgo(30).slice(0, 8) + "01";
  const { data, error } = await supa
    .from("billing_statements")
    .insert({
      contract_id: contractId,
      lead_id: leadId,
      period_start: periodStart,
      period_end: dateDaysAgo(1),
      fixed_amount: 15000,
      subtotal: 15000,
      total_amount: 17700,
      status: "finalized",
    })
    .select("id")
    .single();
  if (error) throw error;
  console.log("Created a billing statement on TWV-C-0001");
  return data.id;
}

// ── new procurement fixtures ─────────────────────────────────────────────

async function getVendor() {
  const { data, error } = await supa.from("procurement_vendors").select("id, name").limit(1).maybeSingle();
  if (error) throw error;
  if (data) return data;
  const { data: created, error: insertErr } = await supa
    .from("procurement_vendors")
    .insert({ name: "QA Test Vendor", category: "general" })
    .select("id, name")
    .single();
  if (insertErr) throw insertErr;
  return created;
}

async function upsertVendorBill(vendorId, createdBy, companyId) {
  const billNumber = "QA-BILL-01";
  const { data: existing } = await supa.from("vendor_bills").select("id").eq("bill_number", billNumber).maybeSingle();
  if (existing) return existing.id;
  const { data, error } = await supa
    .from("vendor_bills")
    .insert({
      bill_number: billNumber,
      vendor_id: vendorId,
      invoice_number: "INV-QA-01",
      invoice_date: dateDaysAgo(20),
      total_amount: 8500,
      payment_status: "unpaid",
      created_by: createdBy,
      company_id: companyId,
    })
    .select("id")
    .single();
  if (error) throw error;
  console.log("Created vendor bill QA-BILL-01");
  return data.id;
}

async function upsertPurchaseRequest(requestedBy, locationId, companyId) {
  const prNumber = "QA-PR-01";
  const { data: existing } = await supa.from("purchase_requests").select("id").eq("pr_number", prNumber).maybeSingle();
  if (existing) return existing.id;
  const { data, error } = await supa
    .from("purchase_requests")
    .insert({
      pr_number: prNumber,
      department: "administration",
      location_id: locationId,
      status: "submitted",
      requested_by: requestedBy,
      total_estimated_amount: 3200,
      company_id: companyId,
    })
    .select("id")
    .single();
  if (error) throw error;
  console.log("Created purchase request QA-PR-01");
  return data.id;
}

// ── query thread helper ──────────────────────────────────────────────────

/**
 * Every scenario is tagged with a unique template_key ("qa_seed_...") purely
 * as a seed marker — not a real canned-question key — so re-running this
 * script is a no-op instead of creating duplicates.
 */
async function upsertQuery({
  marker,
  entityType,
  entityId,
  kind = "question",
  audience = "all",
  audienceRoles = [],
  audienceUserIds = [],
  createdBy,
  createdAt,
  neededBy,
  openingBody,
  reply,
  resolve,
  paymentReport,
}) {
  const { data: existing } = await supa.from("queries").select("id").eq("template_key", marker).maybeSingle();
  if (existing) {
    console.log(`Skipping ${marker} (already seeded)`);
    return existing.id;
  }

  const { data: q, error: qErr } = await supa
    .from("queries")
    .insert({
      entity_type: entityType,
      entity_id: entityId,
      kind,
      audience,
      audience_roles: audienceRoles,
      audience_user_ids: audienceUserIds,
      created_by: createdBy,
      template_key: marker,
      needed_by: neededBy ?? null,
      created_at: createdAt,
      updated_at: reply?.createdAt ?? resolve?.at ?? createdAt,
      status: resolve ? "resolved" : "open",
      resolved_by: resolve?.by ?? null,
      resolved_at: resolve?.at ?? null,
    })
    .select("id")
    .single();
  if (qErr) throw qErr;

  await supa.from("query_messages").insert({
    query_id: q.id,
    event_type: "message",
    body: openingBody,
    created_by: createdBy,
    created_at: createdAt,
  });

  if (reply) {
    await supa.from("query_messages").insert({
      query_id: q.id,
      event_type: "message",
      body: reply.body,
      created_by: reply.by,
      created_at: reply.createdAt,
    });
  }

  if (resolve) {
    await supa.from("query_messages").insert({
      query_id: q.id,
      event_type: resolve.eventType ?? "resolved",
      body: resolve.body ?? null,
      created_by: resolve.by,
      created_at: resolve.at,
    });
  }

  if (paymentReport) {
    const { error: prErr } = await supa.from("query_payment_reports").insert({
      query_id: q.id,
      amount: paymentReport.amount,
      paid_on: paymentReport.paidOn,
      payment_mode: paymentReport.paymentMode,
      payment_reference: paymentReport.paymentReference ?? null,
      status: paymentReport.status,
      resolution_note: paymentReport.resolutionNote ?? null,
      reviewed_by: paymentReport.reviewedBy ?? null,
      reviewed_at: paymentReport.reviewedAt ?? null,
      created_by: createdBy,
      created_at: createdAt,
    });
    if (prErr) throw prErr;
  }

  console.log(`Created ${marker}`);
  return q.id;
}

async function main() {
  const adminId = (await supa.from("users").select("id").eq("email", "admin@staging.theworkvilla.test").single()).data.id;
  const accountsId = await upsertUser("accounts@staging.theworkvilla.test", "Staging Accounts", "accounts", "StagingAccounts!2026");
  const salesId = await upsertUser("sales@staging.theworkvilla.test", "Staging Sales", "sales_rep", "StagingSales!2026");

  const { data: company, error: companyErr } = await supa
    .from("companies")
    .select("id")
    .eq("brand_name", "Workvilla")
    .maybeSingle();
  if (companyErr) throw companyErr;
  const companyId = company.id;

  const contract = await getContract();
  const statementId = await getOrCreateStatement(contract.id, contract.lead_id);
  const vendor = await getVendor();
  const billId = await upsertVendorBill(vendor.id, accountsId, companyId);
  const prId = await upsertPurchaseRequest(salesId, null, companyId);

  // 1. Billing · open question, audience all — awaiting everyone including admin.
  await upsertQuery({
    marker: "qa_seed_billing_open",
    entityType: "billing_statement",
    entityId: statementId,
    kind: "question",
    audience: "all",
    createdBy: accountsId,
    createdAt: daysAgo(1),
    openingBody: "Which ledger head should this statement's usage charges be booked to in Tally?",
  });

  // 2. Payables · action needed, targeted at admin, overdue.
  await upsertQuery({
    marker: "qa_seed_bill_overdue",
    entityType: "vendor_bill",
    entityId: billId,
    kind: "action_needed",
    audience: "roles",
    audienceRoles: ["admin"],
    createdBy: accountsId,
    createdAt: daysAgo(6),
    neededBy: dateDaysAgo(3),
    openingBody: "This bill's total doesn't match the approved PO amount — need a decision before I can pay it.",
  });

  // 3. Payables · answered but never closed (the "needs closing" clutter case).
  await upsertQuery({
    marker: "qa_seed_bill_answered",
    entityType: "vendor_bill",
    entityId: billId,
    kind: "question",
    audience: "all",
    createdBy: adminId,
    createdAt: daysAgo(9),
    openingBody: "Which TDS section applies to this bill, and at what rate?",
    reply: { body: "Section 194C, 2% — standard contractor rate for this vendor.", by: accountsId, createdAt: daysAgo(8) },
  });

  // 4. Procurement · resolved this week.
  await upsertQuery({
    marker: "qa_seed_pr_resolved",
    entityType: "purchase_request",
    entityId: prId,
    kind: "question",
    audience: "all",
    createdBy: salesId,
    createdAt: daysAgo(2),
    openingBody: "Is this request still needed, or can it be closed?",
    reply: { body: "Still needed — approving today.", by: adminId, createdAt: daysAgo(1) },
    resolve: { by: adminId, at: daysAgo(1), eventType: "resolved" },
  });

  // 5. Contracts · targeted directly at admin ("→ You").
  await upsertQuery({
    marker: "qa_seed_contract_targeted",
    entityType: "contract",
    entityId: contract.id,
    kind: "question",
    audience: "users",
    audienceUserIds: [adminId],
    createdBy: salesId,
    createdAt: daysAgo(1),
    openingBody: "This contract is approaching its end date — is it renewing, and on what terms?",
  });

  // 6. Tally Inbox (deposit) · targeted at sales_rep only — visible to admin,
  //    but not in admin's "Awaiting you".
  await upsertQuery({
    marker: "qa_seed_deposit_targeted_role",
    entityType: "proposal_deposit",
    entityId: contract.proposal_id,
    kind: "action_needed",
    audience: "roles",
    audienceRoles: ["sales_rep"],
    createdBy: accountsId,
    createdAt: daysAgo(4),
    openingBody: "The deposit collected is less than the contract calls for — was a waiver approved?",
  });

  // 7. Payments reported · open, addressed to admin + accounts (the case
  //    PR #656 fixes — this is what should now show in admin's Awaiting you).
  await upsertQuery({
    marker: "qa_seed_payment_report_open",
    entityType: "contract",
    entityId: contract.id,
    kind: "payment_reported",
    audience: "roles",
    audienceRoles: ["admin", "accounts"],
    createdBy: salesId,
    createdAt: daysAgo(1),
    openingBody: "Customer reports paying ₹9,440 · UPI · " + dateDaysAgo(1) + ". Please confirm receipt.",
    paymentReport: {
      amount: 9440,
      paidOn: dateDaysAgo(1),
      paymentMode: "upi",
      paymentReference: "QA-UTR-001",
      status: "reported",
    },
  });

  // 8. Payments reported · resolved as "no such payment".
  await upsertQuery({
    marker: "qa_seed_payment_report_rejected",
    entityType: "billing_statement",
    entityId: statementId,
    kind: "payment_reported",
    audience: "roles",
    audienceRoles: ["admin", "accounts"],
    createdBy: salesId,
    createdAt: daysAgo(5),
    openingBody: "Customer reports paying ₹17,700 · NEFT · " + dateDaysAgo(5) + ".",
    resolve: {
      by: accountsId,
      at: daysAgo(4),
      eventType: "payment_rejected",
      body: "No matching credit in the bank for this amount/date — checked with the customer, they sent the wrong screenshot.",
    },
    paymentReport: {
      amount: 17700,
      paidOn: dateDaysAgo(5),
      paymentMode: "neft",
      status: "rejected",
      resolutionNote: "No matching bank credit found; customer confirmed wrong screenshot.",
      reviewedBy: accountsId,
      reviewedAt: daysAgo(4),
    },
  });

  console.log("\nQueries seed complete. Logins:");
  console.log("  admin@staging.theworkvilla.test / StagingAdmin!2026");
  console.log("  accounts@staging.theworkvilla.test / StagingAccounts!2026");
  console.log("  sales@staging.theworkvilla.test / StagingSales!2026");
}

main().catch((e) => {
  console.error("Seed failed:", e);
  process.exit(1);
});
