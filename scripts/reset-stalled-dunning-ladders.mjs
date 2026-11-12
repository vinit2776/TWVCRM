#!/usr/bin/env node
/**
 * One-off: re-arm the reminder ladder on statements stranded by a
 * due_date reset.
 *
 * Both early-GST override paths (convert-to-gst-early, upload-gst-invoice)
 * stamped a fresh due_date without clearing reminder_count. The payment
 * reminder cron picks a stage from days-overdue against due_date, but gates
 * it on reminder_count:
 *
 *     stageIdx    = pickStageIndex(daysOverdue)   // from the NEW due_date
 *     isFirstFire = stageIdx >= reminder_count    // count from the OLD one
 *
 * With a stale count sitting ahead of the fresh due date, every rung already
 * fired reads as "stage already sent" and the statement stops being chased
 * until days-overdue climbs back to STAGES[reminder_count].day. On a ladder
 * running to day 30 that is weeks of silence on a live receivable, and it
 * happens precisely when the customer has just been issued a tax invoice.
 *
 * The routes are fixed going forward (they now reset the ladder alongside
 * due_date). This corrects rows already stranded.
 *
 * Detection is the invariant, not a hardcoded list: a healthy statement has
 * reminder_count <= pickStageIndex(daysOverdue) + 1, because rungs 0..idx are
 * exactly the ones whose day-threshold has passed. Anything above that had
 * its due_date moved forward under it.
 *
 * DRY RUN BY DEFAULT. Pass --apply to write.
 *
 *   node scripts/reset-stalled-dunning-ladders.mjs
 *   node scripts/reset-stalled-dunning-ladders.mjs --apply
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
const supa = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** Mirrors STAGES[].day / toneLabel in src/lib/payment-reminder.ts. */
const STAGE_DAYS = [0, 3, 7, 14, 21, 30];
const STAGE_LABELS = [
  "Friendly reminder", "Gentle reminder", "Firm reminder",
  "Escalation", "Checking in", "Continued follow-up",
];
const pickStageIndex = (daysOverdue) => {
  let best = -1;
  for (let i = 0; i < STAGE_DAYS.length; i++) if (daysOverdue >= STAGE_DAYS[i]) best = i;
  return best;
};

const todayYmd = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
const daysBetween = (a, b) =>
  Math.floor((Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z")) / 86400000);

const { data: statements, error } = await supa
  .from("billing_statements")
  .select(`
    id, statement_number, gst_invoice_number, due_date, reminder_count,
    last_reminder_sent_at, total_amount, issuance_channel, tally_delivered_at,
    contract:contracts!billing_statements_contract_id_fkey(contract_number)
  `)
  .in("status", ["finalized", "exported"])
  .in("payment_status", ["unpaid", "partially_paid"])
  .is("voided_at", null)
  .not("due_date", "is", null);

if (error) {
  console.error("Query failed:", error.message);
  process.exit(1);
}

const stranded = [];
for (const s of statements) {
  // The cron skips undelivered Tally invoices outright (OV1), so their
  // counter is not stranded — there is nothing to re-arm yet.
  if (s.issuance_channel === "tally" && !s.tally_delivered_at) continue;

  const daysOverdue = daysBetween(todayYmd, s.due_date);
  const stageIdx = pickStageIndex(daysOverdue);
  if (stageIdx < 0) continue;                       // not yet due

  const count = s.reminder_count || 0;
  if (count <= stageIdx + 1) continue;              // healthy ladder position
  if (count > STAGE_DAYS.length - 1) continue;      // past the ladder; terminal rung re-fires on its own cadence

  stranded.push({
    ...s,
    daysOverdue,
    stageIdx,
    count,
    silentDays: s.last_reminder_sent_at
      ? daysBetween(todayYmd, s.last_reminder_sent_at.slice(0, 10))
      : null,
    // Days until the cron would have resumed on its own.
    resumesInDays: STAGE_DAYS[count] - daysOverdue,
  });
}

console.log(`Open, delivered statements examined : ${statements.length}`);
console.log(`Stranded by a due_date reset        : ${stranded.length}`);
console.log(`Mode                                : ${APPLY ? "APPLY (writing)" : "DRY RUN"}\n`);

if (stranded.length === 0) {
  console.log("Nothing to correct.");
  process.exit(0);
}

for (const s of stranded) {
  const ref = s.gst_invoice_number || s.statement_number;
  console.log(
    `${ref.padEnd(20)} ${(s.contract?.contract_number || "—").padEnd(12)} ` +
    `due ${s.due_date}  ${String(s.daysOverdue).padStart(3)}d overdue  ` +
    `reminder_count ${s.count} -> 0  (silent ${s.silentDays}d, would have resumed ` +
    `in ${s.resumesInDays}d)  next send: stage ${s.stageIdx} "${STAGE_LABELS[s.stageIdx]}"  ` +
    `Rs.${Math.round(s.total_amount)}`
  );
}

if (!APPLY) {
  console.log("\nDry run — nothing written. Re-run with --apply to correct these rows.");
  process.exit(0);
}

console.log("");
let ok = 0, failed = 0;
for (const s of stranded) {
  const ref = s.gst_invoice_number || s.statement_number;

  const { error: updErr } = await supa
    .from("billing_statements")
    .update({ reminder_count: 0, last_reminder_sent_at: null })
    .eq("id", s.id);

  if (updErr) {
    failed++;
    console.error(`  FAIL ${ref}: ${updErr.message}`);
    continue;
  }

  // performed_by stays null: this is a script, not a user. logAudit()
  // normalizes non-UUID actors to null anyway, so write the label the same
  // way it would, keeping the row attributable without breaking the FK.
  const { error: auditErr } = await supa.from("audit_trail").insert({
    entity_type: "billing_statement",
    entity_id: s.id,
    action: "update",
    performed_by: null,
    changes: {
      _actor_label: { old: null, new: "script:reset-stalled-dunning-ladders" },
      reminder_count: { old: s.count, new: 0 },
      last_reminder_sent_at: { old: s.last_reminder_sent_at, new: null },
      reason: {
        old: null,
        new: `Dunning ladder re-armed: due_date was reset to ${s.due_date} by an early-GST override without clearing reminder_count, leaving the statement unchased for ${s.silentDays} days`,
      },
    },
  });
  if (auditErr) console.error(`  WARN ${ref}: audit insert failed — ${auditErr.message}`);

  ok++;
  console.log(`  OK   ${ref}  reminder_count ${s.count} -> 0`);
}

console.log(`\nCorrected: ${ok}   Failed: ${failed}`);
// With reminder_count back at 0 the cron's isFirstFire test (stageIdx >= count)
// passes for whatever rung days-overdue currently selects, so each statement
// resumes at a tone proportionate to how late it actually is — not at stage 0.
// sendOneReminder then writes reminder_count = stageIdx + 1, putting the
// counter back in sync with due_date and letting the ladder continue normally.
console.log("The next payment-reminder cron run (09:30 IST) will resume each row at the");
console.log("stage matching its current days-overdue, shown above.");
