#!/usr/bin/env node
/**
 * TWV CRM — Cron Trigger
 * ───────────────────────
 * Manually fires any cron endpoint — useful during development and testing
 * without waiting for the Vercel schedule to run.
 *
 * Usage:
 *   node scripts/trigger-cron.mjs                        # list all crons
 *   node scripts/trigger-cron.mjs billing                # fire billing/auto-generate
 *   node scripts/trigger-cron.mjs contract-expiry        # fire cron/contract-expiry
 *   node scripts/trigger-cron.mjs all                    # fire every cron in sequence
 *
 *   # Target local dev server instead of production:
 *   node scripts/trigger-cron.mjs billing --local
 *   node scripts/trigger-cron.mjs billing --local --port 3001
 *
 * Reads CRON_SECRET + NEXT_PUBLIC_APP_URL from .env.local.
 * All requests include the Authorization: Bearer <CRON_SECRET> header exactly
 * as Vercel injects it in production.
 */

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

const CRON_SECRET = env.CRON_SECRET;
const PROD_URL    = (env.NEXT_PUBLIC_APP_URL || "https://twv-crm.vercel.app").replace(/\/$/, "");

if (!CRON_SECRET) {
  console.error("✗ CRON_SECRET not found in .env.local");
  process.exit(1);
}

// ── args ───────────────────────────────────────────────────────────────────
const args       = process.argv.slice(2);
const useLocal   = args.includes("--local");
const portArg    = args.find((a) => a.startsWith("--port"));
const port       = portArg ? portArg.split("=")[1] ?? args[args.indexOf(portArg) + 1] : "3000";
const BASE_URL   = useLocal ? `http://localhost:${port}` : PROD_URL;
const target     = args.find((a) => !a.startsWith("--"))?.toLowerCase();

// ── cron registry ─────────────────────────────────────────────────────────
// Mirrors vercel.json exactly — update here whenever vercel.json changes.
const CRONS = [
  {
    key: "billing",
    path: "/api/billing/auto-generate",
    schedule: "30 15 28-31 * *  (UTC) — runs last 4 days of month",
    description: "Auto-generate monthly billing statements for all active contracts",
  },
  {
    key: "contract-expiry",
    path: "/api/cron/contract-expiry",
    schedule: "30 18 * * *  (UTC) — daily",
    description: "Mark contracts as expired if end_date has passed",
  },
  {
    key: "renewal-reminders",
    path: "/api/cron/renewal-reminders",
    schedule: "0 4 * * *  (UTC) — daily",
    description: "Send renewal reminder emails for contracts expiring soon",
  },
  {
    key: "kyc-reminder",
    path: "/api/cron/kyc-reminder",
    schedule: "0 4 * * 6  (UTC) — every Saturday",
    description: "Send KYC completion reminders for pending contracts",
  },
  {
    key: "headcount-reminder",
    path: "/api/cron/headcount-reminder",
    schedule: "3× daily Mon-Sat  (10:00, 14:00, 18:00 IST)",
    description: "Remind floor managers to log headcount",
  },
  {
    key: "vendor-email-digest",
    path: "/api/cron/vendor-email-digest",
    schedule: "0 4 * * 1  (UTC) — every Monday",
    description: "Weekly digest of vendors missing email addresses",
  },
  {
    key: "petty-cash",
    path: "/api/petty-cash/day-book",
    schedule: "0 13 * * *  (UTC) — daily",
    description: "Generate daily petty cash day-book entry",
  },
  {
    key: "digest",
    path: "/api/digest",
    schedule: "0 15 * * *  (UTC) — daily 8:30 PM IST",
    description: "Daily operations digest email to management",
  },
  {
    key: "db-backup",
    path: "/api/cron/db-backup",
    schedule: "0 20 * * *  (UTC) — daily",
    description: "Trigger Supabase DB backup to Backblaze B2",
  },
  {
    key: "storage-backup",
    path: "/api/cron/storage-backup",
    schedule: "30 20 * * *  (UTC) — daily",
    description: "Sync storage bucket to Backblaze B2 backup bucket",
  },
];

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
const dim = (s) => `${c.grey}${s}${c.reset}`;

// ── list ───────────────────────────────────────────────────────────────────
function listCrons() {
  console.log(`\n${c.bold}Available cron jobs${c.reset}  ${dim("(use the KEY to trigger)")}`);
  console.log(dim("─".repeat(70)));
  for (const cr of CRONS) {
    console.log(`  ${c.cyan}${c.bold}${cr.key.padEnd(22)}${c.reset} ${cr.description}`);
    console.log(`  ${dim("path:     " + cr.path)}`);
    console.log(`  ${dim("schedule: " + cr.schedule)}`);
    console.log();
  }
  console.log(dim("Examples:"));
  console.log(dim("  node scripts/trigger-cron.mjs billing"));
  console.log(dim("  node scripts/trigger-cron.mjs billing --local"));
  console.log(dim("  node scripts/trigger-cron.mjs all\n"));
}

// ── fire ───────────────────────────────────────────────────────────────────
async function fire(cron) {
  const url = `${BASE_URL}${cron.path}`;
  const env_label = useLocal ? `${c.yellow}LOCAL :${port}${c.reset}` : `${c.cyan}PROD${c.reset}`;
  console.log(`\n${c.bold}→ ${cron.key}${c.reset}  [${env_label}]`);
  console.log(dim(`  ${url}`));

  const start = Date.now();
  let res;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${CRON_SECRET}` },
      signal: AbortSignal.timeout(120_000), // 2 min timeout
    });
  } catch (e) {
    console.log(`  ${c.red}✗ Network error: ${e.message}${c.reset}`);
    if (useLocal) console.log(dim("  Is the dev server running? (npm run dev)"));
    return false;
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  let body = "";
  try { body = await res.text(); } catch { /* ignore */ }

  let parsed = null;
  try { parsed = JSON.parse(body); } catch { /* not JSON */ }

  if (res.ok) {
    console.log(`  ${c.green}✓ ${res.status} OK${c.reset}  ${dim(elapsed + "s")}`);
    if (parsed) {
      // Pretty-print a few useful keys if present
      const keys = ["processed", "generated", "sent", "skipped", "count", "message", "error"];
      const preview = Object.fromEntries(
        keys.filter((k) => parsed[k] !== undefined).map((k) => [k, parsed[k]])
      );
      if (Object.keys(preview).length) {
        console.log("  " + dim(JSON.stringify(preview)));
      }
    }
    return true;
  } else {
    console.log(`  ${c.red}✗ ${res.status}${c.reset}  ${dim(elapsed + "s")}`);
    if (res.status === 401) {
      console.log(`  ${c.red}CRON_SECRET mismatch — check .env.local and the deployed secret${c.reset}`);
    }
    if (body) console.log("  " + dim(body.slice(0, 200)));
    return false;
  }
}

// ── main ───────────────────────────────────────────────────────────────────
if (!target || target === "list") {
  listCrons();
  process.exit(0);
}

if (target === "all") {
  console.log(`\n${c.bold}Firing all ${CRONS.length} crons in sequence${c.reset}  ${dim(BASE_URL)}`);
  let ok = 0, fail = 0;
  for (const cr of CRONS) {
    const success = await fire(cr);
    success ? ok++ : fail++;
    // Small gap between requests to avoid hammering the server
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(`\n${dim("─".repeat(40))}`);
  console.log(`${c.bold}${ok} succeeded, ${fail} failed.${c.reset}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

// Single cron
const cron = CRONS.find((cr) => cr.key === target || cr.path.includes(target));
if (!cron) {
  console.error(`\n${c.red}✗ Unknown cron: "${target}"${c.reset}`);
  listCrons();
  process.exit(1);
}

const ok = await fire(cron);
console.log();
process.exit(ok ? 0 : 1);
