import { NextRequest, NextResponse } from "next/server";
import { Pool } from "pg";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { gzip } from "zlib";
import { promisify } from "util";
import { pingCronHealth } from "@/lib/cron-ping";
import { envStr } from "@/lib/env";

export const maxDuration = 300;

const gzipAsync = promisify(gzip);

// Every value below goes through envStr(). A trailing newline on
// BACKUP_DB_HOST in Vercel produced "getaddrinfo ENOTFOUND
// aws-1-ap-south-1.pooler.supabase.com\n" and stopped this backup dead on
// 2026-04-21; it stayed broken until 2026-08-16 because the health ping that
// should have reported it was itself failing silently.
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

function getPool() {
  return new Pool({
    host: envStr("BACKUP_DB_HOST"),
    port: parseInt(envStr("BACKUP_DB_PORT") || "5432"),
    user: envStr("BACKUP_DB_USER"),
    // Not trimmed: a password may legitimately contain leading/trailing spaces.
    password: process.env.BACKUP_DB_PASSWORD,
    database: envStr("BACKUP_DB_NAME") || "postgres",
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
    max: 2,
  });
}

export async function GET(request: NextRequest) {
  // Verify Vercel cron secret
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const pool = getPool();
  const s3 = getS3Client();
  const startedAt = Date.now();

  try {
    const client = await pool.connect();

    // Get all public tables
    const tablesRes = await client.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
    );
    const tables = tablesRes.rows.map((r) => r.tablename);

    // Dump each table as JSON rows
    const dump: Record<string, unknown[]> = {};
    for (const table of tables) {
      try {
        const res = await client.query(`SELECT * FROM public."${table}"`);
        dump[table] = res.rows;
      } catch {
        dump[table] = []; // skip tables with permission issues
      }
    }

    client.release();

    // Serialize and compress
    const json = JSON.stringify({ exported_at: new Date().toISOString(), tables: dump });
    const compressed = await gzipAsync(Buffer.from(json, "utf-8"));

    // Build file path: db/YYYY-MM-DD/twvcrm-db-TIMESTAMP.json.gz
    const now = new Date();
    const date = now.toISOString().split("T")[0];
    const timestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const key = `db/${date}/twvcrm-db-${timestamp}.json.gz`;

    // Upload to B2
    await s3.send(new PutObjectCommand({
      Bucket: envStr("B2_BUCKET") || "twvcrmbackups",
      Key: key,
      Body: compressed,
      ContentType: "application/gzip",
      ContentEncoding: "gzip",
      Metadata: {
        tables: tables.length.toString(),
        exported_at: now.toISOString(),
      },
    }));

    const durationMs = Date.now() - startedAt;
    const sizeKb = Math.round(compressed.length / 1024);

    console.log(`[db-backup] ✓ ${tables.length} tables, ${sizeKb} KB → ${key} (${durationMs}ms)`);
    await pingCronHealth("cron/db-backup", "ok", { tables: tables.length, size_kb: sizeKb, path: key });

    return NextResponse.json({
      ok: true,
      tables: tables.length,
      size_kb: sizeKb,
      path: key,
      duration_ms: durationMs,
    });
  } catch (err) {
    console.error("[db-backup] failed:", err);
    await pingCronHealth("cron/db-backup", "error", { error: String(err) });
    return NextResponse.json({ error: String(err) }, { status: 500 });
  } finally {
    await pool.end();
  }
}
