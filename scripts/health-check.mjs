#!/usr/bin/env node
/**
 * TWV CRM — Health Check
 * ──────────────────────
 * Runs a set of consistency checks against the live database and prints a
 * colour-coded report. Safe to run at any time — read-only, no writes.
 *
 * Usage:
 *   node scripts/health-check.mjs
 *   node scripts/health-check.mjs --json        # machine-readable output
 *   node scripts/health-check.mjs --fix-hints   # show SQL to fix each issue
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env.local.
 *
 * Checks performed:
 *   1. Total leads vs pipeline count — catches PostgREST row-cap regressions
 *   2. Active contracts with no proposal linked — gate compliance
 *   3. Accepted proposals (all payments in) with no active contract — stale
 *   4. Active contracts with no billing statement for the current month
 *   5. Overdue tasks (due before today, not done)
 *   6. Proposals accepted > 21 days ago with no active contract — critical
 *   7. Leads with no activity in the last 30 days
 *   8. Billing statements unpaid and past their contract's next_billing_date
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

// ── env loader ─────────────────────────────────────────────────────────────
const env = {};
try {
  const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) {
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      env[m[1]] = v;
    }
  }
} catch {
  console.error("✗ .env.local not found — run from the project root");
  process.exit(1);
}

const supa = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ── args ───────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const JSON_MODE  = args.includes("--json");
const FIX_HINTS  = args.includes("--fix-hints");

// ── colours ────────────────────────────────────────────────────────────────
const c = {
  reset:  "\x1b[0m",
  bold:   "\x1b[1m",
  green:  "\x1b[32m",
  yellow: "\x1b[33m",
  red:    "\x1b[31m",
  cyan:   "\x1b[36m",
  grey:   "\x1b[90m",
};
const ok   = (s) => `${c.green}✓${c.reset} ${s}`;
const warn = (s) => `${c.yellow}⚠${c.reset}  ${s}`;
const fail = (s) => `${c.red}✗${c.reset}  ${s}`;
const info = (s) => `${c.cyan}ℹ${c.reset}  ${s}`;
const dim  = (s) => `${c.grey}${s}${c.reset}`;

const today = new Date().toISOString().split("T")[0];
const nowMs = Date.now();

// Days between two ISO date strings
function daysBetween(a, b) {
  return Math.floor((new Date(b) - new Date(a)) / 86400000);
}

// ── checks ─────────────────────────────────────────────────────────────────
const results = [];

async function check(name, fn) {
  try {
    const result = await fn();
    results.push({ name, ...result });
  } catch (e) {
    results.push({ name, status: "error", message: e.message });
  }
}

// 1. Lead count integrity — paginate to collect all rows, compare to exact count
await check("Lead count integrity (PostgREST row-cap detection)", async () => {
  const { count: exactTotal, error: e2 } = await supa
    .from("leads")
    .select("*", { count: "exact", head: true });
  if (e2) return { status: "error", message: e2.message };

  // Paginate in 1 000-row pages (PostgREST server max_rows hard limit)
  const PAGE = 1000;
  let allRows = [];
  let page = 0;
  while (true) {
    const { data, error } = await supa
      .from("leads")
      .select("status")
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) return { status: "error", message: error.message };
    if (!data?.length) break;
    allRows = allRows.concat(data);
    if (data.length < PAGE) break;
    page++;
  }

  const pipelineTotal = allRows.length;
  const diff = exactTotal - pipelineTotal;

  if (diff > 0) return {
    status: "fail",
    message: `Paginated fetch returned ${pipelineTotal} rows but DB has ${exactTotal} leads — ${diff} leads unaccounted for`,
    hint: "Check for RLS policies that might filter rows when using service role. This is unexpected.",
  };
  return {
    status: "ok",
    message: `${exactTotal} leads — full paginated fetch matches DB total (${page + 1} page(s))`,
  };
});

// 2. Active contracts with no proposal linked
await check("Active contracts with no linked proposal", async () => {
  const { data, error } = await supa
    .from("contracts")
    .select("id, contract_number, created_at")
    .eq("status", "active")
    .is("proposal_id", null);

  if (error) return { status: "error", message: error.message };
  if (!data.length) return { status: "ok", message: "All active contracts have a linked proposal" };

  return {
    status: "fail",
    message: `${data.length} active contract(s) have no linked proposal`,
    items: data.map((c) => c.contract_number),
    hint: `SELECT id, contract_number FROM contracts WHERE status='active' AND proposal_id IS NULL;`,
  };
});

// 3. Accepted proposals (all payments in) with no active contract — need activation
await check("Accepted + fully-paid proposals awaiting contract activation", async () => {
  const { data, error } = await supa
    .from("proposals")
    .select("id, proposal_number, accepted_at, security_deposit_months, payment_status, deposit_payment_status")
    .eq("status", "accepted")
    .eq("payment_status", "paid");

  if (error) return { status: "error", message: error.message };

  // Filter: deposit must also be settled (or not required)
  const fullyPaid = (data || []).filter((p) => {
    const depositRequired = Number(p.security_deposit_months || 0) > 0;
    return !depositRequired || p.deposit_payment_status === "paid";
  });

  if (!fullyPaid.length) return { status: "ok", message: "No accepted proposals waiting for contract activation" };

  // Check each against active contracts
  const proposalIds = fullyPaid.map((p) => p.id);
  const { data: linked } = await supa
    .from("contracts")
    .select("proposal_id")
    .in("proposal_id", proposalIds)
    .eq("status", "active");

  const linkedIds = new Set((linked || []).map((c) => c.proposal_id));
  const unactivated = fullyPaid.filter((p) => !linkedIds.has(p.id));

  if (!unactivated.length) return { status: "ok", message: "All fully-paid proposals have an active contract" };

  const critical = unactivated.filter((p) => p.accepted_at && daysBetween(p.accepted_at, today) >= 21);

  return {
    status: critical.length > 0 ? "fail" : "warn",
    message: `${unactivated.length} proposal(s) fully paid but no active contract — ${critical.length} critical (>21 days)`,
    items: unactivated.map((p) => {
      const days = p.accepted_at ? daysBetween(p.accepted_at, today) : "?";
      return `${p.proposal_number} (${days}d since accepted)`;
    }),
    hint: `SELECT proposal_number, accepted_at FROM proposals WHERE status='accepted' AND payment_status='paid';`,
  };
});

// 4. Active contracts missing a billing statement for the current month
await check("Active contracts with no billing statement this month", async () => {
  const monthStart = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}-01`;

  const [{ data: activeContracts, error: e1 }, { data: thisMonthStatements, error: e2 }] = await Promise.all([
    supa.from("contracts").select("id, contract_number").eq("status", "active"),
    supa.from("billing_statements").select("contract_id").gte("period_start", monthStart),
  ]);

  if (e1 || e2) return { status: "error", message: (e1 || e2).message };

  const billedIds = new Set((thisMonthStatements || []).map((s) => s.contract_id));
  const missing = (activeContracts || []).filter((c) => !billedIds.has(c.id));

  if (!missing.length) return { status: "ok", message: "All active contracts have a billing statement this month" };

  return {
    status: "warn",
    message: `${missing.length} active contract(s) have no billing statement for ${monthStart.slice(0, 7)}`,
    items: missing.slice(0, 10).map((c) => c.contract_number),
    hint: "Use the 'Generate Missing Bills' button in /billing, or re-activate the contract to trigger auto-generation.",
  };
});

// 5. Overdue tasks
await check("Overdue tasks", async () => {
  const { count, error } = await supa
    .from("tasks")
    .select("*", { count: "exact", head: true })
    .lt("due_date", today)
    .neq("status", "done");

  if (error) return { status: "error", message: error.message };
  if (!count) return { status: "ok", message: "No overdue tasks" };

  return {
    status: count > 20 ? "fail" : "warn",
    message: `${count} overdue task(s)`,
    hint: "Review at /tasks — filter by 'Overdue'.",
  };
});

// 6. Leads inactive for 30+ days (no activity)
await check("Leads with no activity in 30+ days (open pipeline only)", async () => {
  const cutoff = new Date(nowMs - 30 * 86400000).toISOString();
  const openStatuses = ["new", "contacted", "tour_scheduled", "tour_completed", "proposal_sent", "negotiating"];

  // Paginate open leads (PostgREST max_rows = 1000 per request)
  const PAGE = 1000;
  let openLeads = [];
  let page = 0;
  while (true) {
    const { data, error } = await supa
      .from("leads")
      .select("id")
      .in("status", openStatuses)
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) return { status: "error", message: error.message };
    if (!data?.length) break;
    openLeads = openLeads.concat(data);
    if (data.length < PAGE) break;
    page++;
  }

  if (!openLeads.length) return { status: "ok", message: "No open leads" };

  const leadIds = openLeads.map((l) => l.id);

  // Get IDs that HAVE recent activity — fetch in batches to avoid URL length limits
  const BATCH = 200;
  const activeIds = new Set();
  for (let i = 0; i < leadIds.length; i += BATCH) {
    const { data: batch } = await supa
      .from("activities")
      .select("lead_id")
      .in("lead_id", leadIds.slice(i, i + BATCH))
      .gte("created_at", cutoff)
      .range(0, 9999);
    (batch || []).forEach((a) => activeIds.add(a.lead_id));
  }

  const staleCount = openLeads.filter((l) => !activeIds.has(l.id)).length;

  if (!staleCount) return { status: "ok", message: `All ${openLeads.length} open leads have recent activity` };

  return {
    status: staleCount > 10 ? "warn" : "ok",
    message: `${staleCount} of ${openLeads.length} open leads have had no activity for 30+ days`,
    hint: "Review at /pipeline — these leads may need a follow-up or status update.",
  };
});

// 7. Unpaid billing statements past their due period
await check("Unpaid billing statements from past periods", async () => {
  const lastMonth = new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1)
    .toISOString().split("T")[0];

  const { count, error } = await supa
    .from("billing_statements")
    .select("*", { count: "exact", head: true })
    .eq("payment_status", "unpaid")
    .lt("period_end", lastMonth);

  if (error) return { status: "error", message: error.message };
  if (!count) return { status: "ok", message: "No unpaid billing statements from past periods" };

  return {
    status: count > 5 ? "fail" : "warn",
    message: `${count} unpaid billing statement(s) from periods before last month`,
    hint: "Review at /billing — these may represent outstanding receivables.",
  };
});

// ── render report ──────────────────────────────────────────────────────────
if (JSON_MODE) {
  console.log(JSON.stringify(results, null, 2));
  process.exit(0);
}

console.log(`\n${c.bold}TWV CRM — Health Check${c.reset}  ${dim(new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }))}`);
console.log(dim("─".repeat(60)));

let failCount = 0, warnCount = 0;

for (const r of results) {
  if (r.status === "ok") {
    console.log(ok(r.message));
  } else if (r.status === "warn") {
    warnCount++;
    console.log(warn(r.message));
    if (r.items?.length) {
      for (const item of r.items.slice(0, 5)) console.log(`     ${dim("→")} ${item}`);
      if (r.items.length > 5) console.log(`     ${dim(`… and ${r.items.length - 5} more`)}`);
    }
    if (FIX_HINTS && r.hint) console.log(`     ${dim("fix:")} ${dim(r.hint)}`);
  } else if (r.status === "fail") {
    failCount++;
    console.log(fail(r.message));
    if (r.items?.length) {
      for (const item of r.items.slice(0, 5)) console.log(`     ${dim("→")} ${item}`);
      if (r.items.length > 5) console.log(`     ${dim(`… and ${r.items.length - 5} more`)}`);
    }
    if (FIX_HINTS && r.hint) console.log(`     ${dim("fix:")} ${dim(r.hint)}`);
  } else {
    console.log(`${c.red}✗${c.reset}  [${r.name}] error: ${r.message}`);
    failCount++;
  }
}

console.log(dim("─".repeat(60)));
if (failCount === 0 && warnCount === 0) {
  console.log(`${c.green}${c.bold}All checks passed.${c.reset}\n`);
} else {
  console.log(`${failCount > 0 ? c.red : c.yellow}${c.bold}${failCount} failure(s), ${warnCount} warning(s).${c.reset}`);
  if (!FIX_HINTS && (failCount + warnCount) > 0) {
    console.log(dim("Run with --fix-hints to see suggested fixes.\n"));
  } else {
    console.log();
  }
}

process.exit(failCount > 0 ? 1 : 0);
