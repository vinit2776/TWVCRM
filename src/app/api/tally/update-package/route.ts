/**
 * Bridge self-update package endpoint.
 *
 * POST /api/tally/update-package  (admin session)
 *   Publish a new bridge release. Multipart form:
 *     file:    the bridge zip (must contain a dist/ folder)
 *     version: semver string, e.g. "1.3.13"
 *   Stores the zip in B2 (tally-bridge/<version>.zip), computes its SHA-256,
 *   and records tally_bridge_target_version + tally_bridge_update_sha256 in
 *   app_settings. The bridge picks it up on its next heartbeat (~60s) and
 *   self-updates between poll cycles.
 *
 * GET /api/tally/update-package  (Bearer TALLY_AGENT_TOKEN — bridge only)
 *   Streams the currently published zip. The bridge verifies the SHA-256
 *   from the heartbeat before applying.
 *
 * DELETE /api/tally/update-package  (admin session)
 *   Unpublish — clears the target version so no bridge attempts an update.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { createHash } from "crypto";
import { logAudit } from "@/lib/audit";

const B2_PREFIX = "tally-bridge";
const MAX_ZIP_BYTES = 20 * 1024 * 1024; // bridge zips are ~50KB; 20MB is a generous cap

function getS3Client() {
  // Same shape as the proven db-backup client: B2_ENDPOINT has no scheme,
  // and B2's S3-compatible API wants the bucket's real region.
  // Trim env values — a stray \n or \r in any of these makes the AWS SDK
  // emit an Authorization header with invalid characters and Node's
  // undici rejects it before the request even leaves the process.
  const endpoint = (process.env.B2_ENDPOINT ?? "").trim();
  const keyId = (process.env.B2_KEY_ID ?? "").trim();
  const appKey = (process.env.B2_APPLICATION_KEY ?? "").trim();
  return new S3Client({
    endpoint: `https://${endpoint}`,
    region: "us-east-005",
    credentials: {
      accessKeyId: keyId,
      secretAccessKey: appKey,
    },
  });
}

async function requireAdmin(supabase: Awaited<ReturnType<typeof createClient>>) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  return dbUser?.role === "admin" ? dbUser : null;
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const dbUser = await requireAdmin(supabase);
  if (!dbUser) return NextResponse.json({ error: "Admin access required" }, { status: 403 });

  let form: FormData;
  try { form = await request.formData(); }
  catch { return NextResponse.json({ error: "Expected multipart form data" }, { status: 400 }); }

  const file = form.get("file");
  const version = String(form.get("version") ?? "").trim();

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing 'file' (the bridge zip)" }, { status: 400 });
  }
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    return NextResponse.json({ error: "Missing or invalid 'version' (expected e.g. 1.3.13)" }, { status: 400 });
  }
  if (file.size > MAX_ZIP_BYTES) {
    return NextResponse.json({ error: `Zip too large (${file.size} bytes, max ${MAX_ZIP_BYTES})` }, { status: 400 });
  }

  const bytes = Buffer.from(await file.arrayBuffer());

  // Sanity: must be a zip (PK signature)
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    return NextResponse.json({ error: "File is not a zip archive" }, { status: 400 });
  }

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const key = `${B2_PREFIX}/twv-tally-bridge-v${version}.zip`;

  // Same bucket as db-backup — keeps B2 application-key scope consistent.
  const bucket = process.env.B2_BUCKET || "twvcrmbackups";
  try {
    await getS3Client().send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: bytes,
      ContentType: "application/zip",
    }));
  } catch (err) {
    console.error("[tally/update-package] B2 upload failed:", err);
    const detail = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Storage upload failed: ${detail}` }, { status: 502 });
  }

  const admin = createAdminClient();
  const settings = [
    { key: "tally_bridge_target_version", value: version },
    { key: "tally_bridge_update_sha256", value: sha256 },
    { key: "tally_bridge_update_key", value: key },
    { key: "tally_bridge_update_published_at", value: new Date().toISOString() },
  ];
  for (const s of settings) {
    await admin.from("app_settings").upsert(s, { onConflict: "key" });
  }

  void logAudit(admin, {
    entityType: "billing_statement" as never, // closest existing entity bucket for tally ops
    entityId: version,
    action: "update" as never,
    performedBy: dbUser.id,
    changes: { bridge_update_published: { old: null, new: `v${version} (${sha256.slice(0, 12)}…)` } },
  });

  return NextResponse.json({ ok: true, version, sha256, key, size: bytes.length });
}

export async function GET(request: NextRequest) {
  // Bridge auth — same token as /pending and /ack
  if (request.headers.get("authorization") !== `Bearer ${process.env.TALLY_AGENT_TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const { data: settings } = await admin
    .from("app_settings")
    .select("key, value")
    .in("key", ["tally_bridge_update_key", "tally_bridge_target_version"]);

  const map = Object.fromEntries((settings ?? []).map((s: { key: string; value: string }) => [s.key, s.value]));
  const key = map["tally_bridge_update_key"];
  if (!key) return NextResponse.json({ error: "No update published" }, { status: 404 });

  try {
    const obj = await getS3Client().send(new GetObjectCommand({
      Bucket: process.env.B2_BUCKET || "twvcrmbackups",
      Key: key,
    }));
    const bytes = Buffer.from(await obj.Body!.transformToByteArray());
    return new NextResponse(bytes, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Length": String(bytes.length),
        "x-bridge-version": map["tally_bridge_target_version"] ?? "",
      },
    });
  } catch (err) {
    console.error("[tally/update-package] B2 download failed:", err);
    return NextResponse.json({ error: "Storage download failed" }, { status: 502 });
  }
}

export async function DELETE(request: NextRequest) {
  void request;
  const supabase = await createClient();
  const dbUser = await requireAdmin(supabase);
  if (!dbUser) return NextResponse.json({ error: "Admin access required" }, { status: 403 });

  const admin = createAdminClient();
  for (const key of ["tally_bridge_target_version", "tally_bridge_update_sha256", "tally_bridge_update_key"]) {
    await admin.from("app_settings").delete().eq("key", key);
  }
  return NextResponse.json({ ok: true });
}
