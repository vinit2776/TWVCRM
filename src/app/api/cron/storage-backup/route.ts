import { NextRequest, NextResponse } from "next/server";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { pingCronHealth } from "@/lib/cron-ping";
import { envStr } from "@/lib/env";

export const maxDuration = 300;

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
 * Paginate through all files in a Supabase Storage bucket.
 * The API returns max 1000 items per page — this loops until exhausted.
 */
async function listBucketFiles(bucket: string, prefix = ""): Promise<string[]> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const PAGE_SIZE = 1000;
  const allFiles: string[] = [];
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

    if (!res.ok) break;
    const items = await res.json() as Array<{ name: string; id?: string }>;
    const files = items
      .filter((i) => i.name && !i.name.endsWith("/") && i.id) // files only, not folders
      .map((i) => i.name);

    allFiles.push(...files);

    // If we got fewer than a full page, we've reached the end
    if (items.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return allFiles;
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
  const results: Record<string, { synced: number; failed: number }> = {};
  // First failure reason per bucket. The previous version swallowed the error
  // entirely, so a run that failed all 24 vendor invoices still reported "ok"
  // with no clue why.
  const firstError: Record<string, string> = {};

  for (const bucket of BUCKETS) {
    const files = await listBucketFiles(bucket);
    let synced = 0;
    let failed = 0;

    for (const file of files) {
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

    results[bucket] = { synced, failed };
    console.log(`[storage-backup] ${bucket}: ${synced} synced, ${failed} failed`);
    if (failed > 0) {
      console.error(`[storage-backup] ${bucket} first failure: ${firstError[bucket]}`);
    }
  }

  const total = Object.values(results).reduce((s, r) => s + r.synced, 0);
  const totalFailed = Object.values(results).reduce((s, r) => s + r.failed, 0);
  const durationMs = Date.now() - startedAt;

  console.log(`[storage-backup] ${totalFailed ? "✗" : "✓"} ${total} synced, ${totalFailed} failed (${durationMs}ms)`);

  // Report the real outcome. Hardcoding "ok" here is why 24 consecutive upload
  // failures on 2026-04-21 looked like a healthy run.
  await pingCronHealth("cron/storage-backup", totalFailed > 0 ? "error" : "ok", {
    results,
    total_synced: total,
    total_failed: totalFailed,
    ...(totalFailed > 0 ? { first_error: firstError } : {}),
  });

  return NextResponse.json({
    ok: totalFailed === 0,
    results,
    total_synced: total,
    total_failed: totalFailed,
    duration_ms: durationMs,
  });
}
