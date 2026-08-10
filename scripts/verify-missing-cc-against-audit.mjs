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

const missingCc = JSON.parse(readFileSync(new URL("./.backfill-missing-cc.json", import.meta.url), "utf8"));

const stillMissing = [];
for (const item of missingCc) {
  const { data: audit } = await supa
    .from("audit_trail")
    .select("action, changes, created_at")
    .eq("entity_type", "billing_statement")
    .eq("entity_id", item.id)
    .in("action", ["email_resent", "email_failed"])
    .order("created_at", { ascending: false });

  // Collect every recipient address ever mentioned in a successful send/resend audit row.
  const everSentTo = new Set();
  for (const a of audit || []) {
    if (a.action !== "email_resent") continue;
    const rec = String(a.changes?.recipient || "");
    for (const e of rec.split(",").map((x) => x.trim().toLowerCase())) if (e) everSentTo.add(e);
    const cc = a.changes?.cc;
    if (Array.isArray(cc)) for (const e of cc) if (e) everSentTo.add(String(e).toLowerCase());
  }
  // Original auto-send recipient too
  everSentTo.add(String(item.sentTo || "").toLowerCase());

  const stillMissingAddrs = item.missing.filter((e) => !everSentTo.has(e.toLowerCase()));
  if (stillMissingAddrs.length > 0) {
    stillMissing.push({ ...item, missing: stillMissingAddrs, auditCount: (audit || []).length });
  } else {
    console.log(`RESOLVED already (per audit_trail): ${item.stmt} (${item.ref}) — was going to send to ${item.missing.join(", ")}, but audit shows they already got it`);
  }
}

console.log(`\n${stillMissing.length} of ${missingCc.length} statements genuinely still missing recipients after audit cross-check:`);
for (const r of stillMissing) console.log(`  ${r.stmt} (${r.ref}) missing=${r.missing.join(", ")}`);

import { writeFileSync } from "fs";
writeFileSync(new URL("./.backfill-missing-cc.json", import.meta.url), JSON.stringify(stillMissing, null, 2));
console.log("\nUpdated .backfill-missing-cc.json to the verified-still-missing set.");
