#!/usr/bin/env node
/**
 * READ-ONLY report of which live contracts could ride the auto-renewal
 * autopilot, and which need a person first. It only runs SELECTs: it writes
 * nothing and sends nothing.
 *
 * Run with:
 *   node scripts/report-auto-renew-candidates.mjs                 # staging (default)
 *   node scripts/report-auto-renew-candidates.mjs --env ../.env.local
 *   node scripts/report-auto-renew-candidates.mjs --allow-prod    # a prod env file, SELECTs only
 *
 * Defaults to .env.staging.local (not .env.local) so a bare run can never read
 * production by picking up the wrong file. A production project ref is refused
 * unless --allow-prod is passed explicitly.
 *
 * What it lists, per contract that is active or has a renewal in progress:
 *   - end date, notice period, applied vs agreement escalation
 *   - chains whose applied escalation differs from the chain root's (an old
 *     one-off negotiation that the base-agreement column now corrects)
 *   - blockers it can see cheaply: tiered rate phases, an active rent waiver,
 *     a live exit, a declined renewal
 * Overdue invoices and billing moratoriums are judged by the daily job (part 2),
 * not here.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

const PRODUCTION_REF = "zlbvadtajetylacxevsm";
const args = process.argv.slice(2);
const envIdx = args.indexOf("--env");
const envPath = envIdx >= 0 ? args[envIdx + 1] : "../.env.staging.local";
const allowProd = args.includes("--allow-prod");

function loadEnv(path) {
  const env = {};
  const raw = readFileSync(new URL(path, import.meta.url), "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[m[1]] = v.replace(/\\n$/, "");
  }
  return env;
}

const env = loadEnv(envPath);
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error(`${envPath} needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY`);
if (url.includes(PRODUCTION_REF) && !allowProd) {
  throw new Error("That env points at PRODUCTION. Re-run with --allow-prod if you really mean a read-only look.");
}
console.log(`Reading from ${url.replace(/^https?:\/\//, "").split(".")[0]} (SELECTs only)\n`);

const db = createClient(url, key, { auth: { persistSession: false } });
const today = new Date().toISOString().slice(0, 10);

const { data: live, error } = await db
  .from("contracts")
  .select("*")
  .in("status", ["active", "renewal_in_progress"])
  .order("end_date", { ascending: true });
if (error) throw error;

const ids = live.map((c) => c.id);
const [phases, waivers, exits] = await Promise.all([
  db.from("contract_rate_phases").select("contract_id").in("contract_id", ids),
  db.from("contract_rent_waivers").select("contract_id, waived_month").in("contract_id", ids).is("revoked_at", null).gte("waived_month", today),
  db.from("contract_exits").select("contract_id").in("contract_id", ids).eq("status", "in_notice"),
]);
const has = (res) => new Set((res.data ?? []).map((r) => r.contract_id));
const phased = has(phases), waived = has(waivers), exiting = has(exits);

// Chain root escalation, to spot old one-off negotiations carried forward.
const { data: all } = await db.from("contracts").select("id, parent_contract_id, escalation_percentage");
const byId = new Map((all ?? []).map((c) => [c.id, c]));
const rootEscalation = (c) => {
  let cur = c, guard = 0;
  while (cur?.parent_contract_id && guard++ < 20) cur = byId.get(cur.parent_contract_id);
  return cur?.escalation_percentage ?? null;
};

const rows = live.map((c) => {
  const blockers = [];
  if (phased.has(c.id)) blockers.push("tiered rate schedule");
  if (waived.has(c.id)) blockers.push("rent waiver");
  if (exiting.has(c.id)) blockers.push("exit in progress");
  if (c.renewal_declined) blockers.push("renewal declined");
  const root = rootEscalation(c);
  const applied = Number(c.escalation_percentage ?? 0);
  return {
    contract: c.contract_number,
    ends: c.end_date,
    notice_months: c.notice_period_months ?? "(none: PDF says 2)",
    applied_pct: applied,
    agreement_pct: c.agreement_escalation_percentage ?? "(null)",
    root_pct: root,
    differs_from_root: root != null && Math.abs(Number(root) - applied) > 0.0001 ? "YES" : "",
    blockers: blockers.join(", "),
  };
});

console.table(rows);
const clean = rows.filter((r) => !r.blockers);
console.log(`\n${rows.length} live contracts: ${clean.length} with no visible blocker, ${rows.length - clean.length} need a person first.`);
const drift = rows.filter((r) => r.differs_from_root);
if (drift.length) console.log(`${drift.length} renewal(s) carry an escalation different from their chain root (an old one-off negotiation).`);
console.log("Overdue invoices and moratoriums are checked by the daily job (part 2), not this report.");
