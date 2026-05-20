#!/usr/bin/env node
/**
 * TWV CRM — Storage Restore Script
 * ==================================
 * Re-uploads files from the Backblaze B2 backup into Supabase Storage.
 * Use this when Supabase Storage is corrupted or files are missing.
 *
 * Usage:
 *   node scripts/restore/storage-restore.mjs [--bucket crm-documents] [--dry-run]
 *
 * Options:
 *   --bucket <name>   Restore only this bucket (default: all buckets)
 *   --prefix <path>   Restore only files under this path prefix
 *   --dry-run         List files that would be restored without uploading
 *
 * Required environment variables (copy from .env.local or Vercel):
 *   B2_KEY_ID              Backblaze B2 application key ID
 *   B2_APPLICATION_KEY     Backblaze B2 application key secret
 *   B2_BUCKET              Bucket name (e.g. twvcrmbackups)
 *   B2_ENDPOINT            B2 endpoint host (without https://)
 *   NEXT_PUBLIC_SUPABASE_URL   Target Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY  Service role key for the target project
 */

import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";

const STORAGE_BUCKETS = ["crm-documents", "vendor-invoices"];

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const bucketArg = args.find((_, i) => args[i - 1] === "--bucket");
const prefixArg = args.find((_, i) => args[i - 1] === "--prefix");
const ONLY_BUCKET = bucketArg || null;
const FILE_PREFIX = prefixArg || "";

// ── Env checks ────────────────────────────────────────────────────────────────
const REQUIRED_ENV = [
  "B2_KEY_ID", "B2_APPLICATION_KEY", "B2_BUCKET", "B2_ENDPOINT",
  "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY",
];
for (const k of REQUIRED_ENV) {
  if (!process.env[k]) {
    console.error(`❌  Missing env var: ${k}`);
    process.exit(1);
  }
}

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

async function listB2Files(s3, bucket, prefix) {
  const b2Prefix = `storage/${bucket}/${prefix}`;
  const files = [];
  let continuationToken;

  do {
    const res = await s3.send(new ListObjectsV2Command({
      Bucket: process.env.B2_BUCKET,
      Prefix: b2Prefix,
      ContinuationToken: continuationToken,
    }));

    for (const obj of res.Contents || []) {
      if (obj.Key && !obj.Key.endsWith("/")) {
        // Strip the "storage/<bucket>/" prefix to get the storage path
        const storagePath = obj.Key.replace(`storage/${bucket}/`, "");
        files.push({ b2Key: obj.Key, storagePath, size: obj.Size || 0 });
      }
    }

    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken);

  return files;
}

async function downloadFromB2(s3, key) {
  const res = await s3.send(new GetObjectCommand({
    Bucket: process.env.B2_BUCKET,
    Key: key,
  }));

  const chunks = [];
  for await (const chunk of res.Body) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function uploadToSupabase(bucket, path, data) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const res = await fetch(
    `${supabaseUrl}/storage/v1/object/${bucket}/${path}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/octet-stream",
        "x-upsert": "true", // overwrite if exists
      },
      body: data,
    }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body}`);
  }

  return true;
}

async function ensureBucketExists(bucket) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // Check if bucket exists
  const checkRes = await fetch(`${supabaseUrl}/storage/v1/bucket/${bucket}`, {
    headers: { Authorization: `Bearer ${serviceKey}` },
  });

  if (checkRes.status === 404) {
    // Create it
    const createRes = await fetch(`${supabaseUrl}/storage/v1/bucket`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ id: bucket, name: bucket, public: false }),
    });
    if (!createRes.ok) {
      throw new Error(`Failed to create bucket ${bucket}: ${await createRes.text()}`);
    }
    console.log(`   Created bucket: ${bucket}`);
  }
}

async function restoreBucket(s3, bucket) {
  console.log(`\n── Bucket: ${bucket} ──`);

  const files = await listB2Files(s3, bucket, FILE_PREFIX);
  console.log(`   Found ${files.length} files in B2 backup`);

  if (DRY_RUN) {
    for (const f of files.slice(0, 20)) {
      console.log(`   [dry-run] ${f.storagePath} (${Math.round(f.size / 1024)} KB)`);
    }
    if (files.length > 20) console.log(`   ... and ${files.length - 20} more`);
    return { total: files.length, restored: 0, failed: 0 };
  }

  await ensureBucketExists(bucket);

  let restored = 0;
  let failed = 0;

  for (const file of files) {
    try {
      const data = await downloadFromB2(s3, file.b2Key);
      await uploadToSupabase(bucket, file.storagePath, data);
      restored++;
      if (restored % 50 === 0) {
        console.log(`   ... ${restored}/${files.length} restored`);
      }
    } catch (err) {
      failed++;
      console.warn(`   ⚠  Failed: ${file.storagePath} — ${err.message}`);
    }
  }

  return { total: files.length, restored, failed };
}

async function main() {
  console.log("═══════════════════════════════════════════════");
  console.log("  TWV CRM — Storage Restore");
  const targetBuckets = ONLY_BUCKET ? [ONLY_BUCKET] : STORAGE_BUCKETS;
  console.log(`  Buckets: ${targetBuckets.join(", ")}${DRY_RUN ? "  [DRY RUN]" : ""}`);
  if (FILE_PREFIX) console.log(`  Prefix filter: ${FILE_PREFIX}`);
  console.log("═══════════════════════════════════════════════\n");

  if (!DRY_RUN) {
    console.log("⚠  Files will be uploaded to NEXT_PUBLIC_SUPABASE_URL.");
    console.log("   Existing files with the same path will be OVERWRITTEN.");
    console.log("   Press Ctrl+C within 5 seconds to abort...\n");
    await new Promise((r) => setTimeout(r, 5000));
  }

  const s3 = getS3Client();
  const summary = {};

  for (const bucket of targetBuckets) {
    summary[bucket] = await restoreBucket(s3, bucket);
  }

  console.log("\n═══════════════════════════════════════════════");
  for (const [bucket, stats] of Object.entries(summary)) {
    const status = stats.failed === 0 ? "✓" : "⚠";
    console.log(`  ${status}  ${bucket}: ${stats.restored}/${stats.total} restored, ${stats.failed} failed`);
  }
  console.log("═══════════════════════════════════════════════\n");

  const totalFailed = Object.values(summary).reduce((s, r) => s + r.failed, 0);
  if (totalFailed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("\n❌  Fatal error:", err.message);
  process.exit(1);
});
