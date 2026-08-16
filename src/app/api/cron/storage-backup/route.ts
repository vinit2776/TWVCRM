import { NextRequest, NextResponse } from "next/server";
import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  type ListObjectsV2CommandOutput,
} from "@aws-sdk/client-s3";
import { pingCronHealth } from "@/lib/cron-ping";
import { envStr } from "@/lib/env";

export const maxDuration = 300;

// Stop starting new uploads with ~45s left so the handler can finish its
// in-flight write, ping health, and return. Anything not reached is left for
// the next run, which skips whatever already landed.
const TIME_BUDGET_MS = (maxDuration - 45) * 1000;

const BUCKETS = ["crm-documents", "vendor-invoices"];

function getS3Client() {
  return new S3Client({
    endpoint: `https://${envStr("B2_ENDPOINT")}`,
    region: "us-east-005",
    credentials: {
      accessKeyId: envStr("B2_KEY_ID")!,
      secretAccessKey: envStr("B2_APPLICATION_KEY")!,
    },
  });
}

/**
 * Recursively list every file in a Supabase Storage bucket.
 *
 * Supabase's list API is one level deep: a folder comes back as an entry with
 * a null id, and its contents only appear if you list that prefix explicitly.
 * The previous version filtered folders out and never recursed, so it only ever
 * saw files sitting at the bucket root. vendor-invoices is flat, so it worked;
 * crm-documents keeps everything in 18 folders, so this returned an empty list
 * and the job reported "0 synced, 0 failed, ok" while backing up nothing.
 * 1,189 files / 1.77 GB — contracts, GST invoices, proformas — were never
 * copied. Backfilled manually on 2026-08-16; this makes the cron keep up.
 *
 * Depth is bounded to stop a pathological or cyclic prefix from looping.
 */
async function listBucketFiles(
  bucket: string,
  prefix = "",
  depth = 0
): Promise<string[]> {
  const MAX_DEPTH = 10;
  if (depth > MAX_DEPTH) {
    console.warn(`[storage-backup] max depth reached at ${bucket}/${prefix}`);
    return [];
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const PAGE_SIZE = 1000;
  const allFiles: string[] = [];
  const folders: string[] = [];
  let offset = 0;

  while (true) {
    const res = await fetch(`${supabaseUrl}/storage/v1/object/list/${bucket}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ prefix, limit: PAGE_SIZE, offset }),
    });

    if (!res.ok) {
      console.error(`[storage-backup] list ${bucket}/${prefix} failed: HTTP ${res.status}`);
      break;
    }
    const items = await res.json() as Array<{ name: string; id?: string | null }>;

    for (const item of items) {
      if (!item.name || item.name.endsWith("/")) continue;
      const path = prefix ? `${prefix}/${item.name}` : item.name;
      // A null/absent id marks a folder placeholder rather than an object.
      if (item.id) allFiles.push(path);
      else folders.push(path);
    }

    // If we got fewer than a full page, we've reached the end
    if (items.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  for (const folder of folders) {
    allFiles.push(...(await listBucketFiles(bucket, folder, depth + 1)));
  }

  return allFiles;
}

/**
 * Keys already present under a prefix in B2, so a run can skip what it has
 * already copied. Without this the job would re-upload ~1.9 GB every night and
 * exceed maxDuration; with it, a steady-state run only moves new files.
 */
async function existingKeys(s3: S3Client, prefix: string): Promise<Set<string>> {
  const keys = new Set<string>();
  let token: string | undefined;

  do {
    const res: ListObjectsV2CommandOutput = await s3.send(new ListObjectsV2Command({
      Bucket: envStr("B2_BUCKET") || "twvcrmbackups",
      Prefix: prefix,
      ContinuationToken: token,
    }));
    for (const obj of res.Contents ?? []) {
      if (obj.Key) keys.add(obj.Key);
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);

  return keys;
}

async function downloadFile(bucket: string, path: string): Promise<Buffer | null> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

  const res = await fetch(
    `${supabaseUrl}/storage/v1/object/authenticated/${bucket}/${path}`,
    { headers: { Authorization: `Bearer ${serviceKey}` } }
  );

  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const s3 = getS3Client();
  const startedAt = Date.now();
  const results: Record<string, { synced: number; skipped: number; failed: number; remaining: number }> = {};
  // First failure reason per bucket. The previous version swallowed the error
  // entirely, so a run that failed all 24 vendor invoices still reported "ok"
  // with no clue why.
  const firstError: Record<string, string> = {};

  for (const bucket of BUCKETS) {
    const files = await listBucketFiles(bucket);
    const alreadyCopied = await existingKeys(s3, `storage/${bucket}/`);
    const pending = files.filter((f) => !alreadyCopied.has(`storage/${bucket}/${f}`));

    let synced = 0;
    let failed = 0;

    for (const file of pending) {
      // Leave headroom under maxDuration so a large first run makes partial
      // progress and is picked up next time, rather than being killed mid-upload
      // and starting from zero every night.
      if (Date.now() - startedAt > TIME_BUDGET_MS) {
        console.warn(`[storage-backup] ${bucket}: time budget hit, ${pending.length - synced - failed} left for next run`);
        break;
      }

      const data = await downloadFile(bucket, file);
      if (!data) {
        failed++;
        firstError[bucket] ??= "download from Supabase Storage returned no body";
        continue;
      }

      try {
        await s3.send(new PutObjectCommand({
          Bucket: envStr("B2_BUCKET") || "twvcrmbackups",
          Key: `storage/${bucket}/${file}`,
          Body: data,
        }));
        synced++;
      } catch (err) {
        failed++;
        firstError[bucket] ??= String(err).slice(0, 200);
      }
    }

    const remaining = pending.length - synced - failed;
    results[bucket] = { synced, skipped: files.length - pending.length, failed, remaining };
    console.log(
      `[storage-backup] ${bucket}: ${files.length} found, ${results[bucket].skipped} already copied, ${synced} synced, ${failed} failed, ${remaining} deferred`
    );
    if (failed > 0) {
      console.error(`[storage-backup] ${bucket} first failure: ${firstError[bucket]}`);
    }
  }

  const total = Object.values(results).reduce((s, r) => s + r.synced, 0);
  const totalFailed = Object.values(results).reduce((s, r) => s + r.failed, 0);
  const totalRemaining = Object.values(results).reduce((s, r) => s + r.remaining, 0);
  const durationMs = Date.now() - startedAt;

  console.log(
    `[storage-backup] ${totalFailed ? "✗" : "✓"} ${total} synced, ${totalFailed} failed, ${totalRemaining} deferred (${durationMs}ms)`
  );

  // Report the real outcome. Hardcoding "ok" here is why 24 consecutive upload
  // failures on 2026-04-21 looked like a healthy run. Deferred work is not a
  // failure — the next run picks it up — so it is reported without flipping
  // status, but it is always visible in details rather than silently dropped.
  await pingCronHealth("cron/storage-backup", totalFailed > 0 ? "error" : "ok", {
    results,
    total_synced: total,
    total_failed: totalFailed,
    total_remaining: totalRemaining,
    ...(totalFailed > 0 ? { first_error: firstError } : {}),
  });

  return NextResponse.json({
    ok: totalFailed === 0,
    results,
    total_synced: total,
    total_remaining: totalRemaining,
    total_failed: totalFailed,
    duration_ms: durationMs,
  });
}
