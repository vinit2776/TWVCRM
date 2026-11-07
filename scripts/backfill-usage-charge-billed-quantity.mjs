#!/usr/bin/env node
/**
 * One-shot: populate usage_charges.billed_quantity for historical rows.
 *
 * Background: usage_charges.quantity was overloaded — on the checkout
 * pooled-usage path it stores the full consumed duration (a free-quota
 * ledger), not what the customer was actually billed for. billed_quantity
 * (added in supabase/migrations/00508_usage_charge_billed_quantity.sql) is
 * the new, unambiguous "what the customer is charged for" column, and all
 * insert sites now populate it going forward. This script backfills it for
 * rows that predate the column.
 *
 * Rule for each row where billed_quantity IS NULL:
 *   - unit_price > 0        -> total / unit_price
 *   - unit_price is 0/null and total = 0  -> 0
 *   - otherwise (can't derive) -> fall back to quantity
 * Result is rounded to at most 2 decimals.
 *
 * Idempotent: only rows with billed_quantity IS NULL are touched, and
 * re-running after a partial --apply just picks up the remaining rows.
 *
 * Usage:
 *   node scripts/backfill-usage-charge-billed-quantity.mjs            # dry run (prints summary only)
 *   node scripts/backfill-usage-charge-billed-quantity.mjs --apply    # actually writes the updates
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

const APPLY = process.argv.includes("--apply");

const env = {};
const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
for (const line of raw.split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) {
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    v = v.replace(/\\n$/, "");
    env[m[1]] = v;
  }
}

if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const supa = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function round2(n) {
  return Math.round(n * 100) / 100;
}

function deriveBilledQuantity(row) {
  const unitPrice = Number(row.unit_price ?? 0);
  const total = Number(row.total ?? 0);
  const quantity = Number(row.quantity ?? 0);

  if (unitPrice > 0) {
    return { value: round2(total / unitPrice), basis: "total/unit_price" };
  }
  if (total === 0) {
    return { value: 0, basis: "total=0" };
  }
  return { value: round2(quantity), basis: "fallback:quantity" };
}

async function main() {
  console.log(`→ Backfilling usage_charges.billed_quantity (${APPLY ? "APPLY" : "DRY RUN"})`);

  const { data: rows, error } = await supa
    .from("usage_charges")
    .select("id, quantity, unit_price, total, description")
    .is("billed_quantity", null);

  if (error) {
    console.error(error);
    process.exit(1);
  }

  console.log(`  candidates: ${rows?.length ?? 0}`);
  if (!rows || rows.length === 0) {
    console.log("  nothing to do");
    return;
  }

  const byBasis = { "total/unit_price": 0, "total=0": 0, "fallback:quantity": 0 };
  const planned = rows.map((row) => {
    const { value, basis } = deriveBilledQuantity(row);
    byBasis[basis] += 1;
    return { row, value, basis };
  });

  console.log("\n  Dry-run summary:");
  console.log(`    total/unit_price : ${byBasis["total/unit_price"]}`);
  console.log(`    total=0 -> 0     : ${byBasis["total=0"]}`);
  console.log(`    fallback:quantity: ${byBasis["fallback:quantity"]}`);
  for (const { row, value, basis } of planned.slice(0, 20)) {
    console.log(
      `    ${row.id} qty=${row.quantity} unit_price=${row.unit_price} total=${row.total} -> billed_quantity=${value} (${basis}) — ${String(row.description).slice(0, 50)}`
    );
  }
  if (planned.length > 20) {
    console.log(`    ... and ${planned.length - 20} more`);
  }

  if (!APPLY) {
    console.log("\n  Dry run only — re-run with --apply to write these updates.");
    return;
  }

  let updated = 0;
  let failed = 0;
  for (const { row, value } of planned) {
    const { error: upErr } = await supa
      .from("usage_charges")
      .update({ billed_quantity: value })
      .eq("id", row.id)
      .is("billed_quantity", null); // guard against a concurrent writer racing this row
    if (upErr) {
      failed += 1;
      console.warn(`  ! ${row.id}: ${upErr.message}`);
      continue;
    }
    updated += 1;
  }

  console.log(`\n✔ Updated: ${updated}, failed: ${failed}`);
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
