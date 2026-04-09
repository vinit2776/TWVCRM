import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

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

  // Validate file type (images and common document types)
  const allowedTypes = ["image/", "application/pdf", "application/msword", "application/vnd.openxmlformats"];
  if (!allowedTypes.some((t) => file.type.startsWith(t))) {
    return NextResponse.json(
      { error: "Only images, PDFs, and documents are allowed" },
      { status: 400 }
    );
  }

  // Validate file size (10MB max)
  if (file.size > 10 * 1024 * 1024) {
    return NextResponse.json(
      { error: "File size must be under 10MB" },
      { status: 400 }
    );
  }

  // Check ticket is not closed
  if (ticket.status === "closed") {
    return NextResponse.json({ error: "Cannot add attachments to a closed ticket" }, { status: 400 });
  }

  // Upload to Supabase storage
  const ext = file.name.split(".").pop() || "png";
  const filePath = `support-screenshots/${id}-${Date.now()}.${ext}`;

  // Convert File to Buffer for reliable server-side upload
  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const { error: uploadError } = await adminSupabase.storage
    .from("crm-documents")
    .upload(filePath, buffer, { contentType: file.type, upsert: true });

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
