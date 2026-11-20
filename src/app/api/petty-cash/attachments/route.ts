import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { z } from "zod";
import { logAudit } from "@/lib/audit";
import { normalizeUploadServer, UploadValidationError } from "@/lib/uploads/normalize-upload-server";
import {
  PC_ATTACHMENT_KINDS,
  PC_ATTACHMENT_MAX_BYTES,
  PC_ATTACHMENT_MAX_FILES,
  canAddToEntry,
  canAddToRequest,
  safeFileName,
} from "@/lib/petty-cash-attachments";

const BUCKET = "crm-documents";
const SIGNED_URL_SECONDS = 3600;

const targetSchema = z.object({
  entry_id: z.string().uuid().optional(),
  request_id: z.string().uuid().optional(),
}).refine((v) => !!v.entry_id !== !!v.request_id, "Give exactly one of entry_id or request_id");

async function currentUser() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) } as const;
  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return { error: NextResponse.json({ error: "User not found" }, { status: 403 }) } as const;
  return { supabase, dbUser } as const;
}

/**
 * GET /api/petty-cash/attachments?entry_id=… | ?request_id=…
 * Lists the files on one expense or request with short-lived signed links.
 * Management sees any; everyone else only their own expense / request.
 */
export async function GET(request: NextRequest) {
  const ctx = await currentUser();
  if ("error" in ctx) return ctx.error;
  const { supabase, dbUser } = ctx;

  const parsed = targetSchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  const { entry_id, request_id } = parsed.data;

  const canViewAll = ["admin", "manager", "accounts"].includes(dbUser.role);
  if (!canViewAll) {
    const owned = entry_id
      ? await supabase.from("petty_cash_entries").select("id").eq("id", entry_id).eq("submitted_by", dbUser.id).maybeSingle()
      : await supabase.from("petty_cash_requests").select("id").eq("id", request_id!).eq("created_by", dbUser.id).maybeSingle();
    if (!owned.data) return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  }

  let q = supabase
    .from("petty_cash_attachments")
    .select("id, kind, file_name, mime_type, size_bytes, uploaded_by, created_at, storage_path, uploader:users!petty_cash_attachments_uploaded_by_fkey(full_name)")
    .order("created_at", { ascending: true });
  q = entry_id ? q.eq("entry_id", entry_id) : q.eq("request_id", request_id!);
  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const admin = createAdminClient();
  const files = await Promise.all((data ?? []).map(async (a) => {
    const { data: signed } = await admin.storage.from(BUCKET).createSignedUrl(a.storage_path, SIGNED_URL_SECONDS);
    const uploader = Array.isArray(a.uploader) ? a.uploader[0] : a.uploader;
    return {
      id: a.id, kind: a.kind, file_name: a.file_name, mime_type: a.mime_type, size_bytes: a.size_bytes,
      uploaded_by: a.uploaded_by, uploaded_by_name: uploader?.full_name ?? null, created_at: a.created_at,
      url: signed?.signedUrl ?? null,
    };
  }));
  return NextResponse.json({ data: files });
}

/**
 * POST /api/petty-cash/attachments (multipart: file, kind, entry_id | request_id)
 * Optional bills / proof of payment. Never required by any approval step.
 */
export async function POST(request: NextRequest) {
  const ctx = await currentUser();
  if ("error" in ctx) return ctx.error;
  const { supabase, dbUser } = ctx;

  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "No file provided" }, { status: 400 });

  const target = targetSchema.safeParse({
    entry_id: (form.get("entry_id") as string) || undefined,
    request_id: (form.get("request_id") as string) || undefined,
  });
  if (!target.success) return NextResponse.json({ error: target.error.issues[0].message }, { status: 400 });
  const { entry_id, request_id } = target.data;

  const defaultKind = entry_id ? "receipt" : "payment_proof";
  const kind = z.enum(PC_ATTACHMENT_KINDS).safeParse((form.get("kind") as string) || defaultKind);
  if (!kind.success) return NextResponse.json({ error: "Invalid kind" }, { status: 400 });

  if (entry_id) {
    const { data: entry } = await supabase
      .from("petty_cash_entries").select("id, submitted_by, status").eq("id", entry_id).single();
    if (!entry) return NextResponse.json({ error: "Expense not found" }, { status: 404 });
    if (!canAddToEntry(dbUser.role, dbUser.id, entry)) {
      return NextResponse.json({
        error: entry.status === "approved"
          ? "This expense is already approved. Ask Accounts to add the bill."
          : "Only the person who logged this expense can add a bill to it.",
      }, { status: 403 });
    }
  } else {
    const { data: req } = await supabase.from("petty_cash_requests").select("id").eq("id", request_id!).single();
    if (!req) return NextResponse.json({ error: "Request not found" }, { status: 404 });
    if (!canAddToRequest(dbUser.role)) {
      return NextResponse.json({ error: "Only Accounts or Admin can attach proof of payment." }, { status: 403 });
    }
  }

  const admin = createAdminClient();
  const countQ = admin.from("petty_cash_attachments").select("id", { count: "exact", head: true });
  const { count } = await (entry_id ? countQ.eq("entry_id", entry_id) : countQ.eq("request_id", request_id!));
  if ((count ?? 0) >= PC_ATTACHMENT_MAX_FILES) {
    return NextResponse.json({ error: `You can attach up to ${PC_ATTACHMENT_MAX_FILES} files. Remove one first.` }, { status: 400 });
  }

  let normalized;
  try {
    normalized = await normalizeUploadServer(file, { maxBytes: PC_ATTACHMENT_MAX_BYTES });
  } catch (err) {
    if (err instanceof UploadValidationError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }

  const base = safeFileName(file.name).replace(/\.[^.]*$/, "");
  const path = `petty-cash/${entry_id ? "entry" : "request"}/${entry_id ?? request_id}/${Date.now()}-${base}.${normalized.ext}`;

  const { error: uploadError } = await admin.storage
    .from(BUCKET)
    .upload(path, normalized.buffer, { contentType: normalized.mimeType, upsert: false });
  if (uploadError) return NextResponse.json({ error: `Upload failed: ${uploadError.message}` }, { status: 500 });

  const { data: row, error } = await admin
    .from("petty_cash_attachments")
    .insert({
      entry_id: entry_id ?? null,
      request_id: request_id ?? null,
      kind: kind.data,
      storage_path: path,
      file_name: `${base}.${normalized.ext}`,
      mime_type: normalized.mimeType,
      size_bytes: normalized.finalBytes,
      uploaded_by: dbUser.id,
    })
    .select("id, kind, file_name, mime_type, size_bytes, created_at")
    .single();
  if (error) {
    await admin.storage.from(BUCKET).remove([path]); // don't leave an orphan file behind
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  logAudit(supabase, {
    entityType: entry_id ? "pc_entry" : "pc_request",
    entityId: (entry_id ?? request_id)!,
    action: "update",
    performedBy: dbUser.id,
    changes: { attachment_added: { old: null, new: row.file_name } },
  });

  return NextResponse.json({ data: row }, { status: 201 });
}

