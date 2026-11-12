#!/usr/bin/env node
/**
 * Seeds the STAGING Supabase project with sample data for the WhatsApp enquiry, complaint and
 * request screens, so a preview click-through has something real on every page:
 *
 *   Enquiry Log     unnamed WhatsApp lead with a suggested name, a "Needs review" enquiry, a
 *                   stashed spam enquiry (Spam filter), a claimed Google Ads enquiry with an
 *                   overdue next step and a History, an unclaimed Meta Ads enquiry, and enquiries
 *                   on existing staging leads that show the Booked, Proposal sent and Active
 *                   customer stages
 *   Complaints &    two complaints (one new, one waiting on information with a reply history), one
 *   requests        complaint with a linked work order, and four requests (an overdue invoice
 *                   copy, add seats, a booking change with a task, and a finished one)
 *
 * Everything it creates is marked as test data and removed by --clear:
 *   leads             tag "test-seed"
 *   enquiries         payload.test_seed = true, messages start with [TEST]
 *   complaints        customer_name starts with "TEST"
 *   tasks             tag "test-seed"
 *   work order        title starts with "TEST"
 *
 * Run with:
 *   node scripts/seed-staging-enquiry-flow.mjs            seed (clears its own earlier rows first)
 *   node scripts/seed-staging-enquiry-flow.mjs --clear    remove everything it created
 *
 * Needs migrations 00619, 00622 and 00626 applied on staging. Reads NEXT_PUBLIC_SUPABASE_URL and
 * SUPABASE_SERVICE_ROLE_KEY from .env.staging.local and, like seed-staging.mjs, refuses to run
 * against the production project.
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

const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const MIN = 1;
const HOUR = 60;
const DAY = 24 * 60;

function check(label, { data, error }) {
  if (error) throw new Error(`${label}: ${error.message}`);
  return data;
}

// ─── Clear ───────────────────────────────────────────────────────────────────
async function clear() {
  const complaints = check(
    "find complaints",
    await supa.from("customer_complaints").select("id, task_id, issue_id").like("customer_name", "TEST%")
  );
  const taskIds = complaints.map((c) => c.task_id).filter(Boolean);
  const issueIds = complaints.map((c) => c.issue_id).filter(Boolean);

  check("delete complaints", await supa.from("customer_complaints").delete().like("customer_name", "TEST%"));
  check("delete tasks", await supa.from("tasks").delete().contains("tags", ["test-seed"]));
  if (taskIds.length) check("delete linked tasks", await supa.from("tasks").delete().in("id", taskIds));
  if (issueIds.length) await supa.from("facility_issue_events").delete().in("issue_id", issueIds);
  check("delete work orders", await supa.from("facility_issues").delete().like("title", "TEST%"));
  check("delete enquiries", await supa.from("lead_enquiries").delete().eq("payload->>test_seed", "true"));
  check("delete leads", await supa.from("leads").delete().contains("tags", ["test-seed"]));
}

if (CLEAR_ONLY) {
  console.log(`Removing seeded test data from ${SUPABASE_URL} ...`);
  await clear();
  console.log("Done. All rows marked as test data are gone.");
  process.exit(0);
}

console.log(`Seeding the enquiry flow into ${SUPABASE_URL} ...`);
await clear();

const admin = check("find admin", await supa.from("users").select("id").eq("email", "admin@staging.theworkvilla.test").maybeSingle());
if (!admin) throw new Error("Staging admin user not found. Run scripts/seed-staging.mjs first.");

// ─── Test leads ──────────────────────────────────────────────────────────────
const leadRows = [
  { key: "unnamed", first_name: "WhatsApp contact", last_name: "-", mobile: "9000000401", source: "whatsapp", status: "new", description: "[TEST] Hi, I'm Rahul from Acme. Need a cabin for 5 seats" },
  { key: "review", first_name: "TEST", last_name: "Priya (needs review)", mobile: "9000000402", source: "whatsapp", status: "new", description: "[TEST] hi" },
  { key: "spam", first_name: "TEST", last_name: "Spammer", mobile: "9000000403", source: "whatsapp", status: "junk", description: "[TEST] You have won a prize" },
  { key: "claimed", first_name: "TEST", last_name: "Meera Kapoor", mobile: "9000000404", source: "google_ads", status: "contacted", company: "Kapoor Studios" },
  { key: "unclaimed", first_name: "TEST", last_name: "Dev Patel", mobile: "9000000405", source: "meta_ads", status: "new" },
].map((l) => ({ rating: "none", score: 0, tags: ["test-seed"], ...l }));
const leads = {};
for (const l of leadRows) {
  const { key, ...row } = l;
  leads[key] = check(`lead ${key}`, await supa.from("leads").insert(row).select("id").single()).id;
}

// ─── Enquiries ───────────────────────────────────────────────────────────────
const test = (text) => `[TEST] ${text}`;
async function enquiry(row) {
  return check("enquiry", await supa.from("lead_enquiries").insert({ ...row, payload: { test_seed: true, ...row.payload } }).select("id, reference").single());
}

const eUnnamed = await enquiry({
  lead_id: leads.unnamed, source: "whatsapp", received_at: ago(2 * HOUR),
  payload: { name: "WhatsApp contact", mobile: "9000000401", suggested_name: "Rahul", messages: [{ at: ago(2 * HOUR), text: test("Hi, I'm Rahul from Acme. Need a cabin for 5 seats") }] },
});
const eReview = await enquiry({
  lead_id: leads.review, source: "whatsapp", received_at: ago(5 * HOUR),
  payload: { name: "TEST Priya (needs review)", mobile: "9000000402", messages: [{ at: ago(5 * HOUR), text: test("hi") }], triage: { kind: "unsure", reason: "greeting or sticker from a new number", source: "rules" } },
});
const eSpam = await enquiry({
  lead_id: leads.spam, source: "whatsapp", received_at: ago(1 * DAY), resolved_at: ago(1 * DAY), resolution_outcome: "spam",
  payload: { name: "TEST Spammer", mobile: "9000000403", messages: [{ at: ago(1 * DAY), text: test("You have won a lottery prize! click link http://bit.ly/x") }], triage: { kind: "spam", reason: "promotional or scam wording", source: "rules" } },
});
const eClaimed = await enquiry({
  lead_id: leads.claimed, source: "google_ads", received_at: ago(3 * DAY),
  claimed_by: admin.id, claimed_at: ago(3 * DAY - 2 * HOUR),
  next_step: "Call back with cabin pricing", follow_up_at: ago(1 * DAY), next_step_by: admin.id, next_step_at: ago(2 * DAY),
  payload: { name: "TEST Meera Kapoor", mobile: "9000000404", seat_capacity: "6", workspace_type: "private_office", description: test("Looking for a private office for 6 in Nungambakkam") },
});
check("updates", await supa.from("enquiry_updates").insert([
  { enquiry_id: eClaimed.id, kind: "call_no_answer", note: test("Rang twice, no answer"), next_step: "Call again tomorrow", follow_up_at: ago(2 * DAY), created_by: admin.id, created_at: ago(2 * DAY + 3 * HOUR) },
  { enquiry_id: eClaimed.id, kind: "spoke_interested", note: test("Wants a corner cabin, will confirm with partner"), next_step: "Call back with cabin pricing", follow_up_at: ago(1 * DAY), created_by: admin.id, created_at: ago(2 * DAY) },
]));
const eUnclaimed = await enquiry({
  lead_id: leads.unclaimed, source: "meta_ads", received_at: ago(20 * HOUR),
  payload: { name: "TEST Dev Patel", mobile: "9000000405", workspace_type: "hot_desk", seat_capacity: "2", description: test("Two hot desks from next month") },
});

// Stage demos on existing staging leads: the enquiry is placed just before a real booking,
// proposal or active contract so the stage is derived exactly as it would be live.
const stage = [];
const { data: booking } = await supa.from("bookings").select("lead_id, created_at").not("lead_id", "is", null).in("status", ["confirmed", "checked_in", "checked_out"]).order("created_at", { ascending: false }).limit(1).maybeSingle();
if (booking) stage.push(["Booked", booking.lead_id, new Date(Date.parse(booking.created_at) - DAY * 60_000).toISOString(), "Meeting room for a team offsite"]);
const { data: proposal } = await supa.from("proposals").select("lead_id, sent_at").not("sent_at", "is", null).not("lead_id", "is", null).order("sent_at", { ascending: false }).limit(1).maybeSingle();
if (proposal) stage.push(["Proposal sent", proposal.lead_id, new Date(Date.parse(proposal.sent_at) - DAY * 60_000).toISOString(), "Private office for 8"]);
const { data: contract } = await supa
  .from("contracts")
  .select("id, lead_id, contract_number, location_id, activated_at")
  .eq("status", "active").eq("is_renewal", false).not("activated_at", "is", null).not("lead_id", "is", null)
  .order("activated_at", { ascending: false }).limit(1).maybeSingle();
if (contract) stage.push(["Active customer", contract.lead_id, new Date(Date.parse(contract.activated_at) - 2 * DAY * 60_000).toISOString(), "Dedicated desks for 4"]);
const stageRefs = [];
for (const [label, leadId, receivedAt, text] of stage) {
  const e = await enquiry({ lead_id: leadId, source: "google_ads", received_at: receivedAt, payload: { name: `[TEST] ${label}`, description: test(text) } });
  stageRefs.push(`${e.reference} (${label}, received ${receivedAt.slice(0, 10)})`);
}

// ─── Complaints and requests ─────────────────────────────────────────────────
if (!contract) {
  console.warn("No active staging contract found, so complaints and requests were skipped.");
} else {
  const base = { lead_id: contract.lead_id, contract_id: contract.id, customer_name: "TEST Customer", customer_phone: "9000000301" };
  const msg = (minutesAgo, text) => ({ at: ago(minutesAgo), text: test(text) });
  const complaint = async (row) => check("complaint", await supa.from("customer_complaints").insert({ ...base, ...row }).select("id, reference").single());

  const cNew = await complaint({
    created_at: ago(40 * MIN), messages: [msg(40, "AC not working in cabin 4, third time reporting"), msg(30, "It is very hot now")],
    suggested_scope: "hvac", suggested_priority: "high", repeat_count: 2,
  });
  const cInfo = await complaint({
    created_at: ago(3 * HOUR), messages: [msg(180, "Something is wrong with the lights")], status: "needs_info",
    assessed_by: admin.id, assessed_at: ago(2 * HOUR), suggested_scope: "electrical", suggested_priority: "medium",
  });
  check("replies", await supa.from("complaint_replies").insert({
    complaint_id: cInfo.id, kind: "update", message: test("Could you tell us which cabin?"), status: "skipped", detail: "template not configured", sent_by: admin.id, created_at: ago(2 * HOUR),
  }));
  const issue = check("work order", await supa.from("facility_issues").insert({
    issue_number: "HV-TEST-0001", scope: "hvac", location_id: contract.location_id, title: "TEST Customer complaint: AC not working in cabin 5",
    description: "[TEST] Raised from a seeded customer complaint.", priority: "high", status: "in_progress", reported_via: "whatsapp",
    reporter_name: "TEST Customer", reporter_phone: "9000000301", assigned_to: admin.id, assigned_at: ago(1 * HOUR), sla_target_at: new Date(Date.now() + 3 * HOUR * 60_000).toISOString(),
  }).select("id").single());
  await complaint({
    created_at: ago(5 * HOUR), messages: [msg(300, "AC not cooling in cabin 5")], status: "qualified", outcome: "work_order", issue_id: issue.id,
    assessed_by: admin.id, assessed_at: ago(4 * HOUR), suggested_scope: "hvac", suggested_priority: "high",
  });

  const request = async (type, role, createdMinutesAgo, hours, text, extra = {}) =>
    complaint({
      kind: "request", request_type: type, owner_role: role, messages: [msg(createdMinutesAgo, text)],
      created_at: ago(createdMinutesAgo), due_at: new Date(Date.now() - createdMinutesAgo * 60_000 + hours * HOUR * 60_000).toISOString(), ...extra,
    });
  await request("invoice_copy", "accounts", 5 * HOUR, 4, "Please send the October invoice again");           // overdue
  await request("add_seats", "sales_rep", 20 * MIN, 1, "We need 3 more seats from next month");               // due soon
  const rBooking = await request("booking_change", "office_admin", 30 * MIN, 2, "Can I move my booking to Friday?", { status: "qualified", outcome: "task", assessed_by: admin.id, assessed_at: ago(20 * MIN) }); // handled, within target
  const t1 = check("task", await supa.from("tasks").insert({
    title: `Booking change (${rBooking.reference}): TEST Customer`, description: test("Customer asked to move a booking to Friday."), status: "todo", priority: "medium",
    lead_id: contract.lead_id, assigned_to: admin.id, due_date: new Date(Date.now() + DAY * 60_000).toISOString(), tags: ["request", rBooking.reference, "test-seed"], created_by: admin.id,
  }).select("id").single());
  check("link task", await supa.from("customer_complaints").update({ task_id: t1.id }).eq("id", rBooking.id));
  const rDone = await request("access_pass", "floor_manager", 1 * DAY, 2, "Need a visitor pass for my client tomorrow", { status: "qualified", outcome: "task", assessed_by: admin.id, assessed_at: ago(23 * HOUR) });
  const t2 = check("task", await supa.from("tasks").insert({
    title: `Access / visitor pass (${rDone.reference}): TEST Customer`, description: test("Visitor pass for tomorrow."), status: "done", priority: "medium", completed_at: ago(20 * HOUR),
    lead_id: contract.lead_id, assigned_to: admin.id, due_date: ago(22 * HOUR), tags: ["request", rDone.reference, "test-seed"], created_by: admin.id,
  }).select("id").single());
  check("link task", await supa.from("customer_complaints").update({ task_id: t2.id }).eq("id", rDone.id));
  check("done reply", await supa.from("complaint_replies").insert({
    complaint_id: rDone.id, kind: "update", message: "Your pass is arranged. Please collect it at the front desk.", status: "skipped", detail: "template not configured", created_at: ago(20 * HOUR),
  }));
  console.log(`Complaints: ${cNew.reference} (new), ${cInfo.reference} (needs info), plus one with a work order. Requests: invoice copy (overdue), add seats, ${rBooking.reference} (task), ${rDone.reference} (done).`);
}

console.log(`
Enquiry Log: ${eUnnamed.reference} (unnamed, suggested name), ${eReview.reference} (needs review), ${eSpam.reference} (spam, use the Spam filter),
             ${eClaimed.reference} (claimed, overdue next step, History), ${eUnclaimed.reference} (unclaimed).
Stage demos: ${stageRefs.join("; ") || "none (no bookings, proposals or contracts found)"}.
The Enquiry Log shows the last 30 days by default; move the "From" date back to see older stage demos.

Everything is marked as test data. To remove it:  node scripts/seed-staging-enquiry-flow.mjs --clear`);
