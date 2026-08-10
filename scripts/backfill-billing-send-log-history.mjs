import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

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

const DRY = process.argv.includes("--dry");

// Every gst_direct statement that was emailed (gst_invoice_sent_at set) but
// has zero billing_send_log rows — these are pre-fix upload-gst-invoice auto
// sends that never logged, so they're invisible on the lead Communications
// timeline even though the email genuinely went out.
const { data: statements, error } = await supa
  .from("billing_statements")
  .select("id, statement_number, gst_invoice_sent_at, gst_invoice_sent_to")
  .not("gst_invoice_sent_at", "is", null);

if (error) { console.error(error); process.exit(1); }

let backfilled = 0, alreadyLogged = 0, skipped = 0;
for (const s of statements || []) {
  const { count } = await supa
    .from("billing_send_log")
    .select("id", { count: "exact", head: true })
    .eq("billing_statement_id", s.id);

  if (count && count > 0) { alreadyLogged++; continue; }

  const recipients = (s.gst_invoice_sent_to || "")
    .split(",").map((x) => x.trim()).filter(Boolean);
  if (recipients.length === 0) { skipped++; continue; }

  if (DRY) {
    console.log(`WOULD BACKFILL ${s.statement_number}: ${recipients.join(", ")} @ ${s.gst_invoice_sent_at}`);
    backfilled++;
    continue;
  }

  const { error: insErr } = await supa.from("billing_send_log").insert(
    recipients.map((recipient) => ({
      billing_statement_id: s.id,
      send_type: "gst_invoice",
      recipient,
      status: "sent",
      triggered_by: "manual",
      triggered_by_user_id: null,
      sent_at: s.gst_invoice_sent_at,
    })),
  );
  if (insErr) console.error(`  FAIL ${s.statement_number}: ${insErr.message}`);
  else backfilled++;
}

console.log(`\n${DRY ? "Would backfill" : "Backfilled"}: ${backfilled}, already logged: ${alreadyLogged}, skipped (no recipients on file): ${skipped}`);
