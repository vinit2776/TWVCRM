import { NextRequest, NextResponse } from "next/server";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { pingCronHealth } from "@/lib/cron-ping";

export const maxDuration = 300;

const BUCKETS = ["crm-documents", "vendor-invoices"];

function getS3Client() {
  return new S3Client({
    endpoint: `https://${process.env.B2_ENDPOINT}`,
    region: "us-east-005",
    credentials: {
      accessKeyId: process.env.B2_KEY_ID!,
      secretAccessKey: process.env.B2_APPLICATION_KEY!,
    },
  });
}

async function listBucketFiles(bucket: string, prefix = "", limit = 1000): Promise<string[]> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

  const res = await fetch(`${supabaseUrl}/storage/v1/object/list/${bucket}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prefix, limit, offset: 0 }),
  });

  if (!res.ok) return [];
  const items = await res.json() as Array<{ name: string; id?: string }>;
  return items
    .filter((i) => i.name && !i.name.endsWith("/") && i.id) // files only, not folders
    .map((i) => i.name);
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

  for (const bucket of BUCKETS) {
    const files = await listBucketFiles(bucket);
    let synced = 0;
    let failed = 0;

    for (const file of files) {
      const data = await downloadFile(bucket, file);
      if (!data) { failed++; continue; }

      try {
        await s3.send(new PutObjectCommand({
          Bucket: process.env.B2_BUCKET || "twvcrmbackups",
          Key: `storage/${bucket}/${file}`,
          Body: data,
        }));
        synced++;
      } catch {
        failed++;
      }
    }

    results[bucket] = { synced, failed };
    console.log(`[storage-backup] ${bucket}: ${synced} synced, ${failed} failed`);
  }

  const total = Object.values(results).reduce((s, r) => s + r.synced, 0);
  const durationMs = Date.now() - startedAt;

  console.log(`[storage-backup] ✓ ${total} files total (${durationMs}ms)`);
  await pingCronHealth("cron/storage-backup", "ok", { results, total_synced: total });

  return NextResponse.json({ ok: true, results, total_synced: total, duration_ms: durationMs });
}
