import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import {
  normalizeUploadServer,
  UploadValidationError,
  IMAGE_MIME_TYPES,
  PDF_MIME_TYPE,
} from "@/lib/uploads/normalize-upload-server";

export const dynamic = "force-dynamic";

/**
 * GET /api/leads/[id]/id-proof
 * Returns a short-lived signed URL for the lead's KYC id_proof document.
 * Used by the Tally Inbox to let accounts view the KYC before issuing a GST invoice.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const adminSupabase = createAdminClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: lead } = await supabase
    .from("leads")
    .select("id, id_proof_path")
    .eq("id", id)
    .maybeSingle();

  if (!lead) return NextResponse.json({ error: "Lead not found" }, { status: 404 });
  if (!lead.id_proof_path) return NextResponse.json({ error: "No KYC document uploaded" }, { status: 404 });

  const { data: signed, error: signErr } = await adminSupabase.storage
    .from("crm-documents")
    .createSignedUrl(lead.id_proof_path as string, 3600);

  if (signErr || !signed?.signedUrl) {
    return NextResponse.json({ error: "Could not generate download URL" }, { status: 500 });
  }

  // Redirect directly to the signed URL so the browser opens the file inline
  return NextResponse.redirect(signed.signedUrl);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const adminSupabase = await createAdminClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const formData = await request.formData();
  const file = formData.get("file") as File | null;
  if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 });

  if (!IMAGE_MIME_TYPES.has(file.type) && file.type !== PDF_MIME_TYPE) {
    return NextResponse.json(
      { error: "Only JPG, PNG, WebP, HEIC, or PDF files are accepted." },
      { status: 400 }
    );
  }

  let normalized;
  try {
    normalized = await normalizeUploadServer(file);
  } catch (err) {
    if (err instanceof UploadValidationError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  const filePath = `leads/${id}/id_proof_${Date.now()}.${normalized.ext}`;

  const { error: uploadError } = await adminSupabase.storage
    .from("crm-documents")
    .upload(filePath, normalized.buffer, {
      contentType: normalized.mimeType,
      upsert: true,
    });

  if (uploadError) {
    return NextResponse.json({ error: uploadError.message }, { status: 500 });
  }

  const { data, error } = await supabase
    .from("leads")
    .update({ id_proof_path: filePath, id_proof_uploaded_at: new Date().toISOString() })
    .eq("id", id)
    .select("id, id_proof_path, id_proof_uploaded_at")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ data });
}
