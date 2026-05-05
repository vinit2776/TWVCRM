#!/usr/bin/env node
/**
 * One-shot: close every unactioned follow-up with an explicit "no action
 * taken" note so the team starts fresh. Run once, manually:
 *
 *     node scripts/close-stale-followups.mjs
 *
 * Audit trail:
 *   - is_follow_up_done = true
 *   - follow_up_actioned_at = now (UTC)
 *   - follow_up_actioned_by = first active admin
 *   - follow_up_notes appended with the reset reason + date
 *
 * Idempotent: re-running won't touch follow-ups that are already done.
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env.local.
 * Service role bypasses RLS so this works without a logged-in user session.
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
      v = v.replace(/\\n$/, "");
      env[m[1]] = v;
    }
  }
} catch {
  console.error(".env.local not found");
  process.exit(1);
}

const supa = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const RESET_NOTE = `Closed: no action taken — bulk pipeline reset on ${new Date().toISOString().slice(0, 10)}`;

async function main() {
  console.log("→ Bulk-closing stale follow-ups");

  // Pick an admin to attribute the reset to (audit_trail traceability)
  const { data: admin } = await supa
    .from("users")
    .select("id, full_name")
    .eq("is_active", true)
    .eq("role", "admin")
    .limit(1)
    .single();
  if (!admin) { console.error("No active admin user found"); process.exit(1); }
  console.log(`  attributing to: ${admin.full_name}`);

  // Pull the unactioned follow-ups so we can append per-row notes preserving
  // the original text. Bulk UPDATE would overwrite notes; row-by-row keeps
  // existing context. Schema: activities.follow_up_notes is TEXT, may be NULL.
  const { data: rows, error: fetchErr } = await supa
    .from("activities")
    .select("id, follow_up_notes")
    .not("follow_up_date", "is", null)
    .eq("is_follow_up_done", false);
  if (fetchErr) { console.error(fetchErr); process.exit(1); }

  console.log(`  found: ${rows?.length ?? 0} unactioned follow-up${(rows?.length ?? 0) === 1 ? "" : "s"}`);

  if (!rows || rows.length === 0) {
    console.log("  nothing to do");
    return;
  }

  const now = new Date().toISOString();
  let closed = 0;

  for (const r of rows) {
    const merged = r.follow_up_notes
      ? `${r.follow_up_notes}\n\n[${RESET_NOTE}]`
      : RESET_NOTE;
    const { error } = await supa
      .from("activities")
      .update({
        is_follow_up_done: true,
        follow_up_actioned_at: now,
        follow_up_actioned_by: admin.id,
        follow_up_notes: merged,
      })
      .eq("id", r.id);
    if (error) {
      console.warn(`  ! ${r.id}: ${error.message}`);
      continue;
    }
    closed += 1;
  }

  // Single audit row for the bulk reset (per-activity audits would explode the log).
  await supa.from("audit_trail").insert({
    entity_type: "activity",
    entity_id: admin.id,
    action: "update",
    performed_by: admin.id,
    changes: {
      bulk_followup_reset: {
        old: `${closed} unactioned follow-ups`,
        new: "all closed — no action taken",
      },
    },
  });

  console.log(`✔ Closed ${closed} follow-up${closed === 1 ? "" : "s"}`);
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
