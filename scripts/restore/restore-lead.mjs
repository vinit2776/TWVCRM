#!/usr/bin/env node
/**
 * TWV CRM — Single-Lead Restore
 * ===============================
 * Recovers ONE lead and everything that was cascade-deleted with it
 * (proposals, contracts, billing statements, vouchers, activities, etc.)
 * from a Backblaze B2 JSON backup into the LIVE database.
 *
 * It does NOT touch any other data — only rows belonging to the matched
 * lead are re-inserted, and every insert uses ON CONFLICT DO NOTHING so
 * rows that still exist are left untouched.
 *
 * Usage:
 *   node scripts/restore/restore-lead.mjs --lead "Trinamite Grooming"
 *   node scripts/restore/restore-lead.mjs --lead foo@bar.com --date 2026-05-19
 *   node scripts/restore/restore-lead.mjs --lead "Trinamite" --confirm
 *
 * Options:
 *   --lead "<text>"   Name / email / phone / company to search for (required)
 *   --date YYYY-MM-DD Use the backup from this date (default: scan newest-first)
 *   --confirm         Actually write to the DB. Without it, this is a dry run.
 *
 * Required environment variables (copy from .env.local or Vercel):
 *   B2_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET, B2_ENDPOINT
 *   TARGET_DB_URL   postgres:// connection string for the LIVE database
 */

import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { gunzipSync } from "zlib";
import pg from "pg";

const { Pool } = pg;

// ── CLI args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const arg = (name) => args.find((_, i) => args[i - 1] === name);
const LEAD_QUERY = arg("--lead");
const DATE = arg("--date");
const CONFIRM = args.includes("--confirm");

if (!LEAD_QUERY) {
  console.error('❌  --lead "<name/email/phone>" is required');
  process.exit(1);
}

const REQUIRED_ENV = ["B2_KEY_ID", "B2_APPLICATION_KEY", "B2_BUCKET", "B2_ENDPOINT", "TARGET_DB_URL"];
for (const k of REQUIRED_ENV) {
  if (!process.env[k]) {
    console.error(`❌  Missing env var: ${k}`);
    process.exit(1);
  }
}

function getS3() {
  return new S3Client({
    endpoint: `https://${process.env.B2_ENDPOINT}`,
    region: "us-east-005",
    credentials: {
      accessKeyId: process.env.B2_KEY_ID,
      secretAccessKey: process.env.B2_APPLICATION_KEY,
    },
  });
}

async function listBackupKeys(s3) {
  const keys = [];
  let token;
  do {
    const res = await s3.send(new ListObjectsV2Command({
      Bucket: process.env.B2_BUCKET,
      Prefix: DATE ? `db/${DATE}/` : "db/",
      ContinuationToken: token,
    }));
    for (const o of res.Contents || []) {
      if (o.Key?.endsWith(".json.gz")) keys.push({ key: o.Key, mtime: o.LastModified?.getTime() || 0 });
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return keys.sort((a, b) => b.mtime - a.mtime);
}

async function loadDump(s3, key) {
  const res = await s3.send(new GetObjectCommand({ Bucket: process.env.B2_BUCKET, Key: key }));
  const chunks = [];
  for await (const c of res.Body) chunks.push(c);
  return JSON.parse(gunzipSync(Buffer.concat(chunks)).toString("utf-8"));
}

function findLead(dump, q) {
  const needle = q.toLowerCase().trim();
  const leads = dump.tables?.leads || [];
  return leads.filter((l) => {
    const hay = [
      l.first_name, l.last_name,
      `${l.first_name || ""} ${l.last_name || ""}`,
      l.company, l.email, l.secondary_email, l.phone, l.mobile,
    ].filter(Boolean).map((s) => String(s).toLowerCase());
    return hay.some((h) => h.includes(needle));
  });
}

// Collect the full cascade subtree: every row in any table that (transitively)
// references the lead id. UUIDs are globally unique, so a column value that
// equals a collected id is a genuine reference.
function collectSubtree(dump, leadId) {
  const wanted = new Set([leadId]);
  const collected = new Map(); // `${table}:${id}` -> { table, row }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [table, rows] of Object.entries(dump.tables || {})) {
      if (table === "users" || table === "locations") continue; // never deleted
      for (const row of rows) {
        const id = row.id;
        const key = `${table}:${id}`;
        if (collected.has(key)) continue;
        const refsWanted = Object.values(row).some(
          (v) => typeof v === "string" && wanted.has(v)
        );
        if (refsWanted) {
          collected.set(key, { table, row });
          if (typeof id === "string") {
            if (!wanted.has(id)) changed = true;
            wanted.add(id);
          }
        }
      }
    }
  }
  return [...collected.values()];
}

async function insertWithRetry(pool, items) {
  let pending = items.slice();
  let inserted = 0;
  const failures = [];
  while (pending.length) {
    const next = [];
    let progress = 0;
    for (const { table, row } of pending) {
      const cols = Object.keys(row);
      const sql = `INSERT INTO public."${table}" (${cols.map((c) => `"${c}"`).join(", ")}) ` +
        `VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) ON CONFLICT DO NOTHING`;
      try {
        await pool.query(sql, cols.map((c) => row[c]));
        inserted++;
        progress++;
      } catch (err) {
        if (err.code === "23503") next.push({ table, row }); // FK not satisfied yet — retry
        else failures.push({ table, id: row.id, msg: err.message });
      }
    }
    if (progress === 0) {
      for (const { table, row } of next) {
        failures.push({ table, id: row.id, msg: "unmet foreign key after all passes" });
      }
      break;
    }
    pending = next;
  }
  return { inserted, failures };
}

async function main() {
  console.log("═══════════════════════════════════════════════");
  console.log("  TWV CRM — Single-Lead Restore");
  console.log(`  Searching for: "${LEAD_QUERY}"`);
  console.log(`  Mode: ${CONFIRM ? "WRITE (--confirm)" : "DRY RUN"}`);
  console.log("═══════════════════════════════════════════════\n");

  const s3 = getS3();
  const keys = await listBackupKeys(s3);
  if (keys.length === 0) {
    console.error("❌  No backups found in B2.");
    process.exit(1);
  }

  // Scan backups newest-first until the lead is found.
  let dump, matchKey, matches;
  for (const { key } of keys) {
    process.stdout.write(`   scanning ${key} ... `);
    const d = await loadDump(s3, key);
    const found = findLead(d, LEAD_QUERY);
    if (found.length > 0) {
      console.log(`found ${found.length} lead(s)`);
      dump = d; matchKey = key; matches = found;
      break;
    }
    console.log("no match");
  }

  if (!dump) {
    console.error(`\n❌  No backup contains a lead matching "${LEAD_QUERY}".`);
    process.exit(1);
  }

  console.log(`\n✓  Using backup: ${matchKey}`);
  console.log(`   Exported at: ${dump.exported_at}\n`);

  if (matches.length > 1) {
    console.log("⚠  Multiple leads matched — restoring ALL of them:");
    for (const l of matches) {
      console.log(`   • ${l.first_name} ${l.last_name} <${l.email || "no-email"}> (${l.id})`);
    }
    console.log("");
  }

  // Build the combined subtree for every matched lead.
  const seen = new Set();
  const items = [];
  for (const lead of matches) {
    for (const it of collectSubtree(dump, lead.id)) {
      const k = `${it.table}:${it.row.id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      items.push(it);
    }
  }

  const byTable = {};
  for (const { table } of items) byTable[table] = (byTable[table] || 0) + 1;
  console.log("   Rows to restore (lead + cascade subtree):");
  for (const [t, n] of Object.entries(byTable).sort()) console.log(`     ${t}: ${n}`);
  console.log(`   Total: ${items.length} rows\n`);

  if (!CONFIRM) {
    console.log("ℹ  Dry run — nothing written. Re-run with --confirm to restore.");
    return;
  }

  const pool = new Pool({
    connectionString: process.env.TARGET_DB_URL,
    ssl: { rejectUnauthorized: false },
  });
  const { inserted, failures } = await insertWithRetry(pool, items);
  await pool.end();

  console.log("═══════════════════════════════════════════════");
  console.log(`  Inserted (new rows): ${inserted}`);
  console.log(`  Skipped/failed:      ${failures.length}`);
  for (const f of failures) console.log(`    ⚠ ${f.table}:${f.id} — ${f.msg}`);
  console.log(`  Status: ${failures.length === 0 ? "✓ CLEAN" : "⚠ CHECK FAILURES"}`);
  console.log("═══════════════════════════════════════════════");
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("\n❌  Fatal error:", err.message);
  process.exit(1);
});
