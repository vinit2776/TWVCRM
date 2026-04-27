import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { normalizeUploadServer, UploadValidationError } from "@/lib/uploads/normalize-upload-server";

const TICKET_EXTRA_MIME = new Set([
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
]);

// POST — upload screenshot for a ticket (any authenticated user)
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const adminSupabase = await createAdminClient();

  // Verify ticket exists
  const { data: ticket } = await adminSupabase
    .from("support_tickets")
    .select("id, status, attachments")
    .eq("id", id)
    .single();

  if (!ticket) {
    return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
  }

  const formData = await request.formData();
  const file = formData.get("file") as File | null;

  if (!file) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }

  // Check ticket is not closed
  if (ticket.status === "closed") {
    return NextResponse.json({ error: "Cannot add attachments to a closed ticket" }, { status: 400 });
  }

  // Normalize: images → JPEG 2048px, PDF pass-through, office docs pass-through, 50MB hard cap.
  let normalized;
  try {
    normalized = await normalizeUploadServer(file, { extraMimeTypes: TICKET_EXTRA_MIME });
  } catch (err) {
    if (err instanceof UploadValidationError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  const filePath = `support-screenshots/${id}-${Date.now()}.${normalized.ext}`;

  const { error: uploadError } = await adminSupabase.storage
    .from("crm-documents")
    .upload(filePath, normalized.buffer, { contentType: normalized.mimeType, upsert: true });

  if (uploadError) {
    return NextResponse.json(
      { error: `Upload failed: ${uploadError.message}` },
      { status: 500 }
    );
  }

  // Append to attachments array + keep legacy screenshot_path for backward compat
  const existingAttachments = (ticket as { attachments?: unknown[] }).attachments || [];
  const newAttachment = { path: filePath, name: file.name, uploaded_at: new Date().toISOString() };

  const newAttachments = [...existingAttachments, newAttachment];

  const { data: updatedRows, error: updateError } = await adminSupabase
    .from("support_tickets")
    .update({
      screenshot_path: filePath,
      attachments: newAttachments,
    })
    .eq("id", id)
    .select("*");

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  const updated = updatedRows?.[0] ?? null;
  return NextResponse.json({ data: updated });
}

export const maxDuration = 30;
