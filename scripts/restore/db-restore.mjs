#!/usr/bin/env node
/**
 * TWV CRM — Database Restore Script
 * ===================================
 * Restores a JSON backup (produced by /api/cron/db-backup) from Backblaze B2
 * into a Supabase project using direct PostgreSQL access.
 *
 * Usage:
 *   node scripts/restore/db-restore.mjs [--date YYYY-MM-DD] [--dry-run]
 *
 * Options:
 *   --date YYYY-MM-DD   Restore from a specific date (default: today)
 *   --dry-run           Download and parse backup but do NOT insert any rows
 *   --tables t1,t2      Restore only specific tables (comma-separated)
 *
 * Required environment variables (copy from .env.local or Vercel):
 *   B2_KEY_ID              Backblaze B2 application key ID
 *   B2_APPLICATION_KEY     Backblaze B2 application key secret
 *   B2_BUCKET              Bucket name (e.g. twvcrmbackups)
 *   B2_ENDPOINT            B2 endpoint host (without https://)
 *   TARGET_DB_URL          Full postgres:// connection string for the TARGET DB
 *                          e.g. postgresql://postgres:<password>@<host>:5432/postgres
 *
 * WARNING: This script INSERTS rows. Run against an EMPTY target database.
 *          It does not drop/truncate tables — run that manually first if needed.
 */

import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { createGunzip } from "zlib";
import { pipeline } from "stream/promises";
import { createWriteStream, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import pg from "pg";

const { Pool } = pg;

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const dateArg = args.find((_, i) => args[i - 1] === "--date");
const tablesArg = args.find((_, i) => args[i - 1] === "--tables");
const ONLY_TABLES = tablesArg ? tablesArg.split(",").map((t) => t.trim()) : null;
const TARGET_DATE = dateArg || new Date().toISOString().split("T")[0];

// ── Env checks ────────────────────────────────────────────────────────────────
const REQUIRED_ENV = ["B2_KEY_ID", "B2_APPLICATION_KEY", "B2_BUCKET", "B2_ENDPOINT", "TARGET_DB_URL"];
for (const k of REQUIRED_ENV) {
  if (!process.env[k]) {
    console.error(`❌  Missing env var: ${k}`);
    process.exit(1);
  }
}

// Tables that should be skipped during restore (auth-managed or auto-populated)
const SKIP_TABLES = new Set([
  "schema_migrations",
  "supabase_migrations",
  "pg_stat_statements",
  "spatial_ref_sys",
]);

// Restore order matters — parent tables before child tables (foreign keys)
const RESTORE_ORDER = [
  "locations",
  "users",
  "leads",
  "proposals",
  "contracts",
  "billing_statements",
  "billing_payments",
  "booking_payments",
  "bookings",
  "procurement_requests",
  "procurement_orders",
  "procurement_bills",
  "vendors",
  "prepaid_purchases",
  "prepaid_credit_balances",
  "facility_issues",
  "wifi_vouchers",
  "app_settings",
  "audit_trail",
  "razorpay_webhook_log",
];

function getS3Client() {
  return new S3Client({
    endpoint: `https://${process.env.B2_ENDPOINT}`,
    region: "us-east-005",
    credentials: {
      accessKeyId: process.env.B2_KEY_ID,
      secretAccessKey: process.env.B2_APPLICATION_KEY,
    },
  });
}

async function findLatestBackupKey(s3, date) {
  const prefix = `db/${date}/`;
  const res = await s3.send(new ListObjectsV2Command({
    Bucket: process.env.B2_BUCKET,
    Prefix: prefix,
  }));

  if (!res.Contents || res.Contents.length === 0) {
    throw new Error(`No backups found for date ${date} (prefix: ${prefix})`);
  }

  // Sort by LastModified descending, pick the latest
  const files = res.Contents
    .filter((o) => o.Key?.endsWith(".json.gz"))
    .sort((a, b) => (b.LastModified?.getTime() || 0) - (a.LastModified?.getTime() || 0));

  if (files.length === 0) throw new Error(`No .json.gz backup found for ${date}`);
  return files[0].Key;
}

async function downloadAndDecompress(s3, key) {
  console.log(`⬇  Downloading s3://${process.env.B2_BUCKET}/${key} ...`);
  const res = await s3.send(new GetObjectCommand({
    Bucket: process.env.B2_BUCKET,
    Key: key,
  }));

  const tmpFile = join(tmpdir(), `twvcrm-restore-${Date.now()}.json`);
  const gunzip = createGunzip();
  const out = createWriteStream(tmpFile);

  await pipeline(res.Body, gunzip, out);
  console.log(`✓  Decompressed to ${tmpFile}`);
  return tmpFile;
}

async function insertTable(pool, tableName, rows) {
  if (rows.length === 0) {
    console.log(`   ${tableName}: 0 rows — skipped`);
    return { inserted: 0, failed: 0 };
  }

  const columns = Object.keys(rows[0]);
  const quotedCols = columns.map((c) => `"${c}"`).join(", ");

  let inserted = 0;
  let failed = 0;

  for (const row of rows) {
    const values = columns.map((c) => row[c]);
    const placeholders = values.map((_, i) => `$${i + 1}`).join(", ");
    const sql = `INSERT INTO public."${tableName}" (${quotedCols}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;

    try {
      await pool.query(sql, values);
      inserted++;
    } catch (err) {
      failed++;
      if (failed <= 3) {
        console.warn(`   ⚠  ${tableName} row insert failed: ${err.message}`);
      }
    }
  }

  return { inserted, failed };
}

async function main() {
  console.log("═══════════════════════════════════════════════");
  console.log("  TWV CRM — Database Restore");
  console.log(`  Date: ${TARGET_DATE}${DRY_RUN ? "  [DRY RUN]" : ""}`);
  if (ONLY_TABLES) console.log(`  Tables: ${ONLY_TABLES.join(", ")}`);
  console.log("═══════════════════════════════════════════════\n");

  if (!DRY_RUN) {
    console.log("⚠  This will INSERT rows into TARGET_DB_URL.");
    console.log("   Make sure the target is a FRESH database with schema applied.");
    console.log("   Press Ctrl+C within 5 seconds to abort...\n");
    await new Promise((r) => setTimeout(r, 5000));
  }

  const s3 = getS3Client();
  const key = await findLatestBackupKey(s3, TARGET_DATE);
  console.log(`   Backup file: ${key}\n`);

  const tmpFile = await downloadAndDecompress(s3, key);

  let dump;
  try {
    const { readFileSync } = await import("fs");
    const raw = readFileSync(tmpFile, "utf-8");
    dump = JSON.parse(raw);
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }

  console.log(`   Exported at: ${dump.exported_at}`);
  const allTables = Object.keys(dump.tables || {});
  console.log(`   Tables in backup: ${allTables.length}\n`);

  if (DRY_RUN) {
    for (const t of allTables) {
      const rows = dump.tables[t] || [];
      console.log(`   ${t}: ${rows.length} rows`);
    }
    console.log("\n✓  Dry run complete — no data written.");
    return;
  }

  const pool = new Pool({ connectionString: process.env.TARGET_DB_URL, ssl: { rejectUnauthorized: false } });

  // Restore in dependency order first, then remaining tables alphabetically
  const orderedTables = [
    ...RESTORE_ORDER.filter((t) => allTables.includes(t)),
    ...allTables.filter((t) => !RESTORE_ORDER.includes(t) && !SKIP_TABLES.has(t)),
  ];

  const tablesToRestore = ONLY_TABLES
    ? orderedTables.filter((t) => ONLY_TABLES.includes(t))
    : orderedTables.filter((t) => !SKIP_TABLES.has(t));

  let totalInserted = 0;
  let totalFailed = 0;

  for (const table of tablesToRestore) {
    const rows = dump.tables[table] || [];
    process.stdout.write(`   ${table}: ${rows.length} rows ... `);
    const { inserted, failed } = await insertTable(pool, table, rows);
    totalInserted += inserted;
    totalFailed += failed;
    console.log(`${inserted} inserted, ${failed} failed`);
  }

  await pool.end();

  console.log("\n═══════════════════════════════════════════════");
  console.log(`  Total inserted : ${totalInserted}`);
  console.log(`  Total failed   : ${totalFailed}`);
  console.log(`  Status         : ${totalFailed === 0 ? "✓ CLEAN" : "⚠ SOME FAILURES — check logs"}`);
  console.log("═══════════════════════════════════════════════\n");

  if (totalFailed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("\n❌  Fatal error:", err.message);
  process.exit(1);
});
