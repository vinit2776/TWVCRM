import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isInboxRole } from "@/lib/tally-handoff";

/**
 * GET /api/booking-gst-tasks/[id]/gst-invoice-pdf
 *
 * Streams the uploaded GST invoice PDF for a booking task.
 */
export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("role")
    .eq("auth_id", user.id)
    .maybeSingle();
  if (!dbUser || !isInboxRole(dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Fetch the latest non-superseded upload for this task
  const { data: upload } = await supabase
    .from("gst_invoice_uploads")
    .select("invoice_pdf_url, tally_invoice_number")
    .eq("booking_gst_task_id", id)
    .is("superseded_by", null)
    .order("uploaded_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!upload) return NextResponse.json({ error: "No invoice uploaded yet" }, { status: 404 });

  const { data: fileBlob, error } = await supabase.storage
    .from("crm-documents")
    .download(upload.invoice_pdf_url as string);

  if (error || !fileBlob) {
    return NextResponse.json({ error: "Could not retrieve PDF" }, { status: 500 });
  }

  const buf = Buffer.from(await fileBlob.arrayBuffer());
  const filename = `${(upload.tally_invoice_number as string).replace(/[^\w-]/g, "_")}.pdf`;

  return new NextResponse(buf, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${filename}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
